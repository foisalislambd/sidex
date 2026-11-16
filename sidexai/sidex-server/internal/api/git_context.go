package api

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type gitContextRequest struct {
	Cwd    string `json:"cwd"`
	Base   string `json:"base,omitempty"`
	Staged *bool  `json:"staged,omitempty"`
}

type gitContextResponse struct {
	Diff      string `json:"diff,omitempty"`
	Status    string `json:"status,omitempty"`
	Files     int    `json:"files,omitempty"`
	Added     int    `json:"added,omitempty"`
	Removed   int    `json:"removed,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// GitDiff handles POST /v1/git-diff. It returns the raw unified diff and
// lightweight stats without invoking a model, so UI surfaces (mention
// resolution, "attach diff" affordances) can embed the current changes as
// context.
func (h *Handler) GitDiff(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req gitContextRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Cwd) == "" || !filepath.IsAbs(req.Cwd) {
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

	diff, stats, err := collectReviewDiff(r.Context(), reviewRequest{Cwd: req.Cwd, Base: req.Base, Staged: req.Staged}, reviewDefaultMaxDiffBytes)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, gitContextResponse{Diff: diff, Files: stats.files, Added: stats.added, Removed: stats.removed, Truncated: stats.truncated})
}

// GitStatus handles POST /v1/git-status and returns porcelain-style status so
// a mention can include "what changed" without a full diff.
func (h *Handler) GitStatus(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

	var req gitContextRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Cwd) == "" || !filepath.IsAbs(req.Cwd) {
		writeJSONError(w, http.StatusBadRequest, "cwd must be an absolute path")
		return
	}
	if info, err := os.Stat(req.Cwd); err != nil || !info.IsDir() {
		writeJSONError(w, http.StatusBadRequest, "cwd is not a directory")
		return
	}

	status, err := runGit(contextWithDefaultTimeout(r.Context()), req.Cwd, "status", "--short", "--branch")
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, gitContextResponse{Status: status})
}

// contextWithDefaultTimeout reuses the git timeout policy without importing
// extra plumbing; runGit already applies its own timeout, so this just returns
// the incoming context.
func contextWithDefaultTimeout(ctx context.Context) context.Context {
	return ctx
}
