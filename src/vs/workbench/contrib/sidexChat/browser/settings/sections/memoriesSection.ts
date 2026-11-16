/*---------------------------------------------------------------------------------------------
 *  Memories & Notepads section for SideX Settings.
 *
 *  Two related surfaces:
 *   - Memories: durable facts the agent learned (or the user pinned) about the
 *     project/user, stored server-side (`GET/POST /v1/memory`, `DELETE /v1/memory/{id}`)
 *     and recalled into the system prompt on later turns.
 *   - Notepads: workspace markdown scratchpads under `.sidex/notepads/*.md` that
 *     live in the repo and can be referenced from chat.
 *
 *  Both are editable inline here: the settings modal has no editor service, so
 *  opening a notepad in a textarea keeps the flow self-contained.
 *--------------------------------------------------------------------------------------------*/

import type { SettingsSection } from '../sidexSettingsPanel.js';
import { resolveServerEndpoint, serverHttpUrl } from '../../localServer.js';

type TauriInvoke = ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null;

interface MemoryEntry {
	id: string;
	key: string;
	value: string;
	tags?: string[];
	created_at?: string;
	access_count?: number;
}

interface NotepadEntry {
	name: string;
	path: string;
}

const NOTEBOOK_DIR = '.sidex/notepads';

export class MemoriesSection implements SettingsSection {
	private _invoke: TauriInvoke;
	private _root: HTMLElement | null = null;
	private _tab: 'memories' | 'notepads' = 'memories';
	private _workspacePath = '.';
	private _memories: MemoryEntry[] = [];
	private _notepads: NotepadEntry[] = [];
	private _activeNotepad: string | null = null;
	private _body: HTMLElement | null = null;

	constructor(invoke: TauriInvoke) {
		this._invoke = invoke;
	}

	async render(container: HTMLElement): Promise<void> {
		this._root = container;
		container.innerHTML = '';

		const title = document.createElement('div');
		title.className = 'sidex-settings-section-title';
		title.textContent = 'Memories & Notepads';
		container.appendChild(title);

		const desc = document.createElement('div');
		desc.className = 'sidex-settings-row-description sidex-settings-section-desc';
		desc.textContent = 'Durable project knowledge the agent recalls, and scratchpads stored in your repo';
		container.appendChild(desc);

		if (this._invoke) {
			try {
				const env = await this._invoke('get_env', { name: 'SIDEX_WORKSPACE' }) as string | null;
				if (env) { this._workspacePath = env; }
			} catch { /* keep default */ }
		}

		container.appendChild(this._buildTabs());

		this._body = document.createElement('div');
		this._body.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:10px;';
		container.appendChild(this._body);

		await this._renderTab();
	}

	dispose(): void {
		this._root = null;
		this._body = null;
	}

	private _buildTabs(): HTMLElement {
		const tabs = document.createElement('div');
		tabs.style.cssText = 'display:flex;gap:4px;border-bottom:1px solid var(--vscode-widget-border, rgba(255,255,255,0.1));padding-bottom:6px;';

		const make = (id: 'memories' | 'notepads', label: string) => {
			const btn = document.createElement('button');
			btn.textContent = label;
			btn.style.cssText = 'background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;color:var(--vscode-foreground);';
			if (this._tab === id) {
				btn.style.background = 'var(--vscode-button-background)';
				btn.style.color = 'var(--vscode-button-foreground)';
			}
			btn.addEventListener('click', () => {
				if (this._tab === id) { return; }
				this._tab = id;
				if (this._root) {
					const first = this._root.querySelector('div:last-of-type');
					void first;
				}
				// Rebuild tabs to reflect the active state without a full rerender.
				const parent = tabs.parentElement;
				if (parent) {
					parent.replaceChild(this._buildTabs(), tabs);
				}
				void this._renderTab();
			});
			tabs.appendChild(btn);
		};

		make('memories', 'Memories');
		make('notepads', 'Notepads');
		return tabs;
	}

	private async _renderTab(): Promise<void> {
		if (!this._body) { return; }
		this._body.innerHTML = '';
		if (this._tab === 'memories') {
			await this._renderMemories(this._body);
		} else {
			await this._renderNotepads(this._body);
		}
	}

	// ── Memories ────────────────────────────────────────────────────────────

