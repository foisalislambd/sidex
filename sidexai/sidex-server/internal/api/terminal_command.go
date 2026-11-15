package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/sidex-ai/sidex-server/internal/ai"
	"github.com/sidex-ai/sidex-server/internal/auth"
)

// terminalCommandRequest is the body for POST /v1/terminal-command.
//
// This is the terminal counterpart to /v1/inline-edit: instead of rewriting a
// code selection it turns a natural-language request into a single shell
// command for the active terminal's shell and operating system. The model never
// executes anything — the command is streamed back and the editor inserts it,
// leaving the final Enter to the user.
type terminalCommandRequest struct {
	Instruction string `json:"instruction"`
	Cwd         string `json:"cwd,omitempty"`
	Shell       string `json:"shell,omitempty"`
	OS          string `json:"os,omitempty"`
	Context     string `json:"context,omitempty"`
	Model       string `json:"model,omitempty"`
}

func (h *Handler) TerminalCommand(w http.ResponseWriter, r *http.Request) {
	var req terminalCommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, 400)
		return
	}
	if strings.TrimSpace(req.Instruction) == "" {
		http.Error(w, `{"error":"instruction is required"}`, 400)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, `{"error":"streaming not supported"}`, 500)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	prompt := buildTerminalCommandPrompt(req)

	client := h.clientFor(req.Model, auth.UserIDFromContext(r.Context()))
	messages := []ai.Message{
		{Role: ai.RoleUser, Content: prompt},
	}

	err := client.StreamChat(messages, nil, "", func(chunk ai.StreamChunk) {
		switch chunk.Type {
		case "text":
			data, _ := json.Marshal(map[string]string{
				"type":    "text",
				"content": chunk.Content,
			})
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		case "done":
			fmt.Fprint(w, "data: {\"type\":\"done\"}\n\n")
			flusher.Flush()
		}
	})

	if err != nil {
		errData, _ := json.Marshal(map[string]string{
			"type":  "error",
			"error": err.Error(),
		})
		fmt.Fprintf(w, "data: %s\n\n", errData)
		flusher.Flush()
	}
}

func buildTerminalCommandPrompt(req terminalCommandRequest) string {
	shell := req.Shell
	if shell == "" {
		shell = "sh"
	}
	osName := req.OS
	if osName == "" {
		osName = "linux"
	}

	var sb strings.Builder
	sb.WriteString("You are a shell command generator for the SideX integrated terminal.\n")
	sb.WriteString("Convert the user's request into ONE shell command that runs in the ")
	sb.WriteString(osName)
	sb.WriteString(" terminal using ")
	sb.WriteString(shell)
	sb.WriteString(".\n")
	if req.Cwd != "" {
		sb.WriteString("Current working directory: ")
		sb.WriteString(req.Cwd)
		sb.WriteString("\n")
	}
	if strings.TrimSpace(req.Context) != "" {
		sb.WriteString("\nRecent terminal output (for context only):\n")
		sb.WriteString(trimTerminalContext(req.Context))
		sb.WriteString("\n")
	}
	sb.WriteString("\nRules:\n")
	sb.WriteString("- Output ONLY the command. No explanation, no markdown, no backticks, no leading prompt character.\n")
	sb.WriteString("- If several commands are needed, chain them with the shell's operators on a single line.\n")
	sb.WriteString("- Prefer safe, non-destructive commands; never invent destructive flags for a read-only request.\n")
	sb.WriteString("- Quote paths that contain spaces.\n")
	sb.WriteString("\nUser request: ")
	sb.WriteString(req.Instruction)
	return sb.String()
}

// trimTerminalContext bounds how much scrollback is sent so a noisy terminal
// cannot blow up the prompt. The tail is the useful part: it is what the user
// is looking at.
func trimTerminalContext(s string) string {
	const max = 4000
	s = strings.TrimRight(s, "\n")
	if len(s) <= max {
		return s
	}
	return "…" + s[len(s)-max:]
}
