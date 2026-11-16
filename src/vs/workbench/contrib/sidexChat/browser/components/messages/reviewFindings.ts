/*---------------------------------------------------------------------------------------------
 *  Review Findings — structured review result cards (Bugbot-style triage).
 *
 *  The server's `POST /v1/review` in `format: "findings"` mode returns one JSON
 *  object per problem instead of prose. This component renders those as cards
 *  with severity, location, explanation and per-finding actions (go to / fix /
 *  dismiss), so a review is something you can act on rather than read.
 *--------------------------------------------------------------------------------------------*/

import { Component, DOM, $ } from '../base.js';
import { IChatMessage, IReviewFinding } from '../../sidexChatService.js';

export interface ReviewFindingActions {
	onGoTo: (file: string, line: number) => void;
	onFix: (finding: IReviewFinding) => void;
	onSetDismissed: (finding: IReviewFinding, dismissed: boolean) => void;
}

const SEVERITY_ORDER: Record<IReviewFinding['severity'], number> = {
	critical: 0, major: 1, minor: 2, nit: 3,
};

const SEVERITY_LABEL: Record<IReviewFinding['severity'], string> = {
	critical: 'Critical', major: 'Major', minor: 'Minor', nit: 'Nit',
};

export class ReviewFindings extends Component {
	constructor(
		private readonly _msg: IChatMessage,
		private readonly _actions?: ReviewFindingActions,
	) {
		super('div', 'sc-review-findings');
		this.render();
	}

	/** Re-render in place after a status change (fix requested / dismissed). */
	render(): void {
		this.clear();
		const findings = this._msg.findings ?? [];
		const summary = this._msg.reviewSummary?.trim();

		if (summary) {
			const head = this.append('div', 'sc-review-summary');
			head.textContent = summary;
		}

		if (findings.length === 0) {
			const empty = this.append('div', 'sc-review-empty');
			empty.textContent = 'No issues found in the pending changes.';
			return;
		}

		const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

		const counts = { critical: 0, major: 0, minor: 0, nit: 0 };
		for (const f of findings) { counts[f.severity]++; }
		const openCount = findings.filter(f => f.status !== 'dismissed').length;

		const header = this.append('div', 'sc-review-header');
		const title = DOM.append(header, $('span.sc-review-title'));
		title.textContent = `${openCount} of ${findings.length} finding${findings.length === 1 ? '' : 's'}`;
		const chips = DOM.append(header, $('span.sc-review-chips'));
		(['critical', 'major', 'minor', 'nit'] as const).forEach(sev => {
			if (!counts[sev]) { return; }
			const chip = DOM.append(chips, $(`span.sc-review-chip.sc-review-chip-${sev}`));
			chip.textContent = `${counts[sev]} ${SEVERITY_LABEL[sev].toLowerCase()}`;
		});

		const list = this.append('div', 'sc-review-list');
		for (const finding of sorted) {
			this._renderCard(list, finding);
		}
	}

	private _renderCard(parent: HTMLElement, finding: IReviewFinding): void {
		const dismissed = finding.status === 'dismissed';
		const card = DOM.append(parent, $(`div.sc-review-card.sc-review-${finding.severity}${dismissed ? '.sc-review-dismissed' : ''}`));

		const top = DOM.append(card, $('div.sc-review-card-top'));
		const badge = DOM.append(top, $(`span.sc-review-badge.sc-review-badge-${finding.severity}`));
		badge.textContent = SEVERITY_LABEL[finding.severity];

		const cardTitle = DOM.append(top, $('span.sc-review-card-title'));
		cardTitle.textContent = finding.title;

		if (finding.file) {
			const loc = DOM.append(top, $('button.sc-review-location'));
			const shortFile = finding.file.split(/[\\/]/).pop() || finding.file;
			loc.textContent = finding.endLine && finding.endLine !== finding.line
				? `${shortFile}:${finding.line}-${finding.endLine}`
				: `${shortFile}:${finding.line}`;
			loc.title = finding.file;
			this.on(loc, 'click', () => this._actions?.onGoTo(finding.file, finding.line));
		}

		if (finding.body) {
			const body = DOM.append(card, $('div.sc-review-body'));
			body.textContent = finding.body;
		}

		if (finding.suggestion) {
			const suggestion = DOM.append(card, $('pre.sc-review-suggestion'));
			suggestion.textContent = finding.suggestion;
		}

		const actions = DOM.append(card, $('div.sc-review-actions'));

		const fixBtn = DOM.append(actions, $('button.sc-review-btn.sc-review-fix'));
		if (finding.status === 'fixing') {
			fixBtn.textContent = 'Fix requested';
			fixBtn.setAttribute('disabled', 'true');
			fixBtn.classList.add('sc-review-btn-muted');
		} else {
			fixBtn.textContent = 'Fix with agent';
			fixBtn.title = 'Ask the agent to fix this finding (goes through the normal edit permission flow)';
			this.on(fixBtn, 'click', () => {
				if (dismissed) {
					this._actions?.onSetDismissed(finding, false);
				}
				this._actions?.onFix(finding);
			});
		}

		const dismissBtn = DOM.append(actions, $('button.sc-review-btn.sc-review-dismiss'));
		dismissBtn.textContent = dismissed ? 'Restore' : 'Dismiss';
		this.on(dismissBtn, 'click', () => {
			this._actions?.onSetDismissed(finding, !dismissed);
		});
	}
}
