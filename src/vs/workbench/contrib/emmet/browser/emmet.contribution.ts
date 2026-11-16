/*---------------------------------------------------------------------------------------------
 *  SideX - Emmet editor actions.
 *  Copyright (c) Siden Technologies, Inc. MIT Licensed.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	Extensions,
	IConfigurationRegistry
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import {
	EditorAction,
	EditorContributionInstantiation,
	registerEditorAction,
	registerEditorContribution,
	ServicesAccessor
} from '../../../../editor/browser/editorExtensions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { SnippetController2 } from '../../../../editor/contrib/snippet/browser/snippetController2.js';
import { ISnippetEdit } from '../../../../editor/contrib/snippet/browser/snippetSession.js';
import { Context as SuggestContext } from '../../../../editor/contrib/suggest/browser/suggest.js';
import {
	abbreviationBeforeCursor,
	balanceMarkup,
	EmmetVariables,
	expandAbbreviation,
	ExpandOptions,
	syntaxForLanguage
} from '../common/expand.js';

export const EmmetAbbreviationContext = new RawContextKey<boolean>(
	'emmetAbbreviation',
	false,
	localize('emmetAbbreviation', 'Whether the cursor is at an Emmet abbreviation that Tab can expand')
);

class EmmetEditorContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.emmet';

	private readonly _abbreviation: IContextKey<boolean>;

	constructor(
		private readonly _editor: ICodeEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super();
		this._abbreviation = EmmetAbbreviationContext.bindTo(contextKeyService);
		this._register(this._editor.onDidChangeModel(() => this._update()));
		this._register(this._editor.onDidChangeModelLanguage(() => this._update()));
		this._register(this._editor.onDidChangeModelContent(() => this._update()));
		this._register(this._editor.onDidChangeCursorPosition(() => this._update()));
		this._register(
			this._configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('emmet')) {
					this._update();
				}
			})
		);
		this._update();
	}

	private _update(): void {
		if (this._configurationService.getValue<boolean>('emmet.triggerExpansionOnTab') === false) {
			this._abbreviation.set(false);
			return;
		}
		const model = this._editor.getModel();
		const position = this._editor.getPosition();
		if (!model || !position) {
			this._abbreviation.set(false);
			return;
		}
		const options = emmetOptions(this._configurationService, model, true, '');
		if (!options) {
			this._abbreviation.set(false);
			return;
		}
		const line = model.getLineContent(position.lineNumber);
		const match = abbreviationBeforeCursor(line, position.column - 1, options);
		this._abbreviation.set(!!match);
	}
}

registerEditorContribution(
	EmmetEditorContribution.ID,
	EmmetEditorContribution,
	EditorContributionInstantiation.BeforeFirstInteraction
);

class ExpandAbbreviationAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.emmet.action.expandAbbreviation',
			label: localize2('emmet.expand', 'Emmet: Expand Abbreviation'),
			precondition: EditorContextKeys.writable,
			kbOpts: {
				kbExpr: ContextKeyExpr.and(
					EditorContextKeys.editorTextFocus,
					EditorContextKeys.tabDoesNotMoveFocus,
					EmmetAbbreviationContext,
					SuggestContext.Visible.toNegated(),
					SnippetController2.InSnippetMode.toNegated(),
					ContextKeyExpr.notEquals('config.emmet.triggerExpansionOnTab', false)
				),
				primary: KeyCode.Tab,
				weight: KeybindingWeight.EditorContrib,
				args: { tabTrigger: true }
			},
			menuOpts: {
				menuId: MenuId.CommandPalette,
				group: 'z_emmet',
				title: localize('emmet.expand.title', 'Emmet: Expand Abbreviation'),
				order: 1
			}
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): void {
		const tabTrigger =
			typeof args === 'object' &&
			args !== null &&
			(args as { tabTrigger?: boolean }).tabTrigger === true;
		if (tabTrigger && accessor.get(IConfigurationService).getValue<boolean>('emmet.triggerExpansionOnTab') === false) {
			return;
		}
		expandAtCursors(accessor.get(IConfigurationService), editor, tabTrigger);
	}
}

class WrapWithAbbreviationAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.emmet.action.wrapWithAbbreviation',
			label: localize2('emmet.wrap', 'Emmet: Wrap with Abbreviation'),
			precondition: EditorContextKeys.writable,
			menuOpts: {
				menuId: MenuId.CommandPalette,
				group: 'z_emmet',
				title: localize('emmet.wrap.title', 'Emmet: Wrap with Abbreviation'),
				order: 2
			}
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		if (!editor.hasModel()) {
			return;
		}
		const model = editor.getModel();
		const config = accessor.get(IConfigurationService);
		const probe = emmetOptions(config, model, false, '');
		if (!probe || probe.syntax === 'css') {
			return;
		}
		const selections = editor.getSelections().filter(selection => !selection.isEmpty());
		if (selections.length === 0) {
			return;
		}
		const abbreviation = await accessor.get(IQuickInputService).input({
			prompt: localize('emmet.wrap.prompt', 'Abbreviation to wrap the selection with'),
			placeHolder: 'div',
			value: 'div'
		});
		if (!abbreviation) {
			return;
		}
		const edits: ISnippetEdit[] = [];
		for (const selection of selections) {
			const options = emmetOptions(config, model, false, lineIndent(model, selection.startLineNumber));
			if (!options) {
				continue;
			}
			const snippet = expandAbbreviation(abbreviation, {
				...options,
				wrapText: model.getValueInRange(selection)
			});
			if (!snippet) {
				continue;
			}
			edits.push({ range: selection, template: snippet });
		}
		applySnippets(editor, edits);
	}
}

class BalanceOutAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.emmet.action.balanceOut',
			label: localize2('emmet.balanceOut', 'Emmet: Balance (Outward)'),
			precondition: undefined,
			menuOpts: {
				menuId: MenuId.CommandPalette,
				group: 'z_emmet',
				title: localize('emmet.balanceOut.title', 'Emmet: Balance (Outward)'),
				order: 3
			}
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		balance(editor, 'out');
	}
}

class BalanceInAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.emmet.action.balanceIn',
			label: localize2('emmet.balanceIn', 'Emmet: Balance (Inward)'),
			precondition: undefined,
			menuOpts: {
				menuId: MenuId.CommandPalette,
				group: 'z_emmet',
				title: localize('emmet.balanceIn.title', 'Emmet: Balance (Inward)'),
				order: 4
			}
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		balance(editor, 'in');
	}
}

registerEditorAction(ExpandAbbreviationAction);
registerEditorAction(WrapWithAbbreviationAction);
registerEditorAction(BalanceOutAction);
registerEditorAction(BalanceInAction);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	id: 'emmet',
	order: 112,
	title: localize('emmetConfigurationTitle', 'Emmet'),
	type: 'object',
	properties: {
		'emmet.triggerExpansionOnTab': {
			type: 'boolean',
			default: true,
			description: localize(
				'emmet.triggerExpansionOnTab',
				'When enabled, pressing Tab expands an Emmet abbreviation under the cursor in HTML, JSX, and CSS. Suggestions, snippets, and inline completions keep Tab when they are active.'
			)
		},
		'emmet.excludeLanguages': {
			type: 'array',
			items: { type: 'string' },
			default: [],
			description: localize(
				'emmet.excludeLanguages',
				'Language ids in which Emmet expansion is disabled. For example: ["markdown", "php"].'
			)
		},
		'emmet.includeLanguages': {
			type: 'object',
			additionalProperties: { type: 'string' },
			default: {},
			markdownDescription: localize(
				'emmet.includeLanguages',
				'Map a language id to the language Emmet should treat it as. For example, `{ "javascript": "javascriptreact" }` expands abbreviations in JavaScript files with JSX syntax.'
			)
		},
		'emmet.variables': {
			type: 'object',
			default: { lang: 'en', charset: 'UTF-8' },
			properties: {
				lang: {
					type: 'string',
					description: localize('emmet.variables.lang', 'Value of the `lang` attribute in the HTML boilerplate (`!` / `html:5`).')
				},
				charset: {
					type: 'string',
					description: localize('emmet.variables.charset', 'Charset written into the HTML boilerplate.')
				},
				locale: {
					type: 'string',
					description: localize('emmet.variables.locale', 'Reserved locale variable for Emmet snippets.')
				}
			},
			additionalProperties: { type: 'string' },
			description: localize('emmet.variables', 'Variables substituted into Emmet boilerplate, such as `lang` and `charset`.')
		}
	}
});

function expandAtCursors(config: IConfigurationService, editor: ICodeEditor, tabTrigger: boolean): void {
	if (!editor.hasModel()) {
		return;
	}
	const model = editor.getModel();
	const edits: ISnippetEdit[] = [];
	for (const selection of editor.getSelections()) {
		if (!selection.isEmpty()) {
			continue;
		}
		const options = emmetOptions(config, model, tabTrigger, lineIndent(model, selection.positionLineNumber));
		if (!options) {
			continue;
		}
		const line = model.getLineContent(selection.positionLineNumber);
		const match = abbreviationBeforeCursor(line, selection.positionColumn - 1, options);
		if (!match) {
			continue;
		}
		const snippet = expandAbbreviation(match.abbreviation, options);
		if (!snippet) {
			continue;
		}
		edits.push({
			range: new Range(
				selection.positionLineNumber,
				match.start + 1,
				selection.positionLineNumber,
				selection.positionColumn
			),
			template: snippet
		});
	}
	applySnippets(editor, edits);
}

function applySnippets(editor: ICodeEditor, edits: ISnippetEdit[]): void {
	if (edits.length === 0) {
		return;
	}
	edits.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));
	SnippetController2.get(editor)?.apply(edits, {
		undoStopBefore: true,
		undoStopAfter: true,
		adjustWhitespace: false
	});
}

function balance(editor: ICodeEditor, direction: 'in' | 'out'): void {
	if (!editor.hasModel()) {
		return;
	}
	const model = editor.getModel();
	const source = model.getValue();
	const next: Selection[] = [];
	let changed = false;
	for (const selection of editor.getSelections()) {
		const start = model.getOffsetAt(selection.getStartPosition());
		const end = model.getOffsetAt(selection.getEndPosition());
		const range = balanceMarkup(source, start, end, direction);
		if (!range) {
			next.push(selection);
			continue;
		}
		changed = true;
		const anchor = model.getPositionAt(range.start);
		const head = model.getPositionAt(range.end);
		next.push(Selection.fromPositions(anchor, head));
	}
	if (changed) {
		editor.setSelections(next);
	}
}

function emmetOptions(
	config: IConfigurationService,
	model: ITextModel,
	tabTrigger: boolean,
	baseIndent: string
): ExpandOptions | undefined {
	const include = config.getValue<Record<string, string>>('emmet.includeLanguages') || {};
	const exclude = config.getValue<string[]>('emmet.excludeLanguages') || [];
	const variables = config.getValue<EmmetVariables>('emmet.variables') || {};
	const syntax = syntaxForLanguage(model.getLanguageId(), include, exclude);
	if (!syntax) {
		return undefined;
	}
	const resolved = model.getOptions();
	const indent = resolved.insertSpaces ? ' '.repeat(Math.max(1, resolved.indentSize)) : '\t';
	return { syntax, indent, baseIndent, tabTrigger, variables };
}

function lineIndent(model: ITextModel, lineNumber: number): string {
	return /^[ \t]*/.exec(model.getLineContent(lineNumber))?.[0] ?? '';
}
