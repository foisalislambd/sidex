package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
)

// reviewRequest is the body for POST /v1/review.
//
// The review is computed server-side because the server already runs on the
// user's machine next to the repository (it executes shell tools for the
// agent), so it can read the working-tree diff without the webview needing a
// second, differently-privileged path into the filesystem.
type reviewRequest struct {
	Cwd          string `json:"cwd"`
	Base         string `json:"base,omitempty"` // git ref to diff against; empty = working tree
	Instructions string `json:"instructions,omitempty"`
	Model        string `json:"model,omitempty"`
	MaxDiffBytes int    `json:"max_diff_bytes,omitempty"`
	Staged       *bool  `json:"staged,omitempty"`
	// Format selects the response shape: "markdown" (default) streams prose,
	// "findings" asks for a structured JSON finding list so the UI can render
	// per-finding cards with go-to/fix/dismiss actions (Bugbot-style triage).
	Format string `json:"format,omitempty"`
}

// reviewFinding is one actionable problem found in the diff.
type reviewFinding struct {
	Severity   string `json:"severity"` // critical | major | minor | nit
	File       string `json:"file"`
	Line       int    `json:"line"`
	EndLine    int    `json:"end_line,omitempty"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	Suggestion string `json:"suggestion,omitempty"`
}

// reviewFindingsPayload is the strict JSON shape requested in findings mode.
type reviewFindingsPayload struct {
	Summary  string          `json:"summary"`
	Findings []reviewFinding `json:"findings"`
}

const (
	reviewDefaultMaxDiffBytes = 180_000
	reviewMaxDiffBytes        = 1_000_000
	reviewMaxFiles            = 60
	reviewGitTimeout          = 30 * time.Second
)

// safeGitRef rejects anything that could be read as a git option or shell-ish
// payload. The ref is passed as a single argv element (so there is no shell to
// inject into), but a leading "-" would still be parsed as a flag.
var safeGitRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/@^~:{}-]*$`)

// Review handles POST /v1/review: collect the pending diff, then stream a
// review of it as server-sent events.
func (h *Handler) Review(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req reviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Cwd) == "" {
		writeJSONError(w, http.StatusBadRequest, "cwd is required")
		return
	}
	if !filepath.IsAbs(req.Cwd) {
		writeJSONError(w, http.StatusBadRequest, "cwd must be an absolute path")
		return
	}
	if info, err := os.Stat(req.Cwd); err != nil || !info.IsDir() {
		writeJSONError(w, http.StatusBadRequest, "cwd is not a directory")
		return
	}
	if req.Base != "" && !safeGitRef.MatchString(req.Base) {
		writeJSONError(w, http.StatusBadRequest, "base must be a plain git ref")
		return
	}

	maxDiff := req.MaxDiffBytes
	if maxDiff <= 0 {
		maxDiff = reviewDefaultMaxDiffBytes
	}
	if maxDiff > reviewMaxDiffBytes {
		maxDiff = reviewMaxDiffBytes
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "streaming not supported")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	diff, stats, err := collectReviewDiff(r.Context(), req, maxDiff)
	if err != nil {
		sendSSE(w, flusher, map[string]any{"type": "error", "error": err.Error()})
		return
	}
	if strings.TrimSpace(diff) == "" {
		sendSSE(w, flusher, map[string]any{
			"type":  "error",
			"error": "nothing to review: the working tree has no changes against " + describeBase(req),
		})
		return
	}

	sendSSE(w, flusher, map[string]any{
		"type":      "diff_stats",
		"files":     stats.files,
		"added":     stats.added,
		"removed":   stats.removed,
		"bytes":     len(diff),
		"truncated": stats.truncated,
	})

	structured := strings.EqualFold(strings.TrimSpace(req.Format), "findings")
	prompt := buildReviewPrompt(diff, req)
	if structured {
		prompt = buildFindingsPrompt(diff, req)
	}

	client := h.clientFor(req.Model, auth.UserIDFromContext(r.Context()))

	if !structured {
		err = client.StreamChat([]ai.Message{{Role: ai.RoleUser, Content: prompt}}, nil, "", func(chunk ai.StreamChunk) {
			switch chunk.Type {
			case "text":
				sendSSE(w, flusher, map[string]any{"type": "text", "content": chunk.Content})
			case "error":
				sendSSE(w, flusher, map[string]any{"type": "error", "error": chunk.Error})
			}
		})
		if err != nil {
			sendSSE(w, flusher, map[string]any{"type": "error", "error": err.Error()})
			return
		}

		sendSSE(w, flusher, map[string]any{"type": "done"})
		return
	}

	// Structured mode: the model streams JSON, so buffer it and emit one
	// `finding` event per item at the end. Streaming raw JSON would flicker the
	// UI without giving it anything actionable.
	var buf strings.Builder
	var streamErr string
	err = client.StreamChat([]ai.Message{{Role: ai.RoleUser, Content: prompt}}, nil, "", func(chunk ai.StreamChunk) {
		switch chunk.Type {
		case "text":
			buf.WriteString(chunk.Content)
		case "error":
			streamErr = chunk.Error
		}
	})
	if err != nil {
		sendSSE(w, flusher, map[string]any{"type": "error", "error": err.Error()})
		return
	}
	if streamErr != "" {
		sendSSE(w, flusher, map[string]any{"type": "error", "error": streamErr})
		return
	}

	payload, parseErr := parseReviewFindings(buf.String())
	if parseErr != nil {
		// Fall back to prose so the user still sees the review instead of a
		// parse error: the model answered, just not in the shape we asked for.
		sendSSE(w, flusher, map[string]any{"type": "text", "content": strings.TrimSpace(buf.String())})
		sendSSE(w, flusher, map[string]any{"type": "done"})
		return
	}

	if s := strings.TrimSpace(payload.Summary); s != "" {
		sendSSE(w, flusher, map[string]any{"type": "summary", "content": s})
	}
	for _, f := range payload.Findings {
		sendSSE(w, flusher, map[string]any{"type": "finding", "finding": f})
	}
	sendSSE(w, flusher, map[string]any{"type": "done", "count": len(payload.Findings)})
}

