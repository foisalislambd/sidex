/*---------------------------------------------------------------------------------------------
 *  SideX Terminal AI — floating prompt for the integrated terminal.
 *
 *  Mirrors the Cmd/Ctrl+K inline-edit flow, but the result is a shell command
 *  instead of a code replacement. The command is never executed automatically:
 *  the user chooses Insert (leaves it on the prompt line) or Run.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';

export interface ITerminalAIWidgetCallbacks {
	/** Called when the user submits a natural-language request. */
	onSubmit(instruction: string): void;
	/** Called when the widget is dismissed without applying anything. */
	onCancel(): void;
	/** Called when the user accepts the generated command. */
	onAccept(command: string, execute: boolean): void;
}

const $ = document.createElement.bind(document);

export class TerminalAIWidget extends Disposable {
	private readonly _overlay: HTMLElement;
	private readonly _card: HTMLElement;
	private readonly _input: HTMLInputElement;
	private readonly _submitButton: HTMLButtonElement;
	private readonly _status: HTMLElement;
	private readonly _resultBox: HTMLElement;
	private readonly _resultCode: HTMLElement;
	private readonly _insertButton: HTMLButtonElement;
	private readonly _runButton: HTMLButtonElement;

	private _command = '';
	private _busy = false;
	private _restoreContainerPosition: string | null = null;

	constructor(
		private readonly _container: HTMLElement,
		private readonly _callbacks: ITerminalAIWidgetCallbacks,
	) {
		super();

		// The xterm container is usually positioned already; if not, make it a
		// containing block so `position: absolute` children anchor to it.
		const computed = getComputedStyle(this._container);
		if (computed.position === 'static') {
			this._restoreContainerPosition = this._container.style.position;
			this._container.style.position = 'relative';
		}

		this._overlay = $('div');
		this._overlay.className = 'sidex-terminal-ai-overlay';

		this._card = $('div');
		this._card.className = 'sidex-terminal-ai-card';
		this._overlay.appendChild(this._card);

		const label = $('div');
		label.className = 'sidex-terminal-ai-label';
		label.textContent = localize('sidexTerminalAI', 'SideX Terminal AI');
		this._card.appendChild(label);

		const inputRow = $('div');
		inputRow.className = 'sidex-terminal-ai-input-row';
		this._card.appendChild(inputRow);

		this._input = $('input') as HTMLInputElement;
		this._input.className = 'sidex-terminal-ai-input';
		this._input.type = 'text';
		this._input.spellcheck = false;
		this._input.placeholder = localize('sidexTerminalAIPlaceholder', 'Describe the command you want…');
		inputRow.appendChild(this._input);

		this._submitButton = $('button') as HTMLButtonElement;
		this._submitButton.className = 'sidex-terminal-ai-submit';
		this._submitButton.textContent = localize('sidexTerminalAISubmit', 'Generate');
		inputRow.appendChild(this._submitButton);

		this._status = $('div');
		this._status.className = 'sidex-terminal-ai-status';
		this._card.appendChild(this._status);

		this._resultBox = $('div');
		this._resultBox.className = 'sidex-terminal-ai-result-box';
		this._resultBox.style.display = 'none';
		this._card.appendChild(this._resultBox);

		this._resultCode = $('code');
		this._resultCode.className = 'sidex-terminal-ai-result';
		this._resultBox.appendChild(this._resultCode);

		const actions = $('div');
		actions.className = 'sidex-terminal-ai-actions';
		this._resultBox.appendChild(actions);

		this._insertButton = $('button') as HTMLButtonElement;
		this._insertButton.className = 'sidex-terminal-ai-insert';
		this._insertButton.textContent = localize('sidexTerminalAIInsert', 'Insert');
		this._insertButton.title = localize('sidexTerminalAIInsertTitle', 'Put the command on the prompt without running it');
		actions.appendChild(this._insertButton);

		this._runButton = $('button') as HTMLButtonElement;
		this._runButton.className = 'sidex-terminal-ai-run';
		this._runButton.textContent = localize('sidexTerminalAIRun', 'Run');
		this._runButton.title = localize('sidexTerminalAIRunTitle', 'Insert the command and press Enter');
		actions.appendChild(this._runButton);

		const cancelButton = $('button') as HTMLButtonElement;
		cancelButton.className = 'sidex-terminal-ai-cancel';
		cancelButton.textContent = localize('sidexTerminalAICancel', 'Cancel');
		actions.appendChild(cancelButton);

		this._registerDomListeners(cancelButton);

		this._container.appendChild(this._overlay);
		requestAnimationFrame(() => this._input.focus());
	}

	private _registerDomListeners(cancelButton: HTMLButtonElement): void {
		const onInputKeyDown = (e: KeyboardEvent) => {
			// Keep the terminal from seeing keys typed into the prompt.
			e.stopPropagation();
			if (e.key === 'Escape') {
				e.preventDefault();
				this._callbacks.onCancel();
			} else if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._submit();
			}
		};
		this._input.addEventListener('keydown', onInputKeyDown);

		this._submitButton.addEventListener('click', () => this._submit());
		cancelButton.addEventListener('click', () => this._callbacks.onCancel());
		this._insertButton.addEventListener('click', () => {
			if (this._command) {
				this._callbacks.onAccept(this._command, false);
			}
		});
		this._runButton.addEventListener('click', () => {
			if (this._command) {
				this._callbacks.onAccept(this._command, true);
			}
		});
	}

	private _submit(): void {
		if (this._busy) {
			return;
		}
		const value = this._input.value.trim();
		if (!value) {
			return;
		}
		this._busy = true;
		this._submitButton.disabled = true;
		this._status.textContent = localize('sidexTerminalAIThinking', 'Generating command…');
		this._resultBox.style.display = 'none';
		this._callbacks.onSubmit(value);
	}

	/** Stream a partial command into the result box as tokens arrive. */
	appendChunk(text: string): void {
		this._command += text;
		this._resultBox.style.display = 'block';
		this._resultCode.textContent = this._command;
		this._status.textContent = '';
	}

	/**
	 * Finish streaming. The server may wrap the command in backticks or add a
	 * leading `$`; strip those so the terminal gets a runnable line.
	 */
	finish(): void {
		this._busy = false;
		this._submitButton.disabled = false;
		this._command = cleanCommand(this._command);
		this._resultCode.textContent = this._command;
		this._resultBox.style.display = this._command ? 'block' : 'none';
		if (this._command) {
			this._status.textContent = '';
			this._runButton.focus();
		} else {
			this._status.textContent = localize('sidexTerminalAIEmpty', 'No command was generated. Try rephrasing.');
		}
	}

	setError(message: string): void {
		this._busy = false;
		this._submitButton.disabled = false;
		this._status.textContent = localize('sidexTerminalAIError', 'Error: {0}', message);
	}

	get command(): string {
		return this._command;
	}

	override dispose(): void {
		if (this._restoreContainerPosition !== null) {
			this._container.style.position = this._restoreContainerPosition;
		}
		this._overlay.remove();
		super.dispose();
	}
}

function cleanCommand(raw: string): string {
	let cmd = raw.trim();
	// Strip a fenced block if the model ignored the instruction.
	const fence = cmd.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
	if (fence) {
		cmd = fence[1].trim();
	}
	// Strip a leading shell prompt the model sometimes echoes.
	cmd = cmd.replace(/^\$\s+/, '');
	// Keep a single logical line; stray trailing newlines would execute early.
	return cmd.split('\n').map(l => l.trimEnd()).join('\n').trim();
}
