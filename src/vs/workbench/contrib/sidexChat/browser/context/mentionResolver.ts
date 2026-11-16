/*---------------------------------------------------------------------------------------------
 *  MentionResolver — resolves @ mentions to file/folder/symbol content for Sidex Chat
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';

export type MentionType = 'file' | 'folder' | 'symbol' | 'url' | 'selection' | 'codebase' | 'gitDiff' | 'notepad';

export interface MentionItem {
	type: MentionType;
	label: string;
	detail?: string;
	fullPath?: string;
	content?: string;
	iconClass?: string;
}

interface IFileSystemProvider {
	findFiles(pattern: string, maxResults: number): Promise<URI[]>;
	readFile(uri: URI): Promise<string>;
	readDirectory(uri: URI): Promise<Array<[string, 'file' | 'directory']>>;
	getWorkspaceFolderPath(): string | undefined;
}

interface ICodebaseSearchProvider {
	search(query: string, limit: number, budget: number): Promise<string>;
}

interface IGitContextProvider {
	/** Working-tree diff (unstaged + staged) as unified diff text. */
	getDiff(): Promise<string>;
	/** Short status (porcelain-style text is fine). */
	getStatus(): Promise<string>;
}

const FILE_EXTENSIONS: Record<string, string> = {
	'.ts': 'TypeScript', '.tsx': 'TypeScript React', '.js': 'JavaScript',
	'.jsx': 'JavaScript React', '.rs': 'Rust', '.go': 'Go', '.py': 'Python',
	'.java': 'Java', '.c': 'C', '.cpp': 'C++', '.h': 'C Header',
	'.css': 'CSS', '.html': 'HTML', '.json': 'JSON', '.md': 'Markdown',
	'.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.sql': 'SQL',
	'.sh': 'Shell', '.bash': 'Shell', '.vue': 'Vue', '.svelte': 'Svelte',
};

const MAX_SUGGESTIONS = 10;
const MAX_FILE_LINES = 500;
const TREE_DEPTH = 2;

export class MentionResolver {
	private _fsProvider: IFileSystemProvider;
	private _codebaseProvider: ICodebaseSearchProvider | null;
	private _gitProvider: IGitContextProvider | null;

	constructor(fsProvider: IFileSystemProvider, codebaseProvider?: ICodebaseSearchProvider, gitProvider?: IGitContextProvider) {
		this._fsProvider = fsProvider;
		this._codebaseProvider = codebaseProvider ?? null;
		this._gitProvider = gitProvider ?? null;
	}

	async getSuggestions(query: string): Promise<MentionItem[]> {
		const trimmed = query.trim().toLowerCase();
		if (!trimmed) {
			return this._getDefaultSuggestions();
		}

		// Built-in context mentions (Cursor-style). Keep them cheap — no I/O
		// until the user actually selects one.
		const specials: MentionItem[] = [];
		if ('codebase'.startsWith(trimmed)) {
			specials.push({ type: 'codebase', label: 'codebase', detail: 'Search the entire indexed codebase', iconClass: 'codicon-search' });
		}
		if ('git'.startsWith(trimmed) || 'diff'.startsWith(trimmed) || 'changes'.startsWith(trimmed)) {
			specials.push({ type: 'gitDiff', label: 'git diff', detail: 'Current working-tree changes (staged and unstaged)', iconClass: 'codicon-git-compare', content: 'diff' });
			specials.push({ type: 'gitDiff', label: 'git status', detail: 'Current repository status', iconClass: 'codicon-source-control', content: 'status' });
		}
		if ('selection'.startsWith(trimmed)) {
			specials.push({ type: 'selection', label: 'selection', detail: 'The active editor selection', iconClass: 'codicon-selection' });
		}
		if ('notepad'.startsWith(trimmed) || 'notepads'.startsWith(trimmed) || trimmed === 'note') {
			specials.push(...await this._listNotepads());
		}
		if (specials.length > 0 && (trimmed === 'codebase' || trimmed === 'git' || trimmed === 'diff' || trimmed === 'changes' || trimmed === 'selection' || trimmed === 'note')) {
			return specials;
		}

		const isFileLike = trimmed.startsWith('/') || trimmed.includes('.') || trimmed.includes('/');
		const files = isFileLike ? await this._searchFiles(query.trim()) : await this._searchFiles(query.trim());
		if (specials.length === 0) {
			return files;
		}
		// Merge: keep special hits first, then files, deduped and capped.
		const merged = [...specials];
		for (const f of files) {
			if (!merged.some(m => m.type === f.type && m.label === f.label)) {
				merged.push(f);
			}
			if (merged.length >= MAX_SUGGESTIONS) { break; }
		}
		return merged.slice(0, MAX_SUGGESTIONS);
	}

	async resolve(item: MentionItem): Promise<string> {
		switch (item.type) {
			case 'file':
				return this._resolveFile(item);
			case 'folder':
				return this._resolveFolder(item);
			case 'codebase':
				return this._resolveCodebase(item);
			case 'gitDiff':
				return this._resolveGit(item);
			case 'selection':
				return item.content || '';
			case 'notepad':
				return this._resolveNotepad(item);
			case 'url':
				return `[URL: ${item.label}]`;
			case 'symbol':
				return item.content || `[Symbol: ${item.label}]`;
			default:
				return '';
		}
	}

	private async _resolveNotepad(item: MentionItem): Promise<string> {
		if (!item.fullPath) {
			return `[Notepad not found: ${item.label}]`;
		}
		try {
			const content = await this._fsProvider.readFile(URI.file(item.fullPath));
			const body = content.trim() ? content : '[Notepad is empty]';
			return `# Notepad: ${item.label}\n\n${body}`;
		} catch {
			return `[Could not read notepad: ${item.label}]`;
		}
	}

