/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — registers the FIM inline-completion and next-edit providers.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { SidexCompleteProvider } from './sidexCompleteProvider.js';
import { SidexNextEditProvider } from './nextEditProvider.js';
import { IRecentEditTracker } from './recentEditTracker.js';
import { resolveServerEndpoint, serverHttpUrl } from '../../sidexChat/browser/localServer.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';

class SidexCompleteContribution implements IWorkbenchContribution {
	static readonly ID = 'sidex.complete';

	private readonly _store = new DisposableStore();

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService configurationService: IConfigurationService,
		@IRecentEditTracker recentEditTracker: IRecentEditTracker,
	) {
		// Defaults to the agent server the app runs locally; an explicit
		// setting points completions somewhere else. Registration waits for
		// the port to be known, but the URL is re-read per request so a server
		// restart doesn't strand the provider on a dead port.
		const resolveUrl = () => serverHttpUrl(configurationService.getValue<string>('sidex.complete.serverUrl'));
		void resolveServerEndpoint().then(() => {
			this._store.add(languageFeaturesService.inlineCompletionsProvider.register('*', new SidexCompleteProvider(resolveUrl)));

			// Next-edit runs as a second provider rather than a mode of the
			// first: it answers a different question (where to edit, not what
			// to type next) and the editor picks between the two items.
			const nextEdit = new SidexNextEditProvider(configurationService, recentEditTracker, resolveUrl);
			this._store.add(languageFeaturesService.inlineCompletionsProvider.register('*', nextEdit));
			this._store.add(nextEdit);
		});
	}

	dispose(): void {
		this._store.dispose();
	}
}

registerWorkbenchContribution2(SidexCompleteContribution.ID, SidexCompleteContribution, WorkbenchPhase.AfterRestored);

// Manual trigger: useful after a run of edits, and the only way to ask for a
// prediction when the tracker has not seen a change (e.g. right after opening
// a file with pending work).
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
		const codeEditorService = accessor.get(ICodeEditorService);
		const editor = codeEditorService.getFocusedCodeEditor();
		if (!editor || !isCodeEditor(editor)) {
			return;
		}
		await editor.getAction('editor.action.inlineSuggest.trigger')?.run();
	}
});
