# SideX ↔ Cursor Feature Parity

This document tracks how SideX's built-in AI features compare with Cursor's,
and where the remaining gaps are. It is an honest status board, not a marketing
page: an item is only marked **Done** when the code path exists in this repo.

> No Cursor code, assets, or branding is used anywhere in SideX. Cursor is a
> proprietary product; SideX is an independent MIT port of VS Code (Code - OSS)
> with its own AI layer. Feature *ideas* are not copyrightable — implementations
> here are original.

Legend: **Done** = implemented · **Partial** = basics work, edges missing ·
**Missing** = not implemented yet.

| # | Feature | Cursor | SideX | Where |
|---|---------|--------|-------|-------|
| 1 | Tab autocomplete (multi-line, FIM) | ✅ | **Done** | `contrib/sidexComplete` (contextEngine, confidenceScorer, postProcessor, recentEditTracker) |
| 2 | Next-edit prediction | ✅ | **Partial** | `sidexComplete/browser/nextEditProvider.ts`, `POST /v1/next-edit`, `sidex.nextEdit.trigger` (`Ctrl/Cmd+Alt+K`) — inline edit with Tab accept; cross-file jumps show hint/snippet+hover and status-bar affordance. First Tab/trigger navigates and **previews** at target (range highlight, gutter, inline ghost replacement preview + “Tab to apply”), second Tab commits, Esc dismisses. Still short of Cursor's full native inline-diff/peek rendering. |
| 3 | `Cmd/Ctrl+K` inline edit with diff accept/reject | ✅ | **Done** | `contrib/sidexChat/browser/inline/*` |
| 4 | Chat panel (`Cmd/Ctrl+L`) | ✅ | **Done** | `contrib/sidexChat` (chat view, stream consumer) |
| 5 | `@` mentions: file / folder / codebase / selection / git diff / status / url / symbol / notepads | ✅ | **Done** | `sidexChat/browser/context/mentionResolver.ts`, `/v1/git-diff`, `/v1/git-status` (`@git`, `@diff`, `@changes`, `@selection`, `@notepad` from `.sidex/notepads/*.md`) |
| 6 | Codebase indexing + semantic search | ✅ | **Done** | `crates/sidex-context`, `commands/index.rs`, indexing settings |
| 7 | Agent mode (multi-file edits + shell) | ✅ | **Done** | `sidexai/sidex-server`, `crates/sidex-agent` (40+ tools) |
| 8 | Multi-file plan / composer view | ✅ | **Partial** | `sidexChat/browser/orchestrator/*` |
| 9 | Checkpoints / revert & redo | ✅ | **Done** | `sidexChatService` `revertToMessage` / `redoCheckpoint` |
| 10 | Rules (`.cursorrules` equivalent) | ✅ | **Done** | `sidexChat/browser/settings/sections/rulesSection.ts` |
| 11 | MCP servers | ✅ | **Done** | `commands/mcp.rs`, tools settings |
| 12 | Model picker / bring-your-own key | ✅ | **Done** | `commands/providers.rs`, models settings |
| 13 | Permission prompts before tool runs | ✅ | **Done** | `components/messages/permissionRequest.ts` (clear labels/descriptions for shell, edits, browser/computer-use actions) |
| 14 | Hooks | ✅ | **Done** | `commands/hooks.rs`, hooksSection |
| 15 | Skills / subagents | ✅ | **Done** | `crates/sidex-agent/src/skills.rs`, `subagentTypes.ts` |
| 16 | Web search / fetch tools | ✅ | **Done** | `sidex-agent` `web_search`, `web_fetch` |
| 17 | Image input + image generation | ✅ | **Done** | `image_read`, `image_gen` tools |
| 18 | Terminal `Cmd/Ctrl+K` (natural-language → command) | ✅ | **Done** | `terminalContrib/sidexAI`, server `/v1/terminal-command` |
| 19 | Review pass (changes → findings) | ✅ | **Done** | `POST /v1/review` (`format:"markdown"` or `"findings"` SSE: `diff_stats/summary/finding`), `ISidexChatService.runReview()`, structured finding cards in chat with **go-to file:line, Fix with agent, Dismiss/Restore**, `sidex.reviewChanges` (`Ctrl/Cmd+Alt+R`) |
| 19b | Bugbot (hosted PR review product) | ✅ | **Partial** | Local diff review now has structured findings + per-finding triage/fix actions; Cursor Bugbot also adds hosted PR integration, PR comments, deep-review/severity modes and backend autofix flows — hosted parts not reproduced |
| 19c | Generate commit message | ✅ | **Done** | `POST /v1/commit-message`, `sidex.generateCommitMessage` (`Ctrl/Cmd+Shift+M`) writes the suggestion into the active SCM input |
| 20 | Background / cloud agents | ✅ | **Partial** | UI/settings present (`cloudAgentsSection.ts`); no local background-runtime equivalent to Cursor's hosted cloud agents yet |
| 21 | Auto-run policy (allow/deny lists) | ✅ | **Partial** | permission modes in chat service |
| 22 | `.cursorignore` / index + tool exclusions | ✅ | **Done** | `commands/index.rs` `collect_files` (honours `.gitignore`, `.cursorindexingignore`, `.cursorignore`), `sidex-agent` `grep` and glob walk |
| 23 | Computer use / browser automation | ✅ | **Partial** | Tauri `browser_*` commands exposed as local agent tools (`browser_navigate/screenshot/click/type/read/scroll/console/eval/close`) via server schemas + `LocalExecTools` + Tauri `agent_execute_tool` dispatch; permission UI labels actions. Missing Cursor-level dedicated computer-use preview, richer snapshots/policy and Playwright-grade semantics. |
| 24 | Shadow workspace | ✅ | **Partial** | Local speculative-edit sandbox via detached git worktrees: server `/v1/shadow/{create,diff,apply,discard,list}` (`shadow.go`) with conflict-safe apply + tests, and commands `sidex.shadowWorkspace.{start,apply,discard}`. Not yet integrated as an automatic agent execution mode. |
| 25 | Memories / notepads | ✅ | **Partial** | Server memories CRUD (`GET/POST /v1/memory`, `DELETE /v1/memory/{id}`) and auto-recall/learn; **Memories & Notepads** settings UI (`memoriesSection.ts`) to add/delete memories and create/edit/delete workspace notepads (`.sidex/notepads/*.md`), plus `@notepad` mention resolution. Not identical to Cursor's full synced memories/product UX. |