	/** Notepads live in `.sidex/notepads/*.md` inside the workspace. */
	private async _listNotepads(): Promise<MentionItem[]> {
		const root = this._fsProvider.getWorkspaceFolderPath();
		if (!root) {
			return [];
		}
		try {
			const dir = URI.file(`${root.replace(/[\\/]+$/, '')}/.sidex/notepads`);
			const entries = await this._fsProvider.readDirectory(dir);
			return entries
				.filter(([name, type]) => type === 'file' && name.endsWith('.md'))
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([name]) => ({
					type: 'notepad' as MentionType,
					label: name.replace(/\.md$/, ''),
					detail: 'Notepad',
					fullPath: `${root.replace(/[\\/]+$/, '')}/.sidex/notepads/${name}`,
					iconClass: 'codicon-notebook',
				}));
		} catch {
			return [];
		}
	}

	private async _resolveGit(item: MentionItem): Promise<string> {
		if (!this._gitProvider) {
			return '[Git context unavailable]';
		}
		try {
			if (item.content === 'status') {
				const status = await this._gitProvider.getStatus();
				return status || '[No git status output]';
			}
			const diff = await this._gitProvider.getDiff();
			return diff || '[Working tree is clean]';
		} catch (err) {
			return `[Could not read git state: ${String(err)}]`;
		}
	}

	async resolveCodebaseQuery(query: string, limit = 15, budget = 6000): Promise<string> {
		if (!this._codebaseProvider) {
			return '[Codebase search unavailable — no search provider configured]';
		}
		try {
			return await this._codebaseProvider.search(query, limit, budget);
		} catch {
			return '[Codebase search failed]';
		}
	}

	private async _resolveCodebase(item: MentionItem): Promise<string> {
		const query = item.content || item.detail || '';
		if (!query) {
			return '[No codebase search query provided]';
		}
		return this.resolveCodebaseQuery(query);
	}

	private async _getDefaultSuggestions(): Promise<MentionItem[]> {
		const items: MentionItem[] = [];

		// Suggest some common files from the workspace
		try {
			const uris = await this._fsProvider.findFiles('**/*', 15);
			for (const uri of uris.slice(0, MAX_SUGGESTIONS)) {
				const wsRoot = this._fsProvider.getWorkspaceFolderPath();
				const fullPath = uri.fsPath;
				const label = wsRoot ? fullPath.replace(wsRoot + '/', '') : fullPath;
				const ext = this._getExtension(label);
				items.push({
					type: 'file',
					label,
					detail: FILE_EXTENSIONS[ext] || 'File',
					fullPath,
					iconClass: 'codicon-file',
				});
			}
		} catch {
			// workspace APIs unavailable
		}

		return items;
	}

	private async _searchFiles(query: string): Promise<MentionItem[]> {
		const items: MentionItem[] = [];

		try {
			const glob = `**/*${query}*`;
			const uris = await this._fsProvider.findFiles(glob, 30);

			const wsRoot = this._fsProvider.getWorkspaceFolderPath();

			for (const uri of uris) {
				const fullPath = uri.fsPath;
				const label = wsRoot ? fullPath.replace(wsRoot + '/', '') : fullPath;
				const ext = this._getExtension(label);

				const isDir = !ext;
				items.push({
					type: isDir ? 'folder' : 'file',
					label,
					detail: isDir ? 'Folder' : (FILE_EXTENSIONS[ext] || 'File'),
					fullPath,
					iconClass: isDir ? 'codicon-folder' : 'codicon-file',
				});

				if (items.length >= MAX_SUGGESTIONS) { break; }
			}
		} catch {
			// search failed
		}

		return items;
	}

	private async _resolveFile(item: MentionItem): Promise<string> {
		if (!item.fullPath) { return ''; }

		try {
			const uri = URI.file(item.fullPath);
			const content = await this._fsProvider.readFile(uri);
			const lines = content.split('\n');

			if (lines.length <= MAX_FILE_LINES) {
				return content;
			}

			const half = Math.floor(MAX_FILE_LINES / 2);
			const head = lines.slice(0, half).join('\n');
			const tail = lines.slice(-half).join('\n');
			return `${head}\n\n... [${lines.length - MAX_FILE_LINES} lines truncated] ...\n\n${tail}`;
		} catch {
			return `[Could not read file: ${item.label}]`;
		}
	}

	private async _resolveFolder(item: MentionItem): Promise<string> {
		if (!item.fullPath) { return ''; }

		try {
			const uri = URI.file(item.fullPath);
			const tree = await this._buildTree(uri, TREE_DEPTH, '');
			return tree;
		} catch {
			return `[Could not read folder: ${item.label}]`;
		}
	}

	private async _buildTree(uri: URI, depth: number, indent: string): Promise<string> {
		if (depth <= 0) { return ''; }

		const entries = await this._fsProvider.readDirectory(uri);
		const lines: string[] = [];

		const sorted = entries.sort((a, b) => {
			if (a[1] === b[1]) { return a[0].localeCompare(b[0]); }
			return a[1] === 'directory' ? -1 : 1;
		});

		for (const [name, type] of sorted) {
			if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') {
				continue;
			}

			const icon = type === 'directory' ? '📁' : '📄';
			lines.push(`${indent}${icon} ${name}`);

			if (type === 'directory' && depth > 1) {
				const childUri = URI.joinPath(uri, name);
				const subTree = await this._buildTree(childUri, depth - 1, indent + '  ');
				if (subTree) { lines.push(subTree); }
			}
		}

		return lines.join('\n');
	}

	private _getExtension(path: string): string {
		const idx = path.lastIndexOf('.');
		if (idx === -1) { return ''; }
		return path.slice(idx).toLowerCase();
	}
}
