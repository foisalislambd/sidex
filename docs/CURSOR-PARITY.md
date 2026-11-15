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
| 2 | Next-edit prediction | ✅ | **Partial** | `sidexComplete/browser/nextEditProvider.ts`, `POST /v1/next-edit`, `sidex.nextEdit.trigger` (`Ctrl/Cmd+Alt+K`) — predicts the next edit and offers it inline with `Tab` accept; it does **not** yet jump the cursor to a different file/location (see gaps) |
| 3 | `Cmd/Ctrl+K` inline edit with diff accept/reject | ✅ | **Done** | `contrib/sidexChat/browser/inline/*` |
| 4 | Chat panel (`Cmd/Ctrl+L`) | ✅ | **Done** | `contrib/sidexChat` (chat view, stream consumer) |
| 5 | `@` mentions: file / folder / codebase / selection / url / symbol | ✅ | **Done** | `sidexChat/browser/context/mentionResolver.ts` |
| 6 | Codebase indexing + semantic search | ✅ | **Done** | `crates/sidex-context`, `commands/index.rs`, indexing settings |
| 7 | Agent mode (multi-file edits + shell) | ✅ | **Done** | `sidexai/sidex-server`, `crates/sidex-agent` (40+ tools) |
| 8 | Multi-file plan / composer view | ✅ | **Partial** | `sidexChat/browser/orchestrator/*` |
| 9 | Checkpoints / revert & redo | ✅ | **Done** | `sidexChatService` `revertToMessage` / `redoCheckpoint` |
| 10 | Rules (`.cursorrules` equivalent) | ✅ | **Done** | `sidexChat/browser/settings/sections/rulesSection.ts` |
| 11 | MCP servers | ✅ | **Done** | `commands/mcp.rs`, tools settings |
| 12 | Model picker / bring-your-own key | ✅ | **Done** | `commands/providers.rs`, models settings |
| 13 | Permission prompts before tool runs | ✅ | **Done** | `components/messages/permissionRequest.ts` |
| 14 | Hooks | ✅ | **Done** | `commands/hooks.rs`, hooksSection |
| 15 | Skills / subagents | ✅ | **Done** | `crates/sidex-agent/src/skills.rs`, `subagentTypes.ts` |
| 16 | Web search / fetch tools | ✅ | **Done** | `sidex-agent` `web_search`, `web_fetch` |
| 17 | Image input + image generation | ✅ | **Done** | `image_read`, `image_gen` tools |
| 18 | Terminal `Cmd/Ctrl+K` (natural-language → command) | ✅ | **Done** | `terminalContrib/sidexAI`, server `/v1/terminal-command` |
| 19 | Review pass (changes → findings) | ✅ | **Done** | `POST /v1/review` (SSE, diff + untracked), `ISidexChatService.runReview()`, `sidex.reviewChanges` (`Ctrl/Cmd+Alt+R`), Review button in chat footer |
| 19b | Bugbot (hosted PR review product) | ✅ | **Missing** | — |
| 20 | Background / cloud agents | ✅ | **Partial** | `settings/sections/cloudAgentsSection.ts` |
| 21 | Auto-run policy (allow/deny lists) | ✅ | **Partial** | permission modes in chat service |
| 22 | `.sidexignore` / index + tool exclusions | ✅ | **Done** | `commands/index.rs` `collect_files` (also honours `.sidexindexingignore`), `sidex-agent` `grep` and glob walk (`--ignore-file`) |

## Next up (priority order)

1. **Terminal Cmd+K** — ✅ shipped. Press `Cmd/Ctrl+K` in the integrated
   terminal, describe the command, then Insert (leaves it on the prompt) or
   Run. Backed by `POST /v1/terminal-command`; the model never executes
   anything by itself.
2. **Next-edit prediction** — ✅ shipped as an inline edit offer. Aim `Tab` at
   the predicted edit site, or run `sidex.nextEdit.trigger`. Backed by
   `POST /v1/next-edit`.
3. **Review pass** — ✅ shipped. `sidex.reviewChanges` (or the Review button in
   the chat footer) streams findings from `POST /v1/review` over the current
   diff plus untracked files.
4. **Cross-file tab jump** — Cursor moves the cursor to a predicted edit in a
   *different* file and shows a diff preview there. SideX's provider only offers
   edits inside the active file. Needs a navigation provider + peek widget.
5. **Computer use / browser automation** — screenshot-driven UI actions.
6. **Bugbot** — hosted PR review as a product surface (triage state, comments
   posted to the PR).
7. **Cloud agents** — remote execution with the repo checked out server-side.

## Known limitations

- Next-edit is inline-completion based; it cannot move focus between files.
- Review runs on the local diff only — no PR context, no per-finding
  apply/dismiss actions yet.
- `.sidexignore` is honoured by indexing, `grep` and glob, but not yet by
  every agent tool (direct `read_file`/`edit_file` on an explicitly named path
  still works, matching Cursor's behaviour of not blocking explicit paths).


## How to verify a claim

- Frontend feature code: `src/vs/workbench/contrib/sidexChat`, `sidexComplete`.
- Rust command surface: `src-tauri/src/lib.rs` (source of truth).
- Agent tools: `crates/sidex-agent/src/tools/mod.rs` `dispatch()`.
- Server endpoints: `sidexai/sidex-server/` — `/v1/terminal-command`,
  `/v1/next-edit`, `/v1/review` (SSE).
- Which Cursor features exist at all: `work/REA-CURSOR-3.30.14.md` (REA
  evidence from the shipped 3.30.14 artifacts).