// parseReviewFindings extracts the JSON object from a model response that may
// be wrapped in prose or markdown fences, and normalises the fields the UI
// depends on (severity vocabulary, line bounds, path separators).
func parseReviewFindings(raw string) (reviewFindingsPayload, error) {
	var payload reviewFindingsPayload

	text := strings.TrimSpace(raw)
	if i := strings.Index(text, "```"); i >= 0 {
		rest := text[i+3:]
		rest = strings.TrimPrefix(rest, "json")
		if j := strings.Index(rest, "```"); j >= 0 {
			text = rest[:j]
		}
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return payload, fmt.Errorf("no JSON object in review response")
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &payload); err != nil {
		return payload, fmt.Errorf("invalid review JSON: %w", err)
	}

	for i := range payload.Findings {
		f := &payload.Findings[i]
		f.Severity = normalizeSeverity(f.Severity)
		f.File = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(f.File), "./"))
		if f.Line < 1 {
			f.Line = 1
		}
		if f.EndLine < f.Line {
			f.EndLine = 0
		}
		f.Title = strings.TrimSpace(f.Title)
		if f.Title == "" {
			f.Title = "Finding"
		}
	}
	return payload, nil
}

func normalizeSeverity(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "critical", "blocker", "high", "error":
		return "critical"
	case "major", "medium", "warning", "warn":
		return "major"
	case "minor", "low", "info":
		return "minor"
	case "nit", "style", "suggestion":
		return "nit"
	default:
		return "minor"
	}
}

type diffStats struct {
	files     int
	added     int
	removed   int
	truncated bool
}

func describeBase(req reviewRequest) string {
	if req.Base == "" {
		return "HEAD"
	}
	return req.Base
}

// collectReviewDiff gathers the unified diff for the pending changes, capped at
// maxBytes. Staged and unstaged changes are merged into one review so a user
// who staged half their work still sees the whole pending change set.
func collectReviewDiff(ctx context.Context, req reviewRequest, maxBytes int) (string, diffStats, error) {
	stats := diffStats{}

	var sections []string

	// Untracked files never appear in `git diff`; list them so the reviewer can
	// at least say "new files were added" rather than silently ignoring them.
	if untracked, err := runGit(ctx, req.Cwd, "ls-files", "--others", "--exclude-standard"); err == nil {
		names := nonEmptyLines(untracked)
		if len(names) > 0 {
			if len(names) > reviewMaxFiles {
				names = names[:reviewMaxFiles]
				stats.truncated = true
			}
			var sb strings.Builder
			sb.WriteString("# Untracked files (contents not shown)\n")
			for _, n := range names {
				sb.WriteString("?? ")
				sb.WriteString(n)
				sb.WriteString("\n")
			}
			sections = append(sections, sb.String())
		}
	}

	stagedOnly := req.Staged != nil && *req.Staged

	if !stagedOnly {
		args := []string{"diff", "--no-color", "--unified=3", "--no-ext-diff"}
		if req.Base != "" {
			args = append(args, req.Base)
		}
		if out, err := runGit(ctx, req.Cwd, args...); err == nil && out != "" {
			sections = append(sections, out)
		}
	}

	if stagedOnly || req.Base == "" {
		if out, err := runGit(ctx, req.Cwd, "diff", "--cached", "--no-color", "--unified=3", "--no-ext-diff"); err == nil && out != "" {
			sections = append(sections, out)
		}
	}

	diff := strings.Join(sections, "\n")

	for _, line := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---"):
			continue
		case strings.HasPrefix(line, "+"):
			stats.added++
		case strings.HasPrefix(line, "-"):
			stats.removed++
		}
	}
	stats.files = countFiles(diff)

	if len(diff) > maxBytes {
		diff = diff[:maxBytes] + "\n\n…[diff truncated: the review below covers only the visible part]\n"
		stats.truncated = true
	}

	return diff, stats, nil
}

