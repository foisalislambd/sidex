package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
)

// nextEditRequest is the body for POST /v1/next-edit.
//
// Next-edit prediction is the counterpart to /v1/completions: a completion
// guesses the text that continues the cursor, while a next-edit prediction
// guesses *which* place in the file the programmer is about to touch next and
// what the edit there should be. SideX shows the result as a "Tab to jump"
// hint when the target is away from the cursor, so the response carries an
// explicit target position instead of only replacement text.
type nextEditRequest struct {
	FilePath   string `json:"file_path"`
	Language   string `json:"language,omitempty"`
	Prefix     string `json:"prefix"`
	Suffix     string `json:"suffix"`
	PrefixLine int    `json:"prefix_line,omitempty"` // 1-based line number of Prefix's first line
	RecentEdit []struct {
		FilePath string `json:"file_path"`
		Diff     string `json:"diff"`
	} `json:"recent_edits,omitempty"`
	Diagnostics string `json:"diagnostics,omitempty"`
	Model       string `json:"model,omitempty"`
}

// nextEditPrediction is the response body. Kind "none" means the model found
// nothing worth predicting; the client must treat that as "no suggestion"
// rather than as an error.
type nextEditPrediction struct {
	Kind        string `json:"kind"` // "jump" | "insert" | "none"
	FilePath    string `json:"file_path,omitempty"`
	Line        int    `json:"line,omitempty"`      // 1-based insert/jump line
	Character   int    `json:"character,omitempty"` // 1-based column
	StartLine   int    `json:"start_line,omitempty"`
	EndLine     int    `json:"end_line,omitempty"`
	Replacement string `json:"replacement,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

const (
	nextEditMaxPrefixBytes = 16000
	nextEditMaxSuffixBytes = 4000
	nextEditMaxReplacement = 40000
	nextEditMaxEdits       = 5
	nextEditMaxEditBytes   = 4000
)

// NextEdit handles POST /v1/next-edit. It is a single-shot JSON endpoint: the
// prediction is small, and the client needs the parsed target before it can
// decide whether to render ghost text or a jump hint.
func (h *Handler) NextEdit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)

	var req nextEditRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Prefix) == "" && strings.TrimSpace(req.Suffix) == "" {
		writeJSONError(w, http.StatusBadRequest, "prefix or suffix is required")
		return
	}

	prompt := buildNextEditPrompt(req)

	client := h.clientFor(req.Model, auth.UserIDFromContext(r.Context()))

	var out strings.Builder
	err := client.StreamChat([]ai.Message{{Role: ai.RoleUser, Content: prompt}}, nil, "", func(chunk ai.StreamChunk) {
		if chunk.Type == "text" {
			out.WriteString(chunk.Content)
		}
	})
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}

	pred := parseNextEditPrediction(out.String())
	writeJSON(w, http.StatusOK, pred)
}

func buildNextEditPrompt(req nextEditRequest) string {
	language := req.Language
	if language == "" {
		language = "text"
	}
	file := req.FilePath
	if file == "" {
		file = "the current file"
	}

	prefix := truncateHead(req.Prefix, nextEditMaxPrefixBytes)
	suffix := truncateTail(req.Suffix, nextEditMaxSuffixBytes)

	var sb strings.Builder
	sb.WriteString("You predict the next edit a programmer will make, like an IDE's next-edit suggestion.\n")
	sb.WriteString("Return ONE edit. Prefer the location the programmer is most likely to change next, which is often NOT the cursor.\n\n")
	sb.WriteString("File: ")
	sb.WriteString(file)
	sb.WriteString("\nLanguage: ")
	sb.WriteString(language)
	sb.WriteString("\n")

	if req.PrefixLine > 0 {
		fmt.Fprintf(&sb, "The code before the cursor starts at line %d.\n", req.PrefixLine)
	}

	edits := req.RecentEdit
	if len(edits) > nextEditMaxEdits {
		edits = edits[len(edits)-nextEditMaxEdits:]
	}
	if len(edits) > 0 {
		sb.WriteString("\nRecent edits in this session (newest last):\n")
		for _, e := range edits {
			sb.WriteString("--- ")
			sb.WriteString(e.FilePath)
			sb.WriteString(" ---\n")
			sb.WriteString(truncateHead(e.Diff, nextEditMaxEditBytes))
			sb.WriteString("\n")
		}
	}

	if d := strings.TrimSpace(req.Diagnostics); d != "" {
		sb.WriteString("\nCurrent diagnostics:\n")
		sb.WriteString(truncateHead(d, 4000))
		sb.WriteString("\n")
	}

	sb.WriteString("\nCode before the cursor:\n")
	sb.WriteString(prefix)
	sb.WriteString("\n<CURSOR>\n")
	sb.WriteString(suffix)
	sb.WriteString("\n\nAnswer with ONLY a JSON object, no prose and no markdown fences:\n")
	sb.WriteString(`{"kind":"jump"|"insert"|"none","line":<1-based line>,"character":<1-based column>,`)
	sb.WriteString(`"start_line":<first line replaced>,"end_line":<last line replaced>,"replacement":"<new text>","reason":"<short why>"}`)
	sb.WriteString("\n\nRules:\n")
	sb.WriteString("- Use \"jump\" when the edit belongs somewhere other than the cursor; line/character are the target.\n")
	sb.WriteString("- Use \"insert\" when the edit continues at the cursor.\n")
	sb.WriteString("- Use start_line/end_line for the range the replacement overwrites; for a pure insertion set both to the insert line.\n")
	sb.WriteString("- Use \"none\" if there is no confident prediction. Never invent code that does not follow from the surrounding context.\n")
	sb.WriteString("- Keep the replacement minimal: the changed lines, not the whole file.\n")
	return sb.String()
}

// parseNextEditPrediction decodes the model's answer defensively. A model that
// wraps JSON in prose or fences is common enough that failing the whole request
// over it would make the feature unusable; an unparseable answer degrades to
// kind "none" with the raw reason preserved.
func parseNextEditPrediction(raw string) nextEditPrediction {
	obj := extractJSONObject(raw)
	if obj == "" {
		return nextEditPrediction{Kind: "none", Reason: "model returned no JSON object"}
	}

	var pred nextEditPrediction
	if err := json.Unmarshal([]byte(obj), &pred); err != nil {
		return nextEditPrediction{Kind: "none", Reason: "model returned malformed JSON"}
	}

	pred.Kind = strings.ToLower(strings.TrimSpace(pred.Kind))
	switch pred.Kind {
	case "jump", "insert":
	case "none", "":
		return nextEditPrediction{Kind: "none", Reason: pred.Reason}
	default:
		return nextEditPrediction{Kind: "none", Reason: "unrecognised kind " + pred.Kind}
	}

	if pred.Replacement == "" || strings.TrimSpace(pred.Replacement) == "" {
		return nextEditPrediction{Kind: "none", Reason: "empty replacement"}
	}
	if !utf8.ValidString(pred.Replacement) {
		return nextEditPrediction{Kind: "none", Reason: "replacement was not valid UTF-8"}
	}
	if len(pred.Replacement) > nextEditMaxReplacement {
		pred.Replacement = pred.Replacement[:nextEditMaxReplacement]
	}

	if pred.Line < 1 {
		pred.Line = 1
	}
	if pred.Character < 1 {
		pred.Character = 1
	}
	if pred.StartLine < 1 {
		pred.StartLine = pred.Line
	}
	if pred.EndLine < pred.StartLine {
		pred.EndLine = pred.StartLine
	}
	if pred.Kind == "insert" {
		pred.StartLine = pred.Line
		pred.EndLine = pred.Line
	}
	return pred
}

// extractJSONObject returns the first balanced {...} run in s, ignoring braces
// inside string literals. Markdown fences and prose around it are dropped.
func extractJSONObject(s string) string {
	start := -1
	depth := 0
	inString := false
	escaped := false

	for i := 0; i < len(s); i++ {
		c := s[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			if start < 0 {
				start = i
			}
			depth++
		case '}':
			if start >= 0 {
				depth--
				if depth == 0 {
					return s[start : i+1]
				}
			}
		}
	}
	return ""
}

func truncateHead(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n…[truncated]"
}

func truncateTail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return "[truncated]…\n" + s[len(s)-max:]
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
