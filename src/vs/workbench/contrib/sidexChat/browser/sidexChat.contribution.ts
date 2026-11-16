/*---------------------------------------------------------------------------------------------
 *  Sidex — The built-in AI panel for Sidex IDE.
 *  Registered in the AuxiliaryBar with its own status bar toggle.
 *--------------------------------------------------------------------------------------------*/

import * as nls from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
} from '../../../common/views.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISCMService } from '../../scm/common/scm.js';
import { serverHttpUrl } from './localServer.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { SidexChatViewPane } from './sidexChatView.js';
import './sidexChatService.js';

export const SIDEX_CHAT_CONTAINER_ID = 'workbench.view.sidexChat';
export const SIDEX_CHAT_VIEW_ID = 'workbench.view.sidexChat.main';

const sidexChatIcon = registerIcon('sidex-chat-icon', Codicon.commentDiscussion, nls.localize('sidexChatIcon', 'Sidex icon'));

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: SIDEX_CHAT_CONTAINER_ID,
		title: nls.localize2('sidex', 'Sidex'),
		icon: sidexChatIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [SIDEX_CHAT_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		order: -100,
	},
	ViewContainerLocation.Sidex,
	{ isDefault: true, doNotRegisterOpenCommand: true }
);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
	[
		{
			id: SIDEX_CHAT_VIEW_ID,
			name: nls.localize2('sidex', 'Sidex'),
			containerIcon: sidexChatIcon,
			ctorDescriptor: new SyncDescriptor(SidexChatViewPane),
			canToggleVisibility: false,
			canMoveView: false,
			hideByDefault: false,
		},
	],
	viewContainer
);

// Cmd+Shift+I toggles the Sidex panel
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.toggleSidexChat',
			title: nls.localize2('toggleSidex', 'Toggle Sidex'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				weight: KeybindingWeight.WorkbenchContrib,
			},
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		layoutService.setPartHidden(layoutService.isVisible(Parts.SIDEX_PART), Parts.SIDEX_PART);
	}
});

// Status bar toggle icon (layout-sidebar-right)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.sidexStatusBarToggle',
			title: nls.localize2('sidexStatusBarToggle', 'Toggle Sidex'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const isVisible = layoutService.isVisible(Parts.SIDEX_PART);
		layoutService.setPartHidden(isVisible, Parts.SIDEX_PART);
	}
});

// Register the status bar entries on startup
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { InlineEditController } from './inline/inlineEditController.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ISidexChatService } from './sidexChatService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

class SidexStatusBarContribution implements IWorkbenchContribution {
	static readonly ID = 'sidex.statusbar';

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		// Sidex panel toggle (far right)
		const sidexEntry = statusbarService.addEntry(
			{
				name: nls.localize('sidexToggle', 'Sidex'),
				text: this._sidexIcon(),
				ariaLabel: nls.localize('toggleSidex', 'Toggle Sidex'),
				command: 'workbench.action.sidexStatusBarToggle',
				tooltip: this._sidexTooltip(),
			},
			'sidex.toggle',
			StatusbarAlignment.RIGHT,
			-1000
		);

		// Secondary sidebar toggle (next to Sidex, for Claude Code etc.)
		const auxEntry = statusbarService.addEntry(
			{
				name: nls.localize('auxToggle', 'Secondary Sidebar'),
				text: this._auxIcon(),
				ariaLabel: nls.localize('toggleAux', 'Toggle Secondary Sidebar'),
				command: 'workbench.action.toggleAuxiliaryBar',
				tooltip: this._auxTooltip(),
			},
			'sidex.aux.toggle',
			StatusbarAlignment.RIGHT,
			-999
		);

		// Update icons when visibility changes
		const update = () => {
			sidexEntry.update({
				name: nls.localize('sidexToggle', 'Sidex'),
				text: this._sidexIcon(),
				ariaLabel: nls.localize('toggleSidex', 'Toggle Sidex'),
				command: 'workbench.action.sidexStatusBarToggle',
				tooltip: this._sidexTooltip(),
			});
			auxEntry.update({
				name: nls.localize('auxToggle', 'Secondary Sidebar'),
				text: this._auxIcon(),
				ariaLabel: nls.localize('toggleAux', 'Toggle Secondary Sidebar'),
				command: 'workbench.action.toggleAuxiliaryBar',
				tooltip: this._auxTooltip(),
			});
		};

