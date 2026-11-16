package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func runGitInTest(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// newReviewRepo creates a git repo with one committed file and one modified
// file plus one untracked file, which is the shape collectReviewDiff must
// report on.
func newReviewRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	runGitInTest(t, dir, "init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGitInTest(t, dir, "add", "a.txt")
	runGitInTest(t, dir, "commit", "-qm", "init")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestCollectReviewDiff(t *testing.T) {
	dir := newReviewRepo(t)

	diff, stats, err := collectReviewDiff(context.Background(), reviewRequest{Cwd: dir}, reviewDefaultMaxDiffBytes)
	if err != nil {
		t.Fatalf("collectReviewDiff: %v", err)
	}
	if !strings.Contains(diff, "+++ b/a.txt") {
		t.Fatalf("diff missing tracked change:\n%s", diff)
	}
	if !strings.Contains(diff, "?? new.txt") {
		t.Fatalf("diff missing untracked file listing:\n%s", diff)
	}
	if stats.files != 1 {
		t.Fatalf("files = %d, want 1", stats.files)
	}
	if stats.added != 1 || stats.removed != 0 {
		t.Fatalf("added/removed = %d/%d, want 1/0", stats.added, stats.removed)
	}
}

func TestCollectReviewDiffTruncates(t *testing.T) {
	dir := newReviewRepo(t)

	diff, stats, err := collectReviewDiff(context.Background(), reviewRequest{Cwd: dir}, 20)
	if err != nil {
		t.Fatalf("collectReviewDiff: %v", err)
	}
	if !stats.truncated {
		t.Fatal("expected truncated stats for a 20-byte budget")
	}
	if !strings.Contains(diff, "[diff truncated") {
		t.Fatalf("diff not marked as truncated:\n%s", diff)
	}
}

func TestCollectReviewDiffRejectsUnsafeBase(t *testing.T) {
	dir := newReviewRepo(t)
	// The handler validates the ref before calling collectReviewDiff; this pins
	// the regex itself so a future edit cannot quietly widen it.
	for _, ref := range []string{"--output=/tmp/x", "-x", "a b", "$(rm -rf /)"} {
		if safeGitRef.MatchString(ref) {
			t.Fatalf("unsafe base ref %q accepted", ref)
		}
	}
	for _, ref := range []string{"HEAD", "HEAD~3", "origin/main", "main", "abc1234"} {
		if !safeGitRef.MatchString(ref) {
			t.Fatalf("safe base ref %q rejected", ref)
		}
	}
	_ = dir
}

// postReview drives the HTTP handler the way the workbench does. Validation
// failures must happen before any model client is constructed, so a zero-value
// Handler is enough for the request-shape tests.
func postReview(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPost, "/v1/review", strings.NewReader(body))
	rr := httptest.NewRecorder()
	h.Review(rr, req)
	return rr
}

func TestReviewHandlerRejectsBadRequests(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name string
		body string
		want string
	}{
		{"malformed json", `{`, "invalid request body"},
		{"missing cwd", `{}`, "cwd is required"},
		{"blank cwd", `{"cwd":"   "}`, "cwd is required"},
		{"relative cwd", `{"cwd":"sidex"}`, "cwd must be an absolute path"},
		{"missing directory", `{"cwd":"/definitely/not/here/sidex"}`, "cwd is not a directory"},
		{"unsafe base", `{"cwd":"` + dir + `","base":"--output=/tmp/x"}`, "base must be a plain git ref"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rr := postReview(t, tc.body)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400 (body %s)", rr.Code, rr.Body.String())
			}
			if !strings.Contains(rr.Body.String(), tc.want) {
				t.Fatalf("body %q does not mention %q", rr.Body.String(), tc.want)
			}
		})
	}
}

func TestReviewHandlerEmptyTreeStreamsError(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	runGitInTest(t, dir, "init", "-q")

	body, err := json.Marshal(reviewRequest{Cwd: dir})
	if err != nil {
		t.Fatal(err)
	}
	rr := postReview(t, string(body))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}
	if !strings.Contains(rr.Body.String(), `"type":"error"`) {
		t.Fatalf("expected an error event, got %q", rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "nothing to review") {
		t.Fatalf("expected the empty-tree message, got %q", rr.Body.String())
	}
}


func TestParseReviewFindingsPlainJSON(t *testing.T) {
	raw := `{"summary":"Adds validation","findings":[{"severity":"Critical","file":"b/internal/api/x.go","line":42,"title":"Unchecked error","body":"The error is ignored."},{"severity":"nope","file":"./y.go","line":0,"title":""}]}`
	payload, err := parseReviewFindings(raw)
	if err != nil {
		t.Fatalf("parseReviewFindings: %v", err)
	}
	if payload.Summary != "Adds validation" {
		t.Errorf("summary = %q", payload.Summary)
	}
	if len(payload.Findings) != 2 {
		t.Fatalf("findings = %d, want 2", len(payload.Findings))
	}
	if payload.Findings[0].Severity != "critical" {
		t.Errorf("severity = %q, want critical", payload.Findings[0].Severity)
	}
	if payload.Findings[0].File != "b/internal/api/x.go" {
		t.Errorf("file = %q", payload.Findings[0].File)
	}
	// Unknown severity falls back to minor; bad line clamps to 1; empty title
	// gets a placeholder so the card is never blank.
	if payload.Findings[1].Severity != "minor" {
		t.Errorf("fallback severity = %q, want minor", payload.Findings[1].Severity)
	}
	if payload.Findings[1].Line != 1 {
		t.Errorf("line = %d, want 1", payload.Findings[1].Line)
	}
	if payload.Findings[1].Title == "" {
		t.Error("title should get a placeholder")
	}
}

func TestParseReviewFindingsFencedAndProse(t *testing.T) {
	raw := "Here is the review:\n```json\n{\"summary\":\"ok\",\"findings\":[{\"severity\":\"nit\",\"file\":\"a.go\",\"line\":3,\"title\":\"Naming\",\"body\":\"Prefer a clearer name.\"}]}\n```\nThanks!"
	payload, err := parseReviewFindings(raw)
	if err != nil {
		t.Fatalf("parseReviewFindings: %v", err)
	}
	if len(payload.Findings) != 1 || payload.Findings[0].File != "a.go" {
		t.Fatalf("unexpected payload: %+v", payload)
	}
}

func TestParseReviewFindingsRejectsNonJSON(t *testing.T) {
	if _, err := parseReviewFindings("Everything looks good to me."); err == nil {
		t.Fatal("expected an error for prose-only output")
	}
}

func TestNormalizeSeverity(t *testing.T) {
	cases := map[string]string{
		"CRITICAL": "critical", "blocker": "critical", "warn": "major",
		"info": "minor", "style": "nit", "": "minor", "bogus": "minor",
	}
	for in, want := range cases {
		if got := normalizeSeverity(in); got != want {
			t.Errorf("normalizeSeverity(%q) = %q, want %q", in, got, want)
		}
	}
}
