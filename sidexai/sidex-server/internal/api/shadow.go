package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Shadow workspaces (local equivalent of Cursor's shadow workspace).
//
// A shadow workspace is a detached git worktree of the current repository. It
// starts with the same tree, so the agent can make speculative edits there, and
// the changes can be reviewed (`/v1/shadow/diff`), merged back into the real
// working tree (`/v1/shadow/apply`) or thrown away (`/v1/shadow/discard`).
//
// The server keeps no state: every call passes the shadow path back in, and the
// path is validated against `git worktree list` before it is read or written.

const shadowDirName = ".sidex/shadow"

type shadowRequest struct {
	Cwd    string `json:"cwd"`
	Shadow string `json:"shadow,omitempty"`
	Name   string `json:"name,omitempty"`
}

type shadowResponse struct {
	Shadow    string   `json:"shadow"`
	Branch    string   `json:"branch,omitempty"`
	Diff      string   `json:"diff,omitempty"`
	Applied   bool     `json:"applied,omitempty"`
	Files     int      `json:"files,omitempty"`
	Conflicts []string `json:"conflicts,omitempty"`
}

// ShadowCreate handles POST /v1/shadow/create. It adds a detached worktree at
// `<cwd>/.sidex/shadow/<name>` and returns its path.
func (h *Handler) ShadowCreate(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeShadowRequest(w, r, false)
	if !ok {
		return
	}

	name := sanitizeShadowName(req.Name)
	if name == "" {
		name = fmt.Sprintf("ws-%d", os.Getpid())
	}
	dir := filepath.Join(req.Cwd, shadowDirName, name)

	if _, err := os.Stat(dir); err == nil {
		writeJSONError(w, http.StatusConflict, "a shadow workspace already exists at "+dir)
		return
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "could not create shadow directory: "+err.Error())
		return
	}

	if _, err := runGit(r.Context(), req.Cwd, "worktree", "add", "--detach", dir, "HEAD"); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, shadowResponse{Shadow: dir, Branch: "HEAD (detached)"})
}

// ShadowDiff handles POST /v1/shadow/diff: the shadow's changes against HEAD.
func (h *Handler) ShadowDiff(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeShadowRequest(w, r, true)
	if !ok {
		return
	}
	if !isShadowWorktree(r, req.Cwd, req.Shadow) {
		writeJSONError(w, http.StatusBadRequest, "shadow is not a worktree of cwd")
		return
	}

	diff, err := runGit(r.Context(), req.Shadow, "diff", "HEAD", "--no-color", "--unified=3")
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Untracked files created by speculative edits never appear in `git diff`.
	untracked, _ := runGit(r.Context(), req.Shadow, "ls-files", "--others", "--exclude-standard")
	for _, path := range nonEmptyLines(untracked) {
		diff += "\n# New file in shadow workspace: " + path + "\n"
	}
	writeJSON(w, http.StatusOK, shadowResponse{Shadow: req.Shadow, Diff: diff, Files: countFiles(diff)})
}

// ShadowApply handles POST /v1/shadow/apply: copy the shadow's changed files
// into the real working tree.
//
// It is deliberately all-or-nothing and content-checked rather than a `git
// apply`: a file whose working-tree content has drifted from HEAD since the
// shadow was created would otherwise receive a hunk at the wrong offset and
// silently duplicate or lose lines. Instead, every changed path is compared and
// any conflict aborts the whole merge with the conflicted paths reported.
func (h *Handler) ShadowApply(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeShadowRequest(w, r, true)
	if !ok {
		return
	}
	if !isShadowWorktree(r, req.Cwd, req.Shadow) {
		writeJSONError(w, http.StatusBadRequest, "shadow is not a worktree of cwd")
		return
	}

	paths, err := shadowChangedPaths(r.Context(), req.Shadow)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(paths) == 0 {
		writeJSONError(w, http.StatusBadRequest, "the shadow workspace has no changes to apply")
		return
	}

	type change struct {
		path    string
		deleted bool
		content string
	}
	changes := make([]change, 0, len(paths))
	conflicts := make([]string, 0)

	for _, path := range paths {
		head, headErr := runGit(r.Context(), req.Cwd, "show", "HEAD:"+path)
		headExists := headErr == nil

		realPath := filepath.Join(req.Cwd, filepath.FromSlash(path))
		real, realErr := os.ReadFile(realPath)
		realExists := realErr == nil

		shadowPath := filepath.Join(req.Shadow, filepath.FromSlash(path))
		shadow, shadowErr := os.ReadFile(shadowPath)
		shadowExists := shadowErr == nil

		// The working-tree copy must still match HEAD (or be absent when HEAD
		// has no such file) for the merge to be unambiguous.
		if headExists {
			if !realExists || !sameContent(string(real), head) {
				conflicts = append(conflicts, path+" (modified locally)")
				continue
			}
		} else if realExists {
			conflicts = append(conflicts, path+" (created locally)")
			continue
		}

		changes = append(changes, change{path: path, deleted: !shadowExists, content: string(shadow)})
	}

	if len(conflicts) > 0 {
		writeJSON(w, http.StatusConflict, shadowResponse{
			Shadow:    req.Shadow,
			Conflicts: conflicts,
		})
		return
	}

	for _, c := range changes {
		realPath := filepath.Join(req.Cwd, filepath.FromSlash(c.path))
		if c.deleted {
			if err := os.Remove(realPath); err != nil && !os.IsNotExist(err) {
				writeJSONError(w, http.StatusInternalServerError, "could not remove "+c.path+": "+err.Error())
				return
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(realPath), 0o755); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not create directory for "+c.path+": "+err.Error())
			return
		}
		if err := os.WriteFile(realPath, []byte(c.content), 0o644); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "could not write "+c.path+": "+err.Error())
			return
		}
	}

	writeJSON(w, http.StatusOK, shadowResponse{Shadow: req.Shadow, Applied: true, Files: len(changes)})
}