## Next up (remaining gaps)

1. **Next-edit / Tab parity** — staged cross-file jump preview (peek-before-commit) is shipped, but Cursor's native inline-diff/ghost rendering at the remote target and richer suggestion UX are still missing.
2. **Computer use / browser automation** — basic agent tools + permission labels are wired; still need Cursor-level computer-use preview, richer snapshots/actions/policy, and safer automation UX.
3. **Bugbot / hosted review parity** — local structured findings with go-to/fix/dismiss exist; remaining hosted/backend pieces: PR integration, PR comments, deep-review modes, and backend autofix/triage.
4. **Shadow workspace** — local worktree sandbox + apply/discard commands exist; integrate as an automatic speculative execution mode for agent edits (like Cursor) instead of manual-only.
5. **Memories / notepads** — CRUD/UI/mentions exist locally; remaining parity is product polish and any synced/hosted behavior Cursor provides.
6. **Background / cloud agents** — local background/worktree runtime and any hosted checkout/streaming parity (backend-dependent).
7. **Composer/multi-file plan UX** — richer plan/composer parity and edge cases.

## Known limitations

- Next-edit cross-file jumps use a staged flow (hint → preview at target with
  highlighted range, inline ghost replacement preview + Tab-to-apply → commit,
  Esc to dismiss). This is closer to Cursor but still not identical to its
  native inline-diff/peek rendering and suggestion UX.
- Local review now emits structured findings with go-to/fix/dismiss triage, but
  it is still diff-only: no PR metadata, no inline PR comments, and hosted
  Bugbot/deep-review/autofix flows require Cursor's backend.
- `.cursorignore` is honoured by indexing, `grep` and glob, but not yet by
  every agent tool (direct `read_file`/`edit_file` on an explicitly named path
  still works, matching Cursor's behaviour of not blocking explicit paths).
- Computer use/browser automation tools are wired for local agent execution, but
  lack Cursor's dedicated computer-use preview, richer snapshots/actions/policy,
  and Playwright-grade semantics.
- Shadow workspaces, memories/notepads, and cloud/background agents are
  available only as local/partial equivalents; hosted behaviours (PR Bugbot,
  cloud execution, synced memories) depend on Cursor's backend.


## How to verify a claim

- Frontend feature code: `src/vs/workbench/contrib/sidexChat`, `sidexComplete`.
- Rust command surface: `src-tauri/src/lib.rs` (source of truth).
- Agent tools: `crates/sidex-agent/src/tools/mod.rs` `dispatch()`.
- Server endpoints: `sidexai/sidex-server/` — `/v1/terminal-command`,
  `/v1/next-edit`, `/v1/review` (SSE), `/v1/commit-message`,
  `/v1/git-diff`, `/v1/git-status`, `/v1/memory` (+ `DELETE /v1/memory/{id}`),
  `/v1/shadow/{create,diff,apply,discard,list}`.
- Which Cursor features exist at all: `work/REA-CURSOR-3.30.14.md` (REA
  evidence from the shipped 3.30.14 artifacts, including session-2 deep
  follow-up).