		// Listen for layout changes
		(layoutService as any).onDidChangePartVisibility?.(() => update());
		// Fallback: poll every 500ms (some layout changes don't fire events)
		const interval = setInterval(update, 500);
		(this as unknown as { dispose?: IDisposable }).dispose = { dispose: () => clearInterval(interval) } as IDisposable;
	}

	private _sidexIcon(): string {
		return this.layoutService.isVisible(Parts.SIDEX_PART)
			? '$(sidex-panel-open)'
			: '$(sidex-panel-closed)';
	}

	private _sidexTooltip(): string {
		return this.layoutService.isVisible(Parts.SIDEX_PART) ? 'Hide Sidex' : 'Show Sidex';
	}

	private _auxIcon(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART)
			? '$(layout-sidebar-right)'
			: '$(layout-sidebar-right-off)';
	}

	private _auxTooltip(): string {
		return this.layoutService.isVisible(Parts.AUXILIARYBAR_PART) ? 'Hide Secondary Sidebar' : 'Show Secondary Sidebar';
	}
}

registerWorkbenchContribution2(SidexStatusBarContribution.ID, SidexStatusBarContribution, WorkbenchPhase.AfterRestored);

// Old Haiku-based inline completion — disabled in favor of Sidex Complete (sidexComplete contribution)
// class SidexInlineCompletionContribution implements IWorkbenchContribution {
// 	static readonly ID = 'sidex.inlineCompletion';
// }
// registerWorkbenchContribution2(SidexInlineCompletionContribution.ID, SidexInlineCompletionContribution, WorkbenchPhase.AfterRestored);

// --- CMD+K Inline Edit ---

// One InlineEditController per editor, lazily created
const controllerMap = new WeakMap<object, InlineEditController>();

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.inlineEdit.activate',
			title: nls.localize2('sidexInlineEdit', 'Sidex: Inline Edit'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
				weight: KeybindingWeight.EditorContrib + 100,
				when: EditorContextKeys.editorTextFocus,
			},
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const configService = accessor.get(IConfigurationService);
		const editor = codeEditorService.getFocusedCodeEditor();
		if (!editor || !isCodeEditor(editor)) {
			return;
		}

		let controller = controllerMap.get(editor);
		if (!controller) {
			controller = new InlineEditController(editor, configService);
			controllerMap.set(editor, controller);
			// Clean up when editor is disposed
			editor.onDidDispose(() => {
				controller?.dispose();
				controllerMap.delete(editor);
			});
		}

		controller.activate();
	}
});

// --- Review Changes ---
//
// One-shot review of the pending diff. SideX exposes this both as a command
// and as a button in the chat panel; the panel button reuses this same action
// so the two can never drift apart.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.reviewChanges',
			title: nls.localize2('sidexReviewChanges', 'Sidex: Review Changes'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR,
				weight: KeybindingWeight.WorkbenchContrib,
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const layoutService = accessor.get(IWorkbenchLayoutService);
		const chatService = accessor.get(ISidexChatService);
		const quickInputService = accessor.get(IQuickInputService);

		layoutService.setPartHidden(false, Parts.SIDEX_PART);

		// Optional focus lets the same action serve "review everything" and
		// targeted Bugbot-like passes (security, correctness, tests, perf).
		const picked = await quickInputService.pick([
			{ label: nls.localize('sidexReviewAll', 'Review all changes'), description: nls.localize('sidexReviewAllDesc', 'General correctness, security and maintainability'), id: '' },
			{ label: nls.localize('sidexReviewBugs', 'Bugs & correctness'), description: nls.localize('sidexReviewBugsDesc', 'Logic errors, edge cases, regressions'), id: 'Focus on bugs, logic errors, edge cases, and regressions.' },
			{ label: nls.localize('sidexReviewSecurity', 'Security'), description: nls.localize('sidexReviewSecurityDesc', 'Injection, auth, secrets, path traversal, unsafe input'), id: 'Focus on security issues: injection, auth/access control, secrets exposure, path traversal, and unsafe input handling.' },
			{ label: nls.localize('sidexReviewTests', 'Tests & coverage'), description: nls.localize('sidexReviewTestsDesc', 'Missing or weak tests, risky untested paths'), id: 'Focus on missing or weak tests and risky untested behavior changes.' },
			{ label: nls.localize('sidexReviewPerf', 'Performance'), description: nls.localize('sidexReviewPerfDesc', 'Hot paths, allocations, N+1, blocking work'), id: 'Focus on performance risks: hot paths, unnecessary allocations, N+1 work, blocking I/O, and scalability issues.' },
			{ label: nls.localize('sidexReviewCustom', 'Custom focus…'), description: nls.localize('sidexReviewCustomDesc', 'Describe what to look for'), id: '__custom__' },
		], {
			title: nls.localize('sidexReviewTitle', 'Review Changes'),
			placeHolder: nls.localize('sidexReviewPickPlaceholder', 'Choose a review focus (Esc to cancel)'),
		});

		if (!picked) {
			return; // cancelled
		}

		let instructions = (picked as { id?: string }).id ?? '';
		if (instructions === '__custom__') {
			const custom = await quickInputService.input({
				title: nls.localize('sidexReviewTitle', 'Review Changes'),
				placeHolder: nls.localize('sidexReviewPlaceholder', 'What should the review focus on?'),
				prompt: nls.localize('sidexReviewPrompt', 'Leave empty to review the whole pending diff.'),
			});
			if (custom === undefined) {
				return;
			}
			instructions = custom;
		}

		await chatService.runReview(instructions);
	}
});

