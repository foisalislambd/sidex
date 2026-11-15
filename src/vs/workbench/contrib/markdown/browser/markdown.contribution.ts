/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/markdownColors.js';
import './media/markdown.css';

import { Disposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	IWorkbenchContribution,
	WorkbenchPhase,
	registerWorkbenchContribution2
} from '../../../common/contributions.js';
import { MarkdownPreviewManager } from './markdownPreview.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';

let _previewManager: MarkdownPreviewManager | undefined;

function getOrCreateManager(accessor: ServicesAccessor): MarkdownPreviewManager {
	if (!_previewManager) {
		_previewManager = accessor.get(IInstantiationService).createInstance(MarkdownPreviewManager);
	}
	return _previewManager;
}

class MarkdownPreviewAutoReopen extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.markdownPreviewAutoReopen';

	private _didAutoReopen = false;

	constructor(
		@IEditorService editorService: IEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IStorageService private readonly _storageService: IStorageService
	) {
		super();

		const startupTimer = setTimeout(() => {
			this._didAutoReopen = true;
		}, 3000);
		this._register({ dispose: () => clearTimeout(startupTimer) });

		this._register(
			editorService.onDidVisibleEditorsChange(() => {
				if (this._didAutoReopen) {
					return;
				}
				this._onVisibleEditorsChanged(editorService);
			})
		);
	}

	private _onVisibleEditorsChanged(editorService: IEditorService): void {
		const activeEditor = editorService.activeEditor;
		if (!(activeEditor instanceof EditorInput)) {
			return;
		}

		const resource = activeEditor.resource;
		if (!resource || !resource.path.endsWith('.md')) {
			return;
		}

		if (_previewManager && _previewManager.hasActivePreview()) {
			return;
		}

		if (!MarkdownPreviewManager.wasPreviewOpen(this._storageService, resource)) {
			return;
		}

		this._didAutoReopen = true;
		const manager = this._instantiationService.createInstance(MarkdownPreviewManager);
		_previewManager = manager;
		manager.showPreview(true);
	}
}

registerWorkbenchContribution2(MarkdownPreviewAutoReopen.ID, MarkdownPreviewAutoReopen, WorkbenchPhase.BlockStartup);

CommandsRegistry.registerCommand('markdown.showPreview', accessor => {
	const manager = getOrCreateManager(accessor);
	manager.showPreview();
});

CommandsRegistry.registerCommand('markdown.showPreviewToSide', accessor => {
	const manager = getOrCreateManager(accessor);
	manager.showPreview(true);
});

CommandsRegistry.registerCommand('markdown.showSource', async accessor => {
	const manager = getOrCreateManager(accessor);
	await manager.showSource();
});

CommandsRegistry.registerCommand('markdown.togglePreview', accessor => {
	const manager = getOrCreateManager(accessor);
	manager.toggle();
});

CommandsRegistry.registerCommand('markdown.preview.refresh', accessor => {
	getOrCreateManager(accessor).refresh();
});

CommandsRegistry.registerCommand('markdown.preview.toggleLock', accessor => {
	getOrCreateManager(accessor).toggleLock();
});

interface MarkdownSecurityPick extends IQuickPickItem {
	id: 'strict' | 'allowScripts';
}

CommandsRegistry.registerCommand('markdown.showPreviewSecuritySelector', async accessor => {
	const pick = await accessor.get(IQuickInputService).pick<MarkdownSecurityPick>(
		[
			{
				id: 'strict',
				label: 'Strict',
				description: 'Do not execute scripts in the Markdown preview'
			},
			{
				id: 'allowScripts',
				label: 'Allow scripts',
				description: 'Let the preview webview run scripts from the rendered document'
			}
		],
		{ placeHolder: 'Select Markdown preview security level' }
	);
	if (!pick) {
		return;
	}
	getOrCreateManager(accessor).setAllowScripts(pick.id === 'allowScripts');
});

CommandsRegistry.registerCommand('markdown.findAllFileReferences', _accessor => {
	// Workspace-wide reference search for the current heading is not wired yet.
});

CommandsRegistry.registerCommand('markdown.reopenAsPreview', accessor => {
	getOrCreateManager(accessor).showPreview();
});

CommandsRegistry.registerCommand('markdown.reopenAsSource', async accessor => {
	await getOrCreateManager(accessor).showSource();
});
