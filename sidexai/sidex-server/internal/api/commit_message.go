package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
)

// commitMessageRequest is the body for POST /v1/commit-message.
//
// The server reads the pending diff from the working tree itself (same
// privilege boundary as /v1/review and the agent's shell tools) and asks the
// model to propose a single commit message. The response is plain JSON, not an
// SSE stream, because a commit subject is a small, atomic result.
type commitMessageRequest struct {
	Cwd           string `json:"cwd"`
	Base          string `json:"base,omitempty"`
	Staged        *bool  `json:"staged,omitempty"`
	Instructions  string `json:"instructions,omitempty"`
	Model         string `json:"model,omitempty"`
	MaxDiffBytes  int    `json:"max_diff_bytes,omitempty"`
}

// commitMessageResponse is the JSON body returned on success.
type commitMessageResponse struct {
	Message   string `json:"message"`
	Files     int    `json:"files"`
	Added     int    `json:"added"`
	Removed   int    `json:"removed"`
	Truncated bool   `json:"truncated"`
}

const (
	commitDefaultMaxDiffBytes = 120_000
	commitMaxDiffBytes        = 600_000
)

// CommitMessage handles POST /v1/commit-message.
func (h *Handler) CommitMessage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req commitMessageRequest
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
		maxDiff = commitDefaultMaxDiffBytes
	}
	if maxDiff > commitMaxDiffBytes {
		maxDiff = commitMaxDiffBytes
	}

	diffReq := reviewRequest{Cwd: req.Cwd, Base: req.Base, Staged: req.Staged}
	diff, stats, err := collectReviewDiff(r.Context(), diffReq, maxDiff)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(diff) == "" {
		writeJSONError(w, http.StatusBadRequest, "nothing to describe: the working tree has no changes against "+describeBase(diffReq))
		return
	}

	recent, _ := recentCommitSubjects(r.Context(), req.Cwd, 5)
	prompt := buildCommitMessagePrompt(diff, recent, req.Instructions)

	client := h.clientFor(req.Model, auth.UserIDFromContext(r.Context()))

	var out strings.Builder
	err = client.StreamChat([]ai.Message{{Role: ai.RoleUser, Content: prompt}}, nil, "", func(chunk ai.StreamChunk) {
		if chunk.Type == "text" {
			out.WriteString(chunk.Content)
		}
	})
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}

	msg := normalizeCommitMessage(out.String())
	if msg == "" {
		writeJSONError(w, http.StatusBadGateway, "model returned an empty commit message")
		return
	}

	writeJSON(w, http.StatusOK, commitMessageResponse{
		Message:   msg,
		Files:     stats.files,
		Added:     stats.added,
		Removed:   stats.removed,
		Truncated: stats.truncated,
	})
}



func recentCommitSubjects(ctx context.Context, cwd string, n int) ([]string, error) {
	out, err := runGit(ctx, cwd, "log", "-n", fmt.Sprintf("%d", n), "--pretty=format:%s")
	if err != nil {
		return nil, err
	}
	return nonEmptyLines(out), nil
}

func buildCommitMessagePrompt(diff string, recent []string, instructions string) string {
	var sb strings.Builder
	sb.WriteString("You write git commit messages. Produce a single commit message for the diff below.\n\n")
	sb.WriteString("Rules:\n")
	sb.WriteString("- Use Conventional Commits when the repo's history suggests it, otherwise a clear imperative subject.\n")
	sb.WriteString("- Subject line: imperative, <= 72 characters, no trailing period.\n")
	sb.WriteString("- Add a blank line and a short body (wrapped ~72 cols) only if the 'why' is not obvious from the subject.\n")
	sb.WriteString("- Describe the intent and impact, not a file-by-file inventory.\n")
	sb.WriteString("- Output ONLY the commit message. No markdown fences, no explanations, no preamble.\n")
	if len(recent) > 0 {
		sb.WriteString("\nRecent commit subjects in this repo (match their style):\n")
		for _, s := range recent {
			sb.WriteString("- ")
			sb.WriteString(s)
			sb.WriteString("\n")
		}
	}
	if ins := strings.TrimSpace(instructions); ins != "" {
		sb.WriteString("\nAdditional instructions: ")
		sb.WriteString(ins)
		sb.WriteString("\n")
	}
	sb.WriteString("\nDiff:\n```diff\n")
	sb.WriteString(diff)
	sb.WriteString("\n```\n")
	return sb.String()
}

// normalizeCommitMessage strips markdown fences and surrounding whitespace while
// preserving the message body the model intended.
func normalizeCommitMessage(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Drop a single wrapping fence if the model ignored instructions.
	if strings.HasPrefix(s, "```") {
		lines := strings.Split(s, "\n")
		if len(lines) >= 2 {
			// remove first fence line and a trailing fence line
			if strings.HasPrefix(lines[0], "```") {
				lines = lines[1:]
			}
			if n := len(lines); n > 0 && strings.TrimSpace(lines[n-1]) == "```" {
				lines = lines[:n-1]
			}
			s = strings.Join(lines, "\n")
		}
	}
	return strings.TrimSpace(s)
}
