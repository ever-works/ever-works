import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';

/**
 * `review` stage — the human gate placed BEFORE any outbound action.
 *
 * Inputs: `drafts`. Outputs: `approved_drafts`.
 *
 * Contract:
 * - When review is required (default) and no approvals were supplied via
 *   `request.config.approved_draft_refs`, the run pauses: `pendingReview`
 *   is set, `shouldStop` stops the engine, and the checkpoint stays
 *   viable so the run can resume once approvals arrive.
 * - `approved_draft_refs` may be `'all'` or an array of draft refs.
 *   Unknown refs are ignored with a warning.
 * - When review is disabled in settings, all drafts pass with an explicit
 *   warning so the audit trail records the auto-approval.
 */
export class ReviewStep extends BaseGtmStep {
	readonly stepId = 'review' as const;
	readonly name = 'Review';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const settings = this.settingsOf(context);
		const config = context.request.config ?? {};
		const approvals = config.approved_draft_refs;

		if (context.drafts.length === 0) {
			context.approvedDrafts = [];
			context.pendingReview = false;
			return context;
		}

		if (!settings.reviewRequired) {
			context.approvedDrafts = [...context.drafts];
			context.pendingReview = false;
			this.addWarning(
				context,
				`Review: review_required is disabled — auto-approved ${context.drafts.length} draft(s).`
			);
			return context;
		}

		if (approvals === 'all') {
			context.approvedDrafts = [...context.drafts];
			context.pendingReview = false;
		} else if (Array.isArray(approvals)) {
			const requested = new Set(approvals.filter((ref): ref is string => typeof ref === 'string'));
			const known = new Set(context.drafts.map((draft) => draft.ref));
			for (const ref of requested) {
				if (!known.has(ref)) {
					this.addWarning(context, `Review: ignored unknown draft ref "${ref}".`);
				}
			}
			context.approvedDrafts = context.drafts.filter((draft) => requested.has(draft.ref));
			context.pendingReview = false;
			if (context.approvedDrafts.length === 0) {
				this.addWarning(context, 'Review: approvals supplied but none matched — no drafts approved.');
			}
		} else {
			// No approval input yet — pause the run at the gate.
			context.approvedDrafts = [];
			context.pendingReview = true;
			context.shouldStop = true;
			this.addWarning(
				context,
				`Review: awaiting human approval for ${context.drafts.length} draft(s) before any outbound action.`
			);
		}

		execContext.logger.log(
			`[${context.work.slug}] Review complete — approved ${context.approvedDrafts.length}/${context.drafts.length}` +
				(context.pendingReview ? ' (pending human review)' : '')
		);
		return context;
	}
}
