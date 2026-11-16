/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — registers the FIM inline-completion and next-edit providers.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SidexCompleteProvider } from './sidexCompleteProvider.js';
import { SidexNextEditProvider, IPendingNextEditJump } from './nextEditProvider.js';
import { IRecentEditTracker } from './recentEditTracker.js';
import { resolveServerEndpoint, serverHttpUrl } from '../../sidexChat/browser/localServer.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IModelDeltaDecoration } from '../../../../editor/common/model.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { IContextKey, IContextKeyService, RawContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import './media/sidexComplete.css';

let _nextEditProvider: SidexNextEditProvider | undefined;
let _sidexCompleteContribution: SidexCompleteContribution | undefined;
const SIDEX_NEXT_EDIT_JUMP_AVAILABLE = new RawContextKey<boolean>('sidex.nextEditJumpAvailable', false);

class SidexCompleteContribution implements IWorkbenchContribution {
	static readonly ID = 'sidex.complete';

	private readonly _store = new DisposableStore();
	private readonly _jumpAvailableKey: IContextKey<boolean>;
	private _jumpStatusEntry: IDisposable | undefined;
	private _jumpDecorationIds: string[] = [];
	private _jumpDecorationEditorUri: string | undefined;
	/** Decorations shown at the target location when a jump is previewed (before commit). */
	private _targetPreviewDecorationIds: string[] = [];
	private _targetPreviewEditorUri: string | undefined;

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService configurationService: IConfigurationService,
		@IRecentEditTracker recentEditTracker: IRecentEditTracker,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@ITextModelService private readonly textModelService: ITextModelService,
	) {
		this._jumpAvailableKey = SIDEX_NEXT_EDIT_JUMP_AVAILABLE.bindTo(contextKeyService);

		_sidexCompleteContribution = this;
		const resolveUrl = () => serverHttpUrl(configurationService.getValue<string>('sidex.complete.serverUrl'));
		void resolveServerEndpoint().then(() => {
			this._store.add(languageFeaturesService.inlineCompletionsProvider.register('*', new SidexCompleteProvider(resolveUrl)));

			const nextEdit = new SidexNextEditProvider(configurationService, recentEditTracker, resolveUrl);
			nextEdit.onPendingJumpChange = (jump) => this._onPendingJumpChange(jump);
			_nextEditProvider = nextEdit;
			this._store.add(languageFeaturesService.inlineCompletionsProvider.register('*', nextEdit));
			this._store.add(nextEdit);
		});
	}

	private _clearJumpDecoration(): void {
		if (!this._jumpDecorationIds.length || !this._jumpDecorationEditorUri) {
			this._jumpDecorationIds = [];
			this._jumpDecorationEditorUri = undefined;
			return;
		}
		const editor = this.codeEditorService.listCodeEditors().find(e => e.getModel()?.uri.toString() === this._jumpDecorationEditorUri);
		editor?.changeDecorations(accessor => {
			for (const id of this._jumpDecorationIds) {
				accessor.removeDecoration(id);
			}
		});
		this._jumpDecorationIds = [];
		this._jumpDecorationEditorUri = undefined;
	}

	private _clearTargetPreviewDecorations(): void {
		if (!this._targetPreviewDecorationIds.length || !this._targetPreviewEditorUri) {
			this._targetPreviewDecorationIds = [];
			this._targetPreviewEditorUri = undefined;
			return;
		}
		const editor = this.codeEditorService.listCodeEditors().find(e => e.getModel()?.uri.toString() === this._targetPreviewEditorUri);
		editor?.changeDecorations(accessor => {
			for (const id of this._targetPreviewDecorationIds) {
				accessor.removeDecoration(id);
			}
		});
		this._targetPreviewDecorationIds = [];
		this._targetPreviewEditorUri = undefined;
	}

	private _showJumpDecoration(jump: IPendingNextEditJump): void {
		this._clearJumpDecoration();
		const editor = this.codeEditorService.getActiveCodeEditor() ?? this.codeEditorService.getFocusedCodeEditor();
		if (!editor || !editor.hasModel()) {
			return;
		}
		const pos = editor.getPosition();
		const line = pos?.lineNumber ?? 1;
		const target = URI.file(jump.filePath);
		const preview = formatJumpPreview(jump.replacement);
		const action = jump.previewed ? 'Tab to apply' : 'Tab to jump';
		const label = preview
			? `  ${action} → ${basename(target)}:${jump.startLine}  ${preview}`
			: `  ${action} → ${basename(target)}:${jump.startLine}`;
		const deco: IModelDeltaDecoration = {
			range: new Range(line, 1, line, 1),
			options: {
				description: 'sidex-next-edit-jump',
				showIfCollapsed: true,
				after: {
					content: label,
					inlineClassName: 'sidex-next-edit-jump-hint',
					inlineClassNameAffectsLetterSpacing: true,
				},
				hoverMessage: { value: `**Next edit** → \`${basename(target)}:${jump.startLine}\`${jump.reason ? `\n\n${jump.reason}` : ''}\n\n\`\`\`\n${jump.replacement.slice(0, 400)}\n\`\`\`\n\n${jump.previewed ? 'Press **Tab** to apply, **Esc** to dismiss.' : 'Press **Tab** to preview at target, **Esc** to dismiss.'}` },
			},
		};
		editor.changeDecorations(accessor => {
			this._jumpDecorationIds = accessor.deltaDecorations(this._jumpDecorationIds, [deco]);
		});
		this._jumpDecorationEditorUri = editor.getModel()!.uri.toString();
	}

	async previewPendingJump(jump: IPendingNextEditJump): Promise<void> {
		const target = URI.file(jump.filePath);
		await this.editorService.openEditor({ resource: target, options: { revealIfOpened: true, pinned: false, preserveFocus: false } });
		const ref = await this.textModelService.createModelReference(target);
		try {
			const model = ref.object.textEditorModel;
			const maxLine = model.getLineCount();
			const startLine = Math.min(Math.max(jump.startLine, 1), maxLine);
			const endLine = Math.min(Math.max(jump.endLine, startLine), maxLine);
			const startCol = Math.min(Math.max(jump.character, 1), model.getLineMaxColumn(startLine));
			const endCol = model.getLineMaxColumn(endLine);
			const range = new Range(startLine, startCol, endLine, endCol);

			const opened = this.codeEditorService.getActiveCodeEditor();
			if (opened) {
				opened.revealRangeInCenter(range);
				opened.setPosition({ lineNumber: startLine, column: startCol });
				this._clearTargetPreviewDecorations();
				const preview = formatJumpPreview(jump.replacement);
				const replacementLines = jump.replacement.replace(/\r\n/g, '\n').split('\n');
				const decos: IModelDeltaDecoration[] = [
					{
						range,
						options: {
							description: 'sidex-next-edit-target-range',
							className: 'sidex-next-edit-target-range',
							isWholeLine: startCol === 1 && endCol === model.getLineMaxColumn(endLine),
							hoverMessage: { value: `**Predicted edit (preview)**${jump.reason ? `\n\n${jump.reason}` : ''}\n\n\`\`\`\n${jump.replacement.slice(0, 1200)}\n\`\`\`\n\nPress **Tab** to apply, **Esc** to dismiss.` },
						},
					},
					{
						range: new Range(startLine, 1, startLine, 1),
						options: {
							description: 'sidex-next-edit-target-hint',
							showIfCollapsed: true,
							isWholeLine: true,
							linesDecorationsClassName: 'sidex-next-edit-target-gutter',
							after: {
								content: '  Tab to apply next edit (Esc to dismiss)',
								inlineClassName: 'sidex-next-edit-jump-hint',
								inlineClassNameAffectsLetterSpacing: true,
							},
						},
					},
				];

				// Render a lightweight inline ghost preview of the proposed
				// replacement at the target (Cursor-like "peek before commit").
				// Show first lines as ghost text after the target line; truncate
				// long previews to keep the editor readable.
				const maxPreviewLines = 4;
				const shown = replacementLines.slice(0, maxPreviewLines);
				const ghostLine = shown.map(l => (l.length > 120 ? `${l.slice(0, 119)}…` : l)).join(' ↵ ');
				const suffix = replacementLines.length > maxPreviewLines ? `  (+${replacementLines.length - maxPreviewLines} more lines)` : '';
				const ghostCol = model.getLineMaxColumn(startLine);
				decos.push({
					range: new Range(startLine, ghostCol, startLine, ghostCol),
					options: {
						description: 'sidex-next-edit-target-ghost',
						showIfCollapsed: true,
						after: {
							content: ghostLine ? `  → ${ghostLine}${suffix}` : (preview ? `  → ${preview}` : ''),
							inlineClassName: 'sidex-next-edit-target-ghost',
							inlineClassNameAffectsLetterSpacing: true,
						},
					},
				});

				opened.changeDecorations(accessor => {
					this._targetPreviewDecorationIds = accessor.deltaDecorations(this._targetPreviewDecorationIds, decos);
				});
				this._targetPreviewEditorUri = model.uri.toString();
			}
			jump.previewed = true;
		} finally {
			ref.dispose();
		}
		// Refresh source hint/status to show "Tab to apply"
		this._onPendingJumpChange(jump);
	}

	async commitPendingJump(jump: IPendingNextEditJump): Promise<void> {
		this._clearTargetPreviewDecorations();
		const target = URI.file(jump.filePath);
		await this.editorService.openEditor({ resource: target, options: { revealIfOpened: true, pinned: false, preserveFocus: false } });
		const ref = await this.textModelService.createModelReference(target);
		try {
			const model = ref.object.textEditorModel;
			const maxLine = model.getLineCount();
			const startLine = Math.min(Math.max(jump.startLine, 1), maxLine);
			const endLine = Math.min(Math.max(jump.endLine, startLine), maxLine);
			const startCol = Math.min(Math.max(jump.character, 1), model.getLineMaxColumn(startLine));
			const endCol = model.getLineMaxColumn(endLine);
			const range = new Range(startLine, startCol, endLine, endCol);
			model.pushEditOperations([], [{ range, text: jump.replacement }], () => null);
			const opened = this.codeEditorService.getActiveCodeEditor();
			if (opened) {
				const insertedLines = jump.replacement.split('\n');
				const selEndLine = Math.min(startLine + insertedLines.length - 1, model.getLineCount());
				const selEndCol = insertedLines.length <= 1
					? Math.min(startCol + insertedLines[0].length, model.getLineMaxColumn(selEndLine))
					: model.getLineMaxColumn(selEndLine);
				opened.revealRangeInCenter(new Range(startLine, startCol, selEndLine, selEndCol));
				opened.setSelection(new Range(startLine, startCol, selEndLine, selEndCol));
			}
		} finally {
			ref.dispose();
		}
	}

	private _onPendingJumpChange(jump: IPendingNextEditJump | null): void {
		this._jumpAvailableKey.set(!!jump);
		this._jumpStatusEntry?.dispose();
		this._jumpStatusEntry = undefined;
		this._clearJumpDecoration();
		if (!jump) {
			this._clearTargetPreviewDecorations();
			return;
		}
		// A fresh (non-previewed) jump replaces any previous target preview.
		if (!jump.previewed) {
			this._clearTargetPreviewDecorations();
		}
		const target = URI.file(jump.filePath);
		const label = `${basename(target)}:${jump.startLine}`;
		const action = jump.previewed ? 'Tab to apply' : 'Tab to jump';
		this._jumpStatusEntry = this.statusbarService.addEntry({
			name: 'Sidex Next Edit Jump',
			text: `$(arrow-right) ${action} ${label}`,
			ariaLabel: `${action} ${label}`,
			tooltip: jump.previewed ? `Apply predicted edit in ${label} (Tab), Esc to dismiss` : `Preview predicted next edit in ${label} (Tab), Esc to dismiss`,
			command: 'sidex.nextEdit.acceptJump',
		}, 'sidex.nextEditJump', StatusbarAlignment.RIGHT, 1001);
		this._showJumpDecoration(jump);
	}

	dispose(): void {
		if (_sidexCompleteContribution === this) {
			_sidexCompleteContribution = undefined;
		}
		this._clearTargetPreviewDecorations();
		this._clearJumpDecoration();
		this._jumpStatusEntry?.dispose();
		this._jumpAvailableKey.set(false);
		this._store.dispose();
	}
}

