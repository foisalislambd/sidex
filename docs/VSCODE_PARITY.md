# SideX and VS Code parity

SideX is a port of [Code - OSS](https://github.com/microsoft/vscode) (MIT) onto [Tauri](https://tauri.app/). The TypeScript workbench and Monaco editor are in `src/vs`. Electron's main process is the Rust backend in `src-tauri` and `crates/`. This document is the honest status of that port against VS Code's major feature areas.

It is not a claim that SideX matches VS Code. Statuses below were taken from what is actually registered and implemented in this tree, not from the README's short "what's working" list.

SideX does not use the Visual Studio Code name, logo, or the proprietary extension Marketplace. Extension install goes to [Open VSX](https://open-vsx.org/).

## Strategy

Keep building on this Tauri port. Do not throw it out for a fresh Electron fork of `microsoft/vscode`, and do not restart the editor as a Monaco-only shell.

- A stock Code - OSS fork is still Electron. The reason this project exists is to run the same workbench on the system webview.
- The workbench, editor contributions, terminal, Git UI, settings, and keybindings are already in the tree. Replacing them would discard the Tauri IPC layer, the Rust services, and the local agent.
- Contributions that were replaced with stubs (notebooks, comments, merge editor, call hierarchy, type hierarchy, custom editors) should be brought back from Code - OSS, license headers intact, when that is less risky than rewriting them.
- Where SideX already has a real Rust service (terminal PTY, file search, Git, LSP client, DAP process spawn, updater), keep it and wire it through to the workbench instead of reintroducing Node.

The ordering at the bottom of this file is the recommended sequence for closing the remaining gaps.

## Status key

| Status | Meaning |
|---|---|
| Present | The feature works in the running workbench. It is either the Code - OSS implementation, registered and loaded, or a SideX equivalent with the same user-facing behavior. |
| Partial | Real code is loaded, but a known slice is missing, disabled, or only works on a SideX-specific path. |
| Stub | The module exists so imports type-check, and the behavior is a no-op or an empty model. |
| Missing | There is no implementation. |

## Feature matrix

| Area | Status | What is in the tree |
|---|---|---|
| Editor core (Monaco: buffer, undo, folding, find, hover, formatting, bracket matching, sticky scroll, inlay hints, linked editing) | Present | `src/vs/editor` is loaded from `editor.all.ts`. The standalone Monaco build is not used; the workbench hosts the editor directly. |
| Semantic highlighting | Partial | The semantic-token contribution was removed (`editor.all.ts` notes it was disabled because scrolling lagged). TextMate / vscode-textmate grammars still colorize. |
| Multi-file tabs and split editors | Present | Editor parts and groups are the Code - OSS implementation (`browser/parts/editor`). |
| File explorer (open folder, create, rename, delete, drag and drop) | Present | `contrib/files`, with file I/O going through the Tauri filesystem instead of Node or the browser File System Access API. |
| Search and replace across files | Present | Search view is loaded. Text search and file search have Rust commands (`search_files`, `search_text`) plus the in-workbench search UI. |
| Command palette and quick open | Present | Quick input and quick access contributions are loaded. |
| Keybindings, including the keybindings editor | Present | Keybinding service, keybinding editing, and `contrib/keybindings` are loaded. Chord keybindings work through the same registry. |
| Settings UI and `settings.json` | Present | Preferences editor, JSON editing, and the configuration registry are loaded. SideX settings such as `emmet.*` register into that same UI. |
| Themes (workbench colors, token colors, icon themes) | Present | Workbench theme service plus `contrib/themes`. Several built-in themes ship with the port. Product icon themes are thinner than upstream. |
| Integrated terminal | Present | xterm.js UI and a Rust PTY (`portable-pty`): spawn, resize, signals, shell detection. Shell integration scripts live under `src-tauri/shell-integration`. |
| Source control / Git | Present | SCM view and Git commands: status, diff, log, stage, commit, branches, push, pull, fetch, stash, reset, clone. This is the built-in Git story, not every third-party SCM provider. |
| Debugger (DAP) | Partial | The debug view, breakpoints, call stack, and REPL UI are the Code - OSS contributions. Rust can spawn an adapter and speak the DAP wire protocol (`debug_spawn_adapter`). A full debug session still depends on an adapter being installed and on the extension host launching it the way VS Code does. |
| Language features (IntelliSense, go to definition, hover, diagnostics, formatting, rename) | Partial | Monaco language features are loaded. A Rust LSP client (`crates/sidex-lsp`, `commands/lsp.rs`) and the extension-host bridge both provide completions, hover, definition, symbols, and formatting. Call hierarchy and type hierarchy UI are stubs. Semantic tokens are disabled (see above). |
| Problems panel | Present | Markers view is loaded and fed by the marker service. |
| Outline | Present | Outline service and document-symbol contribution are loaded. |
| Minimap | Present | Monaco's minimap, including the `editor.minimap` settings. |
| Multi-cursor | Present | `editor/contrib/multicursor` is loaded. |
| Snippets | Present | Snippet service, tab stops, insert snippet, surround-with, and file-template snippets are loaded. |
| Emmet | Partial | Built in this tree (`contrib/emmet`): HTML / JSX / CSS abbreviation expand, Tab to expand, wrap with abbreviation, balance in/out, `!` boilerplate, implicit tag names, numbering, and the `emmet.*` settings. It is not the full Emmet library (no vendor-prefix fuzzy engine, no interactive wrap preview, no every upstream CSS snippet). |
| Extensions API, extension host, Open VSX | Partial | Open VSX install is implemented. `tauriExtensionHost.contribution.ts` bridges a large part of the extension API (language features, tree views, terminals, webviews, commands) to a WASM / platform host. The host is not the full Node extension host VS Code extensions expect, and many proposed APIs are absent. `src/vscode-dts/vscode.d.ts` is present as the type surface. |
| Tasks and problem matchers | Partial | The tasks contribution is loaded, and `crates/sidex-tasks` parses `tasks.json` and detects npm, Cargo, and Make tasks. Auto-detection and problem matchers are not at full VS Code coverage. |
| Output panel | Present | Output view contribution is loaded. |
| Webviews and Markdown preview | Partial | Webview panels and views are loaded. Markdown preview renders with `marked`, rewrites local images, refreshes on edit, can lock to a file or follow the active editor, and can switch script execution off or on. "Find all references" from the preview is not implemented. |
| Workspace trust | Partial | The Code - OSS trust service, editor, and startup prompt are loaded (`contrib/workspace`). A separate Rust trust model exists in `crates/sidex-workspace` and is not the service the workbench consults. |
| Remote development (SSH, containers, tunnels) | Partial | Remote contribution and `crates/sidex-remote` (SSH, Docker client) exist. This is not VS Code's full remote-extension story (no Codespaces, no complete remote extension host). |
| Notebooks | Stub | Notebook services in `sidexNullServices.ts` are empty. `contrib/notebook` keeps type stubs so the extension API compiles. There is no notebook editor. |
| Merge editor | Stub | `mergeEditorInput.ts` is a stub. |
| Multi-diff editor | Stub | Input stub only. |
| Comments and review threads | Stub | Comment service, view, and controller are stubs. |
| Call hierarchy and type hierarchy | Stub | Type stubs only. The UI is not registered. |
| Custom editors | Stub | Custom editor input and service are stubs. Image preview is a real contribution and is separate from this. |
| Interactive window / REPL editor | Stub | Input stub. The debug REPL is separate and is loaded. |
| Testing UI | Partial | The testing contribution and explorer are in the tree. They need an extension host that implements the test API before they do anything useful. |
| Accessibility | Partial | Accessibility signals are loaded. `IAccessibleViewService` is a null stub, so the accessible view (the screen-reader overlay upstream uses for hovers, notifications, and terminal output) does not run. |
| Internationalization | Partial | `nls.ts` and the display-language command are loaded. SideX does not ship language packs, so the UI is English unless a pack is installed and the host loads it. |
| Auto-update | Partial | `crates/sidex-update` implements check, download, and per-OS install, and the workbench has an update contribution. There is no public update feed or shipped binaries yet, so end users cannot receive an update. |
| Profiles | Partial | `crates/sidex-profiles` and profile commands exist. Import/export of a full VS Code profile is not guaranteed. |
| Workspace multi-root | Present | Code - OSS workspace editing is loaded, including the trust hand-off when a folder is added. |
| Local AI agent | Present (SideX-only) | Not a VS Code feature. Chat, inline edits, and shell tools run against a loopback Go server (`sidexai/sidex-server`) with the user's own model provider. No SideX account. |
| Accounts, sync, and issue reporter | Stub | User-data sync and the default account are null stubs. The issue reporter is a no-op. These are tied to Microsoft services upstream and are intentionally not required for the editor. |

## What landed with the parity doc

Emmet was missing (no `contrib/emmet` directory). It is now a real editor feature:

- Abbreviation engine for HTML, JSX, and CSS, with tests in `tests/emmet/expand.test.ts` (`npm run test:emmet`).
- Commands: **Emmet: Expand Abbreviation**, **Emmet: Wrap with Abbreviation**, **Emmet: Balance (Outward)**, **Emmet: Balance (Inward)**.
- Tab expands an abbreviation when `emmet.triggerExpansionOnTab` is true (the default). Suggestions, snippet placeholders, and inline completions still take Tab while they are active.
- Settings: `emmet.triggerExpansionOnTab`, `emmet.includeLanguages`, `emmet.excludeLanguages`, `emmet.variables`.

Markdown preview commands that were empty callbacks now do something: show source, refresh, toggle lock (follow the active Markdown editor when unlocked), reopen as preview or source, and a strict / allow-scripts security choice. Find-all-references from the preview is still not implemented.

## Still missing, in the order to do them

1. **Extension host that runs real Open VSX extensions.** This is the gap that blocks everything else users mean by "a VS Code alternative": language servers shipped as extensions, debuggers, themes, and grammars. Finish the Node-compatible extension host (or a documented, tested subset of `vscode.d.ts`) and activate installed extensions without a manual bridge per API.
2. **One real debug session.** Pick a DAP adapter (for example Node or LLDB), launch it from a `launch.json`, stop on a breakpoint, step, and show variables. The UI and the process spawn already exist; they need to meet.
3. **Put semantic tokens back, without the scroll jank.** The contribution was deleted rather than fixed. Restore it behind a setting, or fix the decoration path, and add a regression check that scrolling a large file stays responsive.
4. **Notebook editor.** Replace the null notebook services with the Code - OSS notebook contribution (MIT, keep the license header) or an explicitly smaller editor that opens `.ipynb`, runs a kernel, and shows outputs.
5. **Merge editor, comments, call hierarchy, type hierarchy, custom editors.** These are stubs. Re-import the upstream contributions instead of growing the stubs.
6. **Remote development that can open one SSH folder end to end.** The crate and the view exist; the file system, terminal, and extension host have to run against that remote.
7. **Accessibility view and a shipped language pack.** Replace `NullAccessibleViewService`. Wire one non-English language pack through `nls` so the display-language command changes the shell.
8. **An update feed.** The updater code is in place; it needs a signed manifest URL and a release build to download.
9. **Finish Emmet toward the upstream library.** Vendor prefixes, the remaining CSS fuzzy snippets, wrap-with-abbreviation live preview, and the abbreviation inside `<style>` regions of an HTML file.

Each of those should land as working code with tests, the way Emmet did, and this matrix should be updated in the same change.