// ShadowDiscard handles POST /v1/shadow/discard: remove the worktree.
func (h *Handler) ShadowDiscard(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeShadowRequest(w, r, true)
	if !ok {
		return
	}
	if !isShadowWorktree(r, req.Cwd, req.Shadow) {
		writeJSONError(w, http.StatusBadRequest, "shadow is not a worktree of cwd")
		return
	}

	if _, err := runGit(r.Context(), req.Cwd, "worktree", "remove", "--force", req.Shadow); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, shadowResponse{Shadow: req.Shadow})
}

// ShadowList handles POST /v1/shadow/list: shadow worktrees known to git.
func (h *Handler) ShadowList(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeShadowRequest(w, r, false)
	if !ok {
		return
	}
	out, err := runGit(r.Context(), req.Cwd, "worktree", "list", "--porcelain")
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	shadows := []string{}
	prefix := filepath.Join(req.Cwd, shadowDirName) + string(os.PathSeparator)
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "worktree ") {
			continue
		}
		path := strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
		if strings.HasPrefix(path, prefix) {
			shadows = append(shadows, path)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"cwd": req.Cwd, "shadows": shadows})
}

// ── helpers ─────────────────────────────────────────────────────────────────

// shadowChangedPaths lists every path that differs from HEAD in the shadow,
// including untracked additions.
func shadowChangedPaths(ctx context.Context, shadow string) ([]string, error) {
	out, err := runGit(ctx, shadow, "status", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	paths := []string{}
	for _, entry := range strings.Split(out, "\x00") {
		// NUL-delimited porcelain entries are exactly "XY <path>"; the status
		// columns include a space, so trimming the entry would shift the path.
		entry = strings.TrimRight(entry, "\r")
		if len(entry) < 4 {
			continue
		}
		path := entry[3:]
		// Renames are "R  old -> new"; the merge only needs the destination.
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+4:]
		}
		path = strings.TrimPrefix(filepath.ToSlash(path), "./")
		if path == "" {
			continue
		}
		if _, dup := seen[path]; dup {
			continue
		}
		seen[path] = struct{}{}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths, nil
}

func sameContent(a, b string) bool {
	return strings.ReplaceAll(a, "\r\n", "\n") == strings.ReplaceAll(b, "\r\n", "\n")
}

func decodeShadowRequest(w http.ResponseWriter, r *http.Request, needShadow bool) (shadowRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req shadowRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return req, false
	}
	if strings.TrimSpace(req.Cwd) == "" || !filepath.IsAbs(req.Cwd) {
		writeJSONError(w, http.StatusBadRequest, "cwd must be an absolute path")
		return req, false
	}
	if info, err := os.Stat(req.Cwd); err != nil || !info.IsDir() {
		writeJSONError(w, http.StatusBadRequest, "cwd is not a directory")
		return req, false
	}
	if needShadow {
		if strings.TrimSpace(req.Shadow) == "" || !filepath.IsAbs(req.Shadow) {
			writeJSONError(w, http.StatusBadRequest, "shadow must be an absolute path")
			return req, false
		}
	}
	return req, true
}

// isShadowWorktree confirms that `shadow` is one of cwd's own worktrees, so a
// forged path cannot be read from or applied out of an unrelated repository.
func isShadowWorktree(r *http.Request, cwd, shadow string) bool {
	out, err := runGit(r.Context(), cwd, "worktree", "list", "--porcelain")
	if err != nil {
		return false
	}
	clean := filepath.Clean(shadow)
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "worktree ") {
			continue
		}
		if filepath.Clean(strings.TrimSpace(strings.TrimPrefix(line, "worktree "))) == clean {
			return true
		}
	}
	return false
}

func sanitizeShadowName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-.")
}

// runGitStdin runs git in dir with `stdin` piped in, returning stderr on error.
func runGitStdin(ctx context.Context, dir, stdin string, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_PAGER=cat")
	cmd.Stdin = strings.NewReader(stdin)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
		}
		return fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return nil
}