// --- Generate Commit Message ---
//
// Reads the pending diff via the local server, asks the model for a commit
// message, and writes it into the active SCM repository's input box. The user
// still reviews and commits — nothing is committed automatically.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.generateCommitMessage',
			title: nls.localize2('sidexGenerateCommitMessage', 'Sidex: Generate Commit Message'),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM,
				weight: KeybindingWeight.WorkbenchContrib,
			},
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configService = accessor.get(IConfigurationService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const scmService = accessor.get(ISCMService);
		const quickInputService = accessor.get(IQuickInputService);

		const folder = workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const cwd = folder.uri.fsPath;
		const httpUrl = serverHttpUrl(configService.getValue<string>('sidex.complete.serverUrl'));

		let result: { message?: string; error?: string };
		try {
			const resp = await fetch(`${httpUrl}/v1/commit-message`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cwd }),
			});
			result = await resp.json() as { message?: string; error?: string };
			if (!resp.ok) {
				throw new Error(result.error || `HTTP ${resp.status}`);
			}
		} catch (err) {
			await quickInputService.input({
				title: nls.localize('sidexCommitMsgTitle', 'Generate Commit Message'),
				value: '',
				prompt: nls.localize('sidexCommitMsgFailed', 'Could not generate a commit message: {0}', String(err)),
			});
			return;
		}

		const message = (result.message || '').trim();
		if (!message) {
			return;
		}

		// Prefer the selected repository, then the first visible one.
		const repos = Array.from(scmService.repositories);
		const repo = repos.find(r => r.provider.rootUri?.fsPath === cwd) ?? repos[0];
		if (repo) {
			repo.input.setValue(message, false);
			repo.input.setFocus();
			return;
		}

		// No SCM provider available (e.g. not a git repo in the extension host) —
		// show the message so the user can still copy it.
		await quickInputService.input({
			title: nls.localize('sidexCommitMsgTitle', 'Generate Commit Message'),
			value: message,
			prompt: nls.localize('sidexCommitMsgNoScm', 'No active source-control repository. Copy the message below.'),
		});
	}
});

// --- Shadow workspace (local speculative-edit sandbox) ---
//
// Cursor runs speculative agent edits in a shadow workspace so the real tree is
// untouched until you accept. SideX's local equivalent is a detached git
// worktree under `.sidex/shadow/`: the server creates it, the agent can edit it,
// and the changes are reviewed/applied/discarded explicitly from here.
//
// These commands are the user-facing half; the server endpoints live in
// `sidexai/sidex-server/internal/api/shadow.go`.

interface IShadowResponse {
	shadow?: string;
	diff?: string;
	applied?: boolean;
	files?: number;
	conflicts?: string[];
	error?: string;
}

let _activeShadow: { cwd: string; shadow: string } | undefined;

