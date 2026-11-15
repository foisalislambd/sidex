/*---------------------------------------------------------------------------------------------
 *  Sidex Complete — Next-edit prediction ("Tab to jump").
 *
 *  A completion guesses the text that continues the line; a next-edit
 *  prediction guesses *where the programmer will edit next* and what the edit
 *  is. When the answer is somewhere other than the cursor, the ghost text is
 *  rendered at that range, so pressing Tab accepts the predicted edit in place.
 *
 *  The prediction is requested only when the model can justify one: the
 *  tracker must have seen an edit recently, and the same model version is never
 *  asked twice.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import {
	InlineCompletion,
	InlineCompletionContext,
	InlineCompletions,
	InlineCompletionsProvider,
} from '../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IRecentEditTracker } from './recentEditTracker.js';

const PREFIX_CHARS = 12000;
const SUFFIX_CHARS = 3000;
const DEBOUNCE_MS = 450;
const MIN_MS_BETWEEN_REQUESTS = 1200;
/** Predictions older than this are dropped rather than shown against newer code. */
const PREDICTION_TTL_MS = 30_000;

export interface INextEditPrediction {
	kind: 'jump' | 'insert' | 'none';
	file_path?: string;
	line?: number;
	character?: number;
	start_line?: number;
	end_line?: number;
	replacement?: string;
	reason?: string;
}

interface ICachedPrediction {
	requestVersionId: number;
	receivedAt: number;
	prediction: INextEditPrediction;
	/** The cursor position the request was made from, in the same model. */
	anchor: Position;
}

export class SidexNextEditProvider implements InlineCompletionsProvider {
	private readonly _cache = new Map<string, ICachedPrediction>();
	private readonly _inFlight = new Map<string, Promise<INextEditPrediction | null>>();
	private _lastTriggeredAt = 0;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _pendingResolve: ((value: INextEditPrediction | null) => void) | null = null;

	constructor(
		private readonly _configService: IConfigurationService,
		private readonly _recentEdits: IRecentEditTracker,
		private readonly _serverUrl: () => string,
	) { }