// countFiles counts the distinct files named in diff headers.
func countFiles(diff string) int {
	seen := map[string]struct{}{}
	for _, line := range strings.Split(diff, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			seen[line] = struct{}{}
		}
	}
	return len(seen)
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}

// runGit runs git in dir and returns stdout. stderr is folded into the error so
// a caller can surface "not a git repository" instead of an empty diff.
func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, reviewGitTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_PAGER=cat")
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(ee.Stderr)))
		}
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return string(out), nil
}

func buildReviewPrompt(diff string, req reviewRequest) string {
	var sb strings.Builder
	sb.WriteString("You are reviewing a code change before it is committed, the way a careful senior engineer reviews a pull request.\n\n")
	sb.WriteString("Ground rules:\n")
	sb.WriteString("- Only report issues you can point at in the diff. Cite them as `path:line`.\n")
	sb.WriteString("- Rank findings by severity: **Critical** (data loss, security, crash), **Major** (wrong behaviour), **Minor** (edge cases, maintainability), **Nit** (style, naming).\n")
	sb.WriteString("- If the change looks correct, say so plainly and stop. Do not invent problems to fill space.\n")
	sb.WriteString("- Check for: logic errors, unhandled error paths, resource leaks, concurrency hazards, injection and path-traversal risks, missing input validation, broken API contracts, off-by-one errors, and tests that should exist but do not.\n")
	sb.WriteString("- Output GitHub-flavoured Markdown. No preamble, no summary of what the diff does beyond one short sentence.\n\n")
	if ins := strings.TrimSpace(req.Instructions); ins != "" {
		sb.WriteString("Reviewer focus requested by the user: ")
		sb.WriteString(ins)
		sb.WriteString("\n\n")
	}
	sb.WriteString("Diff:\n```diff\n")
	sb.WriteString(diff)
	sb.WriteString("\n```\n")
	return sb.String()
}

func buildFindingsPrompt(diff string, req reviewRequest) string {
	var sb strings.Builder
	sb.WriteString("You are reviewing a code change before it is committed, the way a careful senior engineer reviews a pull request.\n\n")
	sb.WriteString("Ground rules:\n")
	sb.WriteString("- Only report issues you can point at in the diff.\n")
	sb.WriteString("- severity must be exactly one of: critical, major, minor, nit.\n")
	sb.WriteString("- file is the repository-relative path from the diff (strip a/ or b/ prefixes).\n")
	sb.WriteString("- line is the 1-based line number in the NEW file (the right-hand side of the diff hunk).\n")
	sb.WriteString("- body is 1-3 sentences explaining the problem and why it matters.\n")
	sb.WriteString("- suggestion is a short concrete fix (code or instruction) when you have one; omit it otherwise.\n")
	sb.WriteString("- If the change is correct, return an empty findings array. Never invent problems.\n")
	sb.WriteString("- Check for: logic errors, unhandled error paths, resource leaks, concurrency hazards, injection and path-traversal risks, missing input validation, broken API contracts, off-by-one errors, and missing tests.\n\n")
	if ins := strings.TrimSpace(req.Instructions); ins != "" {
		sb.WriteString("Reviewer focus requested by the user: ")
		sb.WriteString(ins)
		sb.WriteString("\n\n")
	}
	sb.WriteString("Answer with ONLY a JSON object, no prose and no markdown fences:\n")
	sb.WriteString(`{"summary":"<one or two sentences on the overall change>","findings":[{"severity":"critical|major|minor|nit","file":"<path>","line":<int>,"end_line":<int optional>,"title":"<short title>","body":"<explanation>","suggestion":"<optional concrete fix>"}]}`)
	sb.WriteString("\n\nDiff:\n```diff\n")
	sb.WriteString(diff)
	sb.WriteString("\n```\n")
	return sb.String()
}

func sendSSE(w http.ResponseWriter, flusher http.Flusher, payload map[string]any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "data: %s\n\n", data)
	flusher.Flush()
}
