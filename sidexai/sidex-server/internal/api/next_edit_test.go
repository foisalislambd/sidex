package api

import "testing"

func TestParseNextEditPrediction(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want nextEditPrediction
	}{
		{
			name: "bare json",
			raw:  `{"kind":"jump","line":12,"character":5,"start_line":12,"end_line":12,"replacement":"x := 1","reason":"rename"}`,
			want: nextEditPrediction{Kind: "jump", Line: 12, Character: 5, StartLine: 12, EndLine: 12, Replacement: "x := 1", Reason: "rename"},
		},
		{
			name: "fenced with prose",
			raw:  "Here you go:\n```json\n{\"kind\":\"insert\",\"line\":3,\"replacement\":\"return nil\"}\n```\nbye",
			want: nextEditPrediction{Kind: "insert", Line: 3, Character: 1, StartLine: 3, EndLine: 3, Replacement: "return nil"},
		},
		{
			name: "braces inside strings",
			raw:  `{"kind":"insert","line":2,"replacement":"fmt.Printf(\"{%s}\", v)","reason":"brace { in string"}`,
			want: nextEditPrediction{Kind: "insert", Line: 2, Character: 1, StartLine: 2, EndLine: 2, Replacement: `fmt.Printf("{%s}", v)`, Reason: "brace { in string"},
		},
		{
			name: "empty replacement degrades to none",
			raw:  `{"kind":"jump","line":4,"replacement":"   "}`,
			want: nextEditPrediction{Kind: "none", Reason: "empty replacement"},
		},
		{
			name: "unknown kind degrades to none",
			raw:  `{"kind":"rewrite","line":4,"replacement":"x"}`,
			want: nextEditPrediction{Kind: "none", Reason: "unrecognised kind rewrite"},
		},
		{
			name: "no json",
			raw:  "I cannot predict anything useful.",
			want: nextEditPrediction{Kind: "none", Reason: "model returned no JSON object"},
		},
		{
			name: "malformed json",
			raw:  `{"kind":"jump", "line":`,
			want: nextEditPrediction{Kind: "none", Reason: "model returned no JSON object"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseNextEditPrediction(tc.raw)
			if got.Kind != tc.want.Kind {
				t.Fatalf("kind = %q, want %q (reason %q)", got.Kind, tc.want.Kind, got.Reason)
			}
			if tc.want.Kind == "none" {
				if tc.want.Reason != "" && got.Reason != tc.want.Reason {
					t.Fatalf("reason = %q, want %q", got.Reason, tc.want.Reason)
				}
				return
			}
			if got.Line != tc.want.Line || got.Character != tc.want.Character {
				t.Fatalf("position = %d:%d, want %d:%d", got.Line, got.Character, tc.want.Line, tc.want.Character)
			}
			if got.StartLine != tc.want.StartLine || got.EndLine != tc.want.EndLine {
				t.Fatalf("range = %d-%d, want %d-%d", got.StartLine, got.EndLine, tc.want.StartLine, tc.want.EndLine)
			}
			if got.Replacement != tc.want.Replacement {
				t.Fatalf("replacement = %q, want %q", got.Replacement, tc.want.Replacement)
			}
		})
	}
}

func TestExtractJSONObject(t *testing.T) {
	if got := extractJSONObject(`no json here`); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
	if got := extractJSONObject(`a {"k":"v"} b {"k":"w"}`); got != `{"k":"v"}` {
		t.Fatalf("expected first object, got %q", got)
	}
	if got := extractJSONObject(`{"s":"}"}`); got != `{"s":"}"}` {
		t.Fatalf("string braces should not close the object, got %q", got)
	}
}

func TestBuildNextEditPromptTruncatesOversizedContext(t *testing.T) {
	big := make([]byte, nextEditMaxPrefixBytes+1024)
	for i := range big {
		big[i] = 'a'
	}
	prompt := buildNextEditPrompt(nextEditRequest{Prefix: string(big), Suffix: "tail", FilePath: "a.go", Language: "go"})
	if len(prompt) > nextEditMaxPrefixBytes+nextEditMaxSuffixBytes+4096 {
		t.Fatalf("prompt not bounded: %d bytes", len(prompt))
	}
	if !contains(prompt, "<CURSOR>") {
		t.Fatal("prompt lost the cursor marker")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