	private get _enabled(): boolean {
		return this._configService.getValue<boolean>('sidex.nextEdit.enabled') !== false;
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		_context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions> {
		const empty: InlineCompletions = { items: [] };

		if (!this._enabled || token.isCancellationRequested || model.isDisposed()) {
			return empty;
		}

		// Without a recent edit there is no signal about what comes next; asking
		// the model anyway would produce confident noise on every cursor move.
		if (this._recentEdits.getRecentEdits(1).length === 0) {
			this._cache.delete(model.uri.toString());
			return empty;
		}

		const key = model.uri.toString();
		const cached = this._cache.get(key);
		const now = Date.now();

		let prediction: INextEditPrediction | null;
		if (cached
			&& cached.requestVersionId === model.getVersionId()
			&& now - cached.receivedAt < PREDICTION_TTL_MS
			&& Position.equals(cached.anchor, position)) {
			prediction = cached.prediction;
		} else {
			prediction = await this._requestPrediction(model, position, token);
			if (!prediction || token.isCancellationRequested) {
				return empty;
			}
			this._cache.set(key, {
				requestVersionId: model.getVersionId(),
				receivedAt: Date.now(),
				prediction,
				anchor: position,
			});
		}

		const item = this._toInlineItem(model, position, prediction);
		return item ? { items: [item] } : empty;
	}

	freeInlineCompletions(): void {
		// Nothing retained per completion set.
	}

	disposeInlineCompletions(): void {
		// Nothing retained per completion set.
	}

	dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}
		this._pendingResolve?.(null);
		this._pendingResolve = null;
		this._cache.clear();
		this._inFlight.clear();
	}

	/**
	 * Turn a prediction into an inline item, or null when the prediction would
	 * be a no-op (same text already there) or is out of range for this model.
	 *
	 * The inline-completion contract only allows the primary range to cover a
	 * single line, so a multi-line predicted edit is expressed as "replace the
	 * first line, then delete the tail" — replacement text may contain newlines
	 * as long as its range ends at end-of-line.
	 */
	private _toInlineItem(
		model: ITextModel,
		cursor: Position,
		prediction: INextEditPrediction,
	): InlineCompletion | null {
		if (prediction.kind !== 'jump' && prediction.kind !== 'insert') {
			return null;
		}
		const replacement = prediction.replacement ?? '';
		if (replacement.trim().length === 0) {
			return null;
		}

		// A prediction for a different file than the one being rendered is not
		// actionable here: the client cannot navigate to it from ghost text.
		if (prediction.file_path && model.uri.fsPath && prediction.file_path !== model.uri.fsPath) {
			return null;
		}

		const maxLine = model.getLineCount();
		const requestedStart = prediction.start_line ?? prediction.line ?? cursor.lineNumber;
		const startLine = clamp(requestedStart, 1, maxLine);
		const endLine = clamp(prediction.end_line ?? requestedStart, startLine, maxLine);
		const multiLine = startLine !== endLine || replacement.includes('\n');

		let range: Range;
		if (multiLine) {
			range = new Range(startLine, 1, startLine, model.getLineMaxColumn(startLine));
		} else {
			const startColumn = clamp(prediction.character ?? 1, 1, model.getLineMaxColumn(startLine));
			range = new Range(startLine, startColumn, startLine, model.getLineMaxColumn(startLine));
		}

		const tail: { range: Range; text: string }[] = [];
		if (endLine > startLine) {
			tail.push({
				range: new Range(startLine + 1, 1, endLine, model.getLineMaxColumn(endLine)),
				text: '',
			});
		}

		// Reject predictions that would not change anything: models sometimes
		// echo the existing line back, and ghost text identical to the code
		// underneath it is just noise.
		if (!multiLine && model.getValueInRange(range) === replacement) {
			return null;
		}

		// Predictions anchored at the cursor are ordinary completions; the FIM
		// provider already covers those, so only surface the "away from cursor"
		// case that makes next-edit distinct.
		if (prediction.kind === 'insert' && startLine === cursor.lineNumber) {
			return null;
		}

		return {
			insertText: replacement,
			range,
			additionalTextEdits: tail.length > 0 ? tail : undefined,
		};
	}

	private async _requestPrediction(
		model: ITextModel,
		position: Position,
		token: CancellationToken,
	): Promise<INextEditPrediction | null> {
		const key = `${model.uri.toString()}@${model.getVersionId()}@${position.lineNumber}:${position.column}`;
		const existing = this._inFlight.get(key);
		if (existing) {
			return existing;
		}

		const request = new Promise<INextEditPrediction | null>((resolve) => {
			const run = async () => {
				const now = Date.now();
				if (now - this._lastTriggeredAt < MIN_MS_BETWEEN_REQUESTS) {
					resolve(null);
					return;
				}
				this._lastTriggeredAt = now;

				try {
					const offset = model.getOffsetAt(position);
					const full = model.getValue();
					const prefixStart = Math.max(0, offset - PREFIX_CHARS);
					const prefix = full.slice(prefixStart, offset);
					const suffix = full.slice(offset, offset + SUFFIX_CHARS);
					const prefixLine = model.getPositionAt(prefixStart).lineNumber;

					const controller = new AbortController();
					const sub = token.onCancellationRequested(() => controller.abort());

					try {
						const resp = await fetch(`${this._serverUrl()}/v1/next-edit`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({
								file_path: model.uri.fsPath,
								language: model.getLanguageId(),
								prefix,
								suffix,
								prefix_line: prefixLine,
								recent_edits: this._recentEdits.getRecentEdits(3).map(entry => {
									const newline = entry.indexOf('\n');
									const header = newline >= 0 ? entry.slice(0, newline) : entry;
									return {
										file_path: header.replace(/^---\s*/, ''),
										diff: entry,
									};
								}),
							}),
							signal: controller.signal,
						});
						if (!resp.ok) {
							resolve(null);
							return;
						}
						const data = await resp.json() as INextEditPrediction;
						resolve(data && data.kind !== 'none' ? data : null);
					} finally {
						sub.dispose();
					}
				} catch {
					resolve(null);
				}
			};

			// Coalesce the burst of requests a single keystroke produces into one.
			if (this._debounceTimer) {
				clearTimeout(this._debounceTimer);
				this._pendingResolve?.(null);
			}
			this._pendingResolve = resolve;
			this._debounceTimer = setTimeout(() => {
				this._debounceTimer = undefined;
				this._pendingResolve = null;
				void run();
			}, DEBOUNCE_MS);
		});

		this._inFlight.set(key, request);
		void request.finally(() => this._inFlight.delete(key));
		return request;
	}
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.min(Math.max(Math.trunc(value), min), max);
}