	private async _renderMemories(host: HTMLElement): Promise<void> {
		const addCard = this._card(host);
		const heading = document.createElement('div');
		heading.className = 'sidex-settings-row-title';
		heading.textContent = 'Add a memory';
		addCard.appendChild(heading);

		const row = document.createElement('div');
		row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;';
		const keyInput = this._input(row, 'Key, e.g. test-command');
		const valueInput = this._input(row, 'Value, e.g. run `go test ./...` before pushing');
		const addBtn = document.createElement('button');
		addBtn.textContent = 'Save';
		addBtn.style.cssText = 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';
		addBtn.addEventListener('click', async () => {
			const key = keyInput.value.trim();
			const value = valueInput.value.trim();
			if (!key || !value) {
				this._note(host, 'Both a key and a value are required.', true);
				return;
			}
			const ok = await this._saveMemory(key, value);
			if (ok) {
				keyInput.value = '';
				valueInput.value = '';
				await this._renderTab();
			} else {
				this._note(host, 'Could not save the memory — is the local server running?', true);
			}
		});
		row.appendChild(addBtn);

		const list = this._card(host);
		const listHeading = document.createElement('div');
		listHeading.className = 'sidex-settings-row-title';
		list.appendChild(listHeading);

		await this._loadMemories();
		listHeading.textContent = `Saved memories (${this._memories.length})`;

		if (this._memories.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sidex-settings-row-description';
			empty.textContent = 'Nothing remembered yet. The agent also stores facts automatically as it works.';
			list.appendChild(empty);
			return;
		}

		for (const memory of this._memories) {
			const item = document.createElement('div');
			item.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-top:1px solid var(--vscode-widget-border, rgba(255,255,255,0.06));';

			const text = document.createElement('div');
			text.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';
			const keyEl = document.createElement('div');
			keyEl.style.cssText = 'font-size:12px;font-weight:600;';
			keyEl.textContent = memory.key;
			const valueEl = document.createElement('div');
			valueEl.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);white-space:pre-wrap;overflow-wrap:break-word;';
			valueEl.textContent = memory.value;
			text.appendChild(keyEl);
			text.appendChild(valueEl);
			if (memory.tags && memory.tags.length) {
				const tags = document.createElement('div');
				tags.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.8;';
				tags.textContent = memory.tags.map(t => `#${t}`).join(' ');
				text.appendChild(tags);
			}

			const del = document.createElement('button');
			del.textContent = 'Delete';
			del.style.cssText = 'background:transparent;border:1px solid var(--vscode-widget-border);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;color:var(--vscode-foreground);';
			del.addEventListener('click', async () => {
				const ok = await this._deleteMemory(memory.id);
				if (ok) {
					await this._renderTab();
				} else {
					this._note(host, 'Could not delete the memory.', true);
				}
			});

			item.appendChild(text);
			item.appendChild(del);
			list.appendChild(item);
		}
	}

	private async _loadMemories(): Promise<void> {
		this._memories = [];
		try {
			await resolveServerEndpoint();
			const resp = await fetch(`${serverHttpUrl(undefined)}/v1/memory`, { method: 'GET' });
			if (!resp.ok) { return; }
			const data = await resp.json() as MemoryEntry[] | null;
			if (Array.isArray(data)) {
				this._memories = data
					.filter(m => !!m && typeof m.id === 'string')
					.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
			}
		} catch { /* server not running: leave the list empty */ }
	}

	private async _saveMemory(key: string, value: string): Promise<boolean> {
		try {
			await resolveServerEndpoint();
			const resp = await fetch(`${serverHttpUrl(undefined)}/v1/memory`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ key, value, tags: [] }),
			});
			return resp.ok;
		} catch {
			return false;
		}
	}

	private async _deleteMemory(id: string): Promise<boolean> {
		try {
			await resolveServerEndpoint();
			const resp = await fetch(`${serverHttpUrl(undefined)}/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
			return resp.ok;
		} catch {
			return false;
		}
	}

	// ── Notepads ────────────────────────────────────────────────────────────

	private async _renderNotepads(host: HTMLElement): Promise<void> {
		const card = this._card(host);
		const heading = document.createElement('div');
		heading.className = 'sidex-settings-row-title';
		heading.textContent = 'Workspace notepads';
		card.appendChild(heading);

		const hint = document.createElement('div');
		hint.className = 'sidex-settings-row-description';
		hint.textContent = `Markdown scratchpads in ${NOTEBOOK_DIR}/ — reference them from chat with @notepad.`;
		card.appendChild(hint);

		await this._loadNotepads();

		const row = document.createElement('div');
		row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;';
		const nameInput = this._input(row, 'New notepad name');
		const createBtn = document.createElement('button');
		createBtn.textContent = 'Create';
		createBtn.style.cssText = 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';
		createBtn.addEventListener('click', async () => {
			const raw = nameInput.value.trim();
			if (!raw) {
				this._note(host, 'Enter a name for the notepad.', true);
				return;
			}
			const slug = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
			if (!slug) {
				this._note(host, 'That name has no usable characters.', true);
				return;
			}
			const fileName = slug.endsWith('.md') ? slug : `${slug}.md`;
			const ok = await this._writeNotepad(fileName, `# ${raw}\n\n`);
			if (ok) {
				this._activeNotepad = fileName;
				await this._renderTab();
			} else {
				this._note(host, 'Could not create the notepad.', true);
			}
		});
		card.appendChild(row);

		if (this._notepads.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'sidex-settings-row-description';
			empty.style.marginTop = '8px';
			empty.textContent = 'No notepads yet.';
			card.appendChild(empty);
			return;
		}

		const listRow = document.createElement('div');
		listRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;';
		for (const pad of this._notepads) {
			const chip = document.createElement('button');
			chip.textContent = pad.name.replace(/\.md$/, '');
			chip.style.cssText = 'background:' + (this._activeNotepad === pad.name ? 'var(--vscode-button-background)' : 'transparent') + ';color:' + (this._activeNotepad === pad.name ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)') + ';border:1px solid var(--vscode-widget-border);border-radius:12px;padding:3px 10px;cursor:pointer;font-size:11px;';
			chip.addEventListener('click', () => {
				this._activeNotepad = pad.name;
				void this._renderTab();
			});
			listRow.appendChild(chip);
		}
		card.appendChild(listRow);

		if (!this._activeNotepad) {
			return;
		}

		const editorCard = this._card(host);
		const editorHead = document.createElement('div');
		editorHead.style.cssText = 'display:flex;align-items:center;gap:8px;';
		const editorTitle = document.createElement('div');
		editorTitle.className = 'sidex-settings-row-title';
		editorTitle.style.flex = '1';
		editorTitle.textContent = this._activeNotepad;
		editorHead.appendChild(editorTitle);

		const saveBtn = document.createElement('button');
		saveBtn.textContent = 'Save';
		saveBtn.style.cssText = 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;';
		const delBtn = document.createElement('button');
		delBtn.textContent = 'Delete';
		delBtn.style.cssText = 'background:transparent;border:1px solid var(--vscode-widget-border);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;color:var(--vscode-foreground);';
		editorHead.appendChild(saveBtn);
		editorHead.appendChild(delBtn);
		editorCard.appendChild(editorHead);

		const textarea = document.createElement('textarea');
		textarea.style.cssText = 'width:100%;min-height:220px;margin-top:8px;padding:8px;border-radius:4px;border:1px solid var(--vscode-widget-border);background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family, monospace);font-size:12px;resize:vertical;';
		textarea.value = await this._readNotepad(this._activeNotepad);
		editorCard.appendChild(textarea);

		saveBtn.addEventListener('click', async () => {
			const name = this._activeNotepad;
			if (!name) { return; }
			const ok = await this._writeNotepad(name, textarea.value);
			this._note(editorCard, ok ? 'Saved.' : 'Could not save the notepad.', !ok);
		});

		delBtn.addEventListener('click', async () => {
			const name = this._activeNotepad;
			if (!name) { return; }
			if (!this._invoke) { return; }
			try {
				await this._invoke('remove', { path: this._notePath(name), recursive: false });
				this._activeNotepad = null;
				await this._renderTab();
			} catch {
				this._note(editorCard, 'Could not delete the notepad.', true);
			}
		});
	}

	private async _loadNotepads(): Promise<void> {
		this._notepads = [];
		if (!this._invoke) { return; }
		try {
			const raw = await this._invoke('read_dir', { path: this._noteDir() }) as { entries?: { name: string; is_dir: boolean }[] } | { name: string; is_dir: boolean }[] | null;
			const entries = Array.isArray(raw) ? raw : (raw?.entries ?? []);
			this._notepads = entries
				.filter(e => !e.is_dir && e.name.endsWith('.md'))
				.map(e => ({ name: e.name, path: this._notePath(e.name) }))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch { /* directory does not exist yet */ }
	}

	private _noteDir(): string {
		return `${this._workspacePath.replace(/[\\/]+$/, '')}/${NOTEBOOK_DIR}`;
	}

	private _notePath(name: string): string {
		return `${this._noteDir()}/${name}`;
	}

	private async _readNotepad(name: string): Promise<string> {
		if (!this._invoke) { return ''; }
		try {
			return await this._invoke('read_file', { path: this._notePath(name) }) as string ?? '';
		} catch {
			return '';
		}
	}

	private async _writeNotepad(name: string, content: string): Promise<boolean> {
		if (!this._invoke) { return false; }
		try {
			await this._invoke('mkdir', { path: this._noteDir(), recursive: true });
			await this._invoke('write_file', { path: this._notePath(name), content });
			return true;
		} catch {
			return false;
		}
	}

	// ── helpers ─────────────────────────────────────────────────────────────

	private _card(host: HTMLElement): HTMLElement {
		const card = document.createElement('div');
		card.className = 'sidex-settings-card';
		card.style.cssText = 'border:1px solid var(--vscode-widget-border, rgba(255,255,255,0.08));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:4px;';
		host.appendChild(card);
		return card;
	}

	private _input(parent: HTMLElement, placeholder: string): HTMLInputElement {
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = placeholder;
		input.style.cssText = 'flex:1;min-width:140px;padding:5px 8px;border-radius:4px;border:1px solid var(--vscode-widget-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:12px;';
		parent.appendChild(input);
		return input;
	}

	private _note(host: HTMLElement, message: string, isError: boolean): void {
		const existing = host.querySelector('.sc-memory-note');
		if (existing) { existing.remove(); }
		const note = document.createElement('div');
		note.className = 'sc-memory-note sidex-settings-row-description';
		note.style.cssText = `margin-top:4px;font-size:11px;color:${isError ? 'var(--vscode-errorForeground, #f14c4c)' : 'var(--vscode-descriptionForeground)'};`;
		note.textContent = message;
		host.appendChild(note);
		setTimeout(() => note.remove(), 4000);
	}
}
