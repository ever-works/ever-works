import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';
import type { GtmFollowUpItem } from '../types.js';

/**
 * `follow-up` stage — timed re-engagement planning.
 *
 * Inputs: `action_log`. Outputs: `follow_up_queue`.
 *
 * Deterministic: every `prepared` action queues a follow-up due after the
 * configured quiet-days window. A timer entry point re-enters the `draft`
 * stage with this queue when the window elapses without a reply (the
 * timer wiring rides the event-ingest spine milestone; this stage owns
 * the declared queue contract).
 */
export class FollowUpStep extends BaseGtmStep {
	readonly stepId = 'follow-up' as const;
	readonly name = 'Follow-up';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const settings = this.settingsOf(context);
		const queue: GtmFollowUpItem[] = context.actionLog
			.filter((record) => record.status === 'prepared')
			.map((record) => ({
				draftRef: record.draftRef,
				channel: record.channel,
				dueAfterDays: settings.followUpQuietDays,
				rationale: `No response within ${settings.followUpQuietDays} day(s) of preparation (${settings.cadence} cadence).`
			}));

		context.followUpQueue = queue;
		execContext.logger.log(`[${context.work.slug}] Follow-up complete — queued ${queue.length} item(s)`);
		return context;
	}
}
