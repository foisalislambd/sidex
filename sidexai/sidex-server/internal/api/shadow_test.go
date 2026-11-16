package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestHandlerForGit is enough for the shadow endpoints: they only shell out
// to git and never touch Handler state.
func newTestHandlerForGit(_ *testing.T) *Handler { return &Handler{} }

func postShadow(t *testing.T, h *Handler, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	switch path {
	case "/v1/shadow/create":
		h.ShadowCreate(rec, req)
	case "/v1/shadow/diff":
		h.ShadowDiff(rec, req)
	case "/v1/shadow/apply":
		h.ShadowApply(rec, req)
	case "/v1/shadow/discard":
		h.ShadowDiscard(rec, req)
	case "/v1/shadow/list":
		h.ShadowList(rec, req)
	default:
		t.Fatalf("unknown path %s", path)
	}
	return rec
}

func TestShadowWorkspaceLifecycle(t *testing.T) {
	dir := newReviewRepo(t)
	h := newTestHandlerForGit(t)

	rec := postShadow(t, h, "/v1/shadow/create", map[string]any{"cwd": dir, "name": "test-run"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var created shadowResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.Shadow == "" {
		t.Fatal("create returned no shadow path")
	}

	// Start from a clean working tree: the merge is all-or-nothing and refuses
	// to overwrite a file the user has edited since the shadow was created.
	runGitInTest(t, dir, "checkout", "--", "a.txt")

	// Speculative edit inside the shadow must not touch the real tree.
	shadowFile := filepath.Join(created.Shadow, "a.txt")
	if err := os.WriteFile(shadowFile, []byte("one\ntwo\nthree\nfour\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	real, err := os.ReadFile(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(real), "four") {
		t.Fatal("shadow edit leaked into the real working tree")
	}

	rec = postShadow(t, h, "/v1/shadow/diff", map[string]any{"cwd": dir, "shadow": created.Shadow})
	if rec.Code != http.StatusOK {
		t.Fatalf("diff status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var diffed shadowResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &diffed); err != nil {
		t.Fatalf("decode diff: %v", err)
	}
	if !strings.Contains(diffed.Diff, "+four") {
		t.Fatalf("diff did not contain the shadow edit:\n%s", diffed.Diff)
	}

	rec = postShadow(t, h, "/v1/shadow/apply", map[string]any{"cwd": dir, "shadow": created.Shadow})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status = %d, body = %s", rec.Code, rec.Body.String())
	}
	merged, err := os.ReadFile(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(merged), "four") {
		t.Fatalf("apply did not merge the shadow edit, got:\n%s", merged)
	}

	rec = postShadow(t, h, "/v1/shadow/discard", map[string]any{"cwd": dir, "shadow": created.Shadow})
	if rec.Code != http.StatusOK {
		t.Fatalf("discard status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(created.Shadow); !os.IsNotExist(err) {
		t.Fatalf("shadow directory still exists after discard: %v", err)
	}
}

func TestShadowListReportsOnlyOwnWorktrees(t *testing.T) {
	dir := newReviewRepo(t)
	h := newTestHandlerForGit(t)

	rec := postShadow(t, h, "/v1/shadow/create", map[string]any{"cwd": dir, "name": "listed"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d: %s", rec.Code, rec.Body.String())
	}
	var created shadowResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	rec = postShadow(t, h, "/v1/shadow/list", map[string]any{"cwd": dir})
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d: %s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Shadows []string `json:"shadows"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Shadows) != 1 || !strings.HasSuffix(listed.Shadows[0], "listed") {
		t.Fatalf("unexpected shadow list: %+v", listed.Shadows)
	}
}

func TestShadowRejectsForeignPath(t *testing.T) {
	dir := newReviewRepo(t)
	other := t.TempDir()
	h := newTestHandlerForGit(t)

	rec := postShadow(t, h, "/v1/shadow/diff", map[string]any{"cwd": dir, "shadow": other})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a non-worktree path, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = postShadow(t, h, "/v1/shadow/create", map[string]any{"cwd": "relative/path"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a relative cwd, got %d", rec.Code)
	}
}

func TestSanitizeShadowName(t *testing.T) {
	cases := map[string]string{
		"my run":       "my-run",
		"../../escape": "escape",
		"a/b":          "a-b",
		"":             "",
		"...":          "",
		"keep_me.md":   "keep_me.md",
	}
	for in, want := range cases {
		if got := sanitizeShadowName(in); got != want {
			t.Errorf("sanitizeShadowName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestShadowApplyRefusesToOverwriteLocalEdits(t *testing.T) {
	dir := newReviewRepo(t)
	h := newTestHandlerForGit(t)

	rec := postShadow(t, h, "/v1/shadow/create", map[string]any{"cwd": dir, "name": "conflict"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d: %s", rec.Code, rec.Body.String())
	}
	var created shadowResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(created.Shadow, "a.txt"), []byte("from shadow\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The user keeps editing the real file after the shadow was created.
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("local edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec = postShadow(t, h, "/v1/shadow/apply", map[string]any{"cwd": dir, "shadow": created.Shadow})
	if rec.Code != http.StatusConflict {
		t.Fatalf("apply status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	var conflicted shadowResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &conflicted); err != nil {
		t.Fatal(err)
	}
	if len(conflicted.Conflicts) != 1 || !strings.HasPrefix(conflicted.Conflicts[0], "a.txt") {
		t.Fatalf("unexpected conflicts: %+v", conflicted.Conflicts)
	}
	local, err := os.ReadFile(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(local) != "local edit\n" {
		t.Fatalf("local edit was clobbered: %q", string(local))
	}
}

func TestShadowApplyCarriesNewFiles(t *testing.T) {
	dir := newReviewRepo(t)
	h := newTestHandlerForGit(t)

	rec := postShadow(t, h, "/v1/shadow/create", map[string]any{"cwd": dir, "name": "newfile"})
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d: %s", rec.Code, rec.Body.String())
	}
	var created shadowResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(created.Shadow, "generated.go"), []byte("package generated\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec = postShadow(t, h, "/v1/shadow/diff", map[string]any{"cwd": dir, "shadow": created.Shadow})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "generated.go") {
		t.Fatalf("diff should mention the new file: %d %s", rec.Code, rec.Body.String())
	}

	rec = postShadow(t, h, "/v1/shadow/apply", map[string]any{"cwd": dir, "shadow": created.Shadow})
	if rec.Code != http.StatusOK {
		t.Fatalf("apply status = %d: %s", rec.Code, rec.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(dir, "generated.go"))
	if err != nil {
		t.Fatalf("new file was not applied: %v", err)
	}
	if string(content) != "package generated\n" {
		t.Fatalf("unexpected new file content: %q", string(content))
	}
}