registerWorkbenchContribution2(SidexCompleteContribution.ID, SidexCompleteContribution, WorkbenchPhase.AfterRestored);

// Manual trigger: useful after a run of edits, and the only way to ask for a
// prediction when the tracker has not seen a change (e.g. right after opening
// a file with pending work). If a cross-file jump is pending, navigate there
// and apply the predicted edit instead of re-triggering inline suggest.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.nextEdit.trigger',
			title: { value: 'Sidex: Predict Next Edit', original: 'Sidex: Predict Next Edit' },
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyK,
				weight: KeybindingWeight.EditorContrib + 50,
				when: EditorContextKeys.editorTextFocus,
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const jump = _nextEditProvider?.pendingJump;
		if (jump) {
			await acceptPendingJump();
			return;
		}
		const codeEditorService = accessor.get(ICodeEditorService);
		const editor = codeEditorService.getFocusedCodeEditor();
		if (!editor || !isCodeEditor(editor)) {
			return;
		}
		// Trigger a fresh prediction. If the provider discovers a cross-file
		// jump, store it as pending and preview at target (peek-before-commit).
		await editor.getAction('editor.action.inlineSuggest.trigger')?.run();
		const deadline = Date.now() + 6000;
		while (Date.now() < deadline) {
			await new Promise<void>(resolve => setTimeout(resolve, 200));
			const pending = _nextEditProvider?.pendingJump;
			if (pending) {
				await acceptPendingJump();
				return;
			}
		}
	}
});