async function callShadowService(httpUrl: string, endpoint: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: IShadowResponse }> {
	try {
		const resp = await fetch(`${httpUrl}/v1/shadow/${endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		let data: IShadowResponse = {};
		try {
			data = await resp.json() as IShadowResponse;
		} catch { /* empty body (202/204) */ }
		return { ok: resp.ok, status: resp.status, data };
	} catch (err) {
		return { ok: false, status: 0, data: { error: String(err) } };
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.shadowWorkspace.start',
			title: nls.localize2('sidexShadowStart', 'Sidex: Start Shadow Workspace'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IWorkspaceContextService);
		const configService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const folder = workspaceService.getWorkspace().folders[0];
		if (!folder) {
			notificationService.notify({ severity: Severity.Warning, message: nls.localize('sidexShadowNoFolder', 'Open a folder first — a shadow workspace needs a git repository.') });
			return;
		}
		const cwd = folder.uri.fsPath;

		const name = await quickInputService.input({
			title: nls.localize('sidexShadowStartTitle', 'Start Shadow Workspace'),
			placeHolder: nls.localize('sidexShadowNamePlaceholder', 'Optional name (defaults to ws-<pid>)'),
			prompt: nls.localize('sidexShadowNamePrompt', 'A detached worktree is created under .sidex/shadow/. Edits there never touch your working tree until you apply them.'),
		});
		if (name === undefined) {
			return;
		}

		const httpUrl = serverHttpUrl(configService.getValue<string>('sidex.complete.serverUrl'));
		const res = await callShadowService(httpUrl, 'create', { cwd, name: name.trim() || undefined });
		if (!res.ok || !res.data.shadow) {
			notificationService.notify({
				severity: Severity.Error,
				message: nls.localize('sidexShadowCreateFailed', 'Could not create a shadow workspace: {0}', res.data.error || `HTTP ${res.status}`),
			});
			return;
		}

		_activeShadow = { cwd, shadow: res.data.shadow };
		notificationService.notify({
			severity: Severity.Info,
			message: nls.localize('sidexShadowCreated', 'Shadow workspace created at {0}. Apply or discard it from the Command Palette.', res.data.shadow),
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.shadowWorkspace.apply',
			title: nls.localize2('sidexShadowApply', 'Sidex: Apply Shadow Workspace Changes'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IWorkspaceContextService);
		const configService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const folder = workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const cwd = folder.uri.fsPath;
		const httpUrl = serverHttpUrl(configService.getValue<string>('sidex.complete.serverUrl'));

		let shadow = _activeShadow?.cwd === cwd ? _activeShadow.shadow : undefined;
		if (!shadow) {
			const listed = await callShadowService(httpUrl, 'list', { cwd });
			const options = (listed.data as unknown as { shadows?: string[] }).shadows ?? [];
			if (options.length === 0) {
				notificationService.notify({ severity: Severity.Info, message: nls.localize('sidexShadowNone', 'No shadow workspaces found for this folder.') });
				return;
			}
			const picked = options.length === 1
				? options[0]
				: await quickInputService.pick(options.map(s => ({ label: s })), { title: nls.localize('sidexShadowPickTitle', 'Apply Shadow Workspace') });
			if (!picked) {
				return;
			}
			shadow = picked;
		}

		const res = await callShadowService(httpUrl, 'apply', { cwd, shadow });
		if (res.status === 409) {
			const conflicts = (res.data.conflicts ?? []).join('\n');
			notificationService.notify({
				severity: Severity.Warning,
				message: nls.localize('sidexShadowConflicts', 'Shadow changes were not applied because these files changed locally:\n{0}', conflicts || (res.data.error ?? 'unknown conflict')),
			});
			return;
		}
		if (!res.ok) {
			notificationService.notify({
				severity: Severity.Error,
				message: nls.localize('sidexShadowApplyFailed', 'Could not apply the shadow workspace: {0}', res.data.error || `HTTP ${res.status}`),
			});
			return;
		}
		notificationService.notify({
			severity: Severity.Info,
			message: nls.localize('sidexShadowApplied', 'Applied {0} changed file(s) from the shadow workspace.', res.data.files ?? 0),
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sidex.shadowWorkspace.discard',
			title: nls.localize2('sidexShadowDiscard', 'Sidex: Discard Shadow Workspace'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceService = accessor.get(IWorkspaceContextService);
		const configService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		const folder = workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const cwd = folder.uri.fsPath;
		const httpUrl = serverHttpUrl(configService.getValue<string>('sidex.complete.serverUrl'));

		let shadow = _activeShadow?.cwd === cwd ? _activeShadow.shadow : undefined;
		if (!shadow) {
			const listed = await callShadowService(httpUrl, 'list', { cwd });
			const options = (listed.data as unknown as { shadows?: string[] }).shadows ?? [];
			if (options.length === 0) {
				return;
			}
			shadow = await quickInputService.pick(options.map(s => ({ label: s })), { title: nls.localize('sidexShadowDiscardTitle', 'Discard Shadow Workspace') });
			if (!shadow) {
				return;
			}
		}

		const res = await callShadowService(httpUrl, 'discard', { cwd, shadow });
		if (!res.ok) {
			notificationService.notify({
				severity: Severity.Error,
				message: nls.localize('sidexShadowDiscardFailed', 'Could not discard the shadow workspace: {0}', res.data.error || `HTTP ${res.status}`),
			});
			return;
		}
		if (_activeShadow?.shadow === shadow) {
			_activeShadow = undefined;
		}
		notificationService.notify({ severity: Severity.Info, message: nls.localize('sidexShadowDiscarded', 'Shadow workspace discarded.') });
	}
});
