import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';
import type { GtmActionRecord } from '../types.js';

/**
 * `act` stage — stages approved drafts for delivery.
 *
 * Inputs: `approved_drafts`. Outputs: `action_log`.
 *
 * Drafts-not-sends: this stage NEVER performs the outbound send itself.
 * It records one `prepared` action per approved draft; actual delivery
 * happens through channel connectors (later milestones) or a human,
 * which consume the action log. Unapproved drafts are logged as
 * `skipped` so the audit trail is complete.
 */
export class ActStep extends BaseGtmStep {
	readonly stepId = 'act' as const;
	readonly name = 'Act';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const now = Date.now();
		const approvedRefs = new Set(context.approvedDrafts.map((draft) => draft.ref));
		const actionLog: GtmActionRecord[] = [];

		for (const draft of context.drafts) {
			if (approvedRefs.has(draft.ref)) {
				actionLog.push({
					draftRef: draft.ref,
					channel: draft.channel,
					status: 'prepared',
					reason: null,
					preparedAt: now
				});
			} else {
				actionLog.push({
					draftRef: draft.ref,
					channel: draft.channel,
					status: 'skipped',
					reason: 'not approved in review',
					preparedAt: now
				});
			}
		}

		context.actionLog = actionLog;
		const prepared = actionLog.filter((record) => record.status === 'prepared').length;
		execContext.logger.log(
			`[${context.work.slug}] Act complete — prepared ${prepared}, skipped ${actionLog.length - prepared}`
		);
		return context;
	}
}