// Accept a pending next-edit jump (Cursor-like "Tab to jump"). Bound to Tab
// only when a jump target is available and no inline suggestion is visible,
// so it doesn't steal Tab from normal inline-completion accept/indent.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.nextEdit.acceptJump',
			title: { value: 'Sidex: Accept Next Edit Jump', original: 'Sidex: Accept Next Edit Jump' },
			keybinding: {
				primary: KeyCode.Tab,
				weight: KeybindingWeight.EditorContrib + 60,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, SIDEX_NEXT_EDIT_JUMP_AVAILABLE),
			},
			f1: true,
		});
	}

	async run(_accessor: ServicesAccessor): Promise<void> {
		await acceptPendingJump();
	}
});

// Dismiss a pending jump hint without navigating (deferral/cancel).
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.nextEdit.dismissJump',
			title: { value: 'Sidex: Dismiss Next Edit Jump', original: 'Sidex: Dismiss Next Edit Jump' },
			keybinding: {
				primary: KeyCode.Escape,
				weight: KeybindingWeight.EditorContrib + 60,
				when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus, SIDEX_NEXT_EDIT_JUMP_AVAILABLE),
			},
			f1: true,
		});
	}

	async run(): Promise<void> {
		_nextEditProvider?.clearPendingJump();
	}
});

// Jump flow: first accept previews at target (no commit), second Tab applies.
// This gives a Cursor-like "peek before commit" step for cross-file jumps.
async function acceptPendingJump(): Promise<void> {
	const jump = _nextEditProvider?.pendingJump;
	if (!jump) {
		return;
	}
	const contribution = _sidexCompleteContribution;
	if (!contribution) {
		_nextEditProvider?.clearPendingJump();
		return;
	}
	if (!jump.previewed) {
		await contribution.previewPendingJump(jump);
		return;
	}
	_nextEditProvider?.clearPendingJump();
	await contribution.commitPendingJump(jump);
}

function formatJumpPreview(replacement: string): string {
	const first = replacement.replace(/\s+/g, ' ').trim();
	if (!first) {
		return '';
	}
	const max = 48;
	return first.length > max ? `"${first.slice(0, max - 1)}…"` : `"${first}"`;
}
