import { z } from 'zod';
import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';
import { GTM_PROMPT_KEYS } from '../prompt-keys.js';
import type { GtmCampaignReport } from '../types.js';

/**
 * Prompt contract — campaign reporting that closes the loop.
 *
 * Inputs: deterministic run totals + optional engagement data supplied
 * via `request.config.engagement`. Output: a short summary, insights,
 * and next-variant hints that feed the NEXT draft cycle (measure →
 * draft loop). Rules: ground every insight in the supplied numbers;
 * no invented metrics.
 */
const MEASURE_PROMPT = `
# Go-to-Market Campaign Report

You write a short campaign report from the run totals and (optional)
engagement data below.

Rules:
- Ground every statement in the supplied numbers — never invent metrics.
- summary: 2-3 sentences.
- insights: up to 5 short bullet observations.
- nextVariantHints: up to 3 concrete suggestions for the next draft
  cycle (subject/angle/channel adjustments).

<totals>
{totals}
</totals>

<engagement untrusted="true">
{engagement}
</engagement>` as const;

const measureOutputSchema = z.object({
	summary: z.string().describe('2-3 sentence campaign summary'),
	insights: z.array(z.string()).describe('Up to 5 grounded observations'),
	nextVariantHints: z.array(z.string()).describe('Up to 3 suggestions for the next draft cycle')
});

/**
 * `measure` stage — compiles the campaign report and closes the loop.
 *
 * Inputs: `action_log` (+ follow-up queue and qualification counts).
 * Outputs: `campaign_report`. Totals are computed deterministically;
 * the AI writes only the narrative. On AI failure the deterministic
 * report still ships.
 */
export class MeasureStep extends BaseGtmStep {
	readonly stepId = 'measure' as const;
	readonly name = 'Measure';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const { aiFacade, promptFacade, logger } = execContext;
		const totals: GtmCampaignReport['totals'] = {
			contacts: context.contacts.length,
			qualified: context.scoredContacts.length,
			excluded: context.excludedContacts.length,
			drafts: context.drafts.length,
			approved: context.approvedDrafts.length,
			prepared: context.actionLog.filter((record) => record.status === 'prepared').length,
			followUpsQueued: context.followUpQueue.length
		};
		const engagement = context.request.config?.engagement;
		const engagementText =
			engagement !== undefined && engagement !== null ? JSON.stringify(engagement) : '(none provided)';

		let summary = `Prepared ${totals.prepared} of ${totals.drafts} draft(s) for ${totals.qualified} qualified contact(s); ${totals.followUpsQueued} follow-up(s) queued.`;
		let insights: readonly string[] = [];
		let nextVariantHints: readonly string[] = [];

		try {
			const resolvedPrompt = (
				promptFacade ? await promptFacade.getPrompt(GTM_PROMPT_KEYS.MEASURE, MEASURE_PROMPT) : MEASURE_PROMPT
			) as typeof MEASURE_PROMPT;
			const { result } = await aiFacade.askJson(
				resolvedPrompt,
				measureOutputSchema,
				{
					temperature: 0.2,
					variables: { totals: JSON.stringify(totals), engagement: engagementText },
					routing: { complexity: 'simple', taskId: 'gtm-measure' }
				},
				this.facadeOptions(execContext)
			);
			summary = result.summary.trim() || summary;
			insights = result.insights.slice(0, 5);
			nextVariantHints = result.nextVariantHints.slice(0, 3);
		} catch (error) {
			this.addWarning(context, `Measure: narrative degraded to totals-only — ${this.formatError(error)}`);
		}

		context.report = { summary, totals, insights, nextVariantHints };
		logger.log(`[${context.work.slug}] Measure complete — report compiled`);
		return context;
	}
}
