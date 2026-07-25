import { z } from 'zod';
import type { StepExecutionContext } from '@ever-works/plugin';
import { BaseGtmStep } from '../base-step.js';
import type { GtmPipelineContext } from '../context.js';
import { GTM_PROMPT_KEYS } from '../prompt-keys.js';
import type { GtmContact, GtmSignal } from '../types.js';

/**
 * Prompt contract — research query planning.
 *
 * Input: the campaign brief (`{campaign_brief}`, untrusted user text).
 * Output: up to {max_queries} short web-search queries that would surface
 * fresh public signals (news, launches, hiring, funding, community posts)
 * relevant to the campaign's audience. Queries only — no commentary.
 */
const RESEARCH_QUERIES_PROMPT = `
# Go-to-Market Signal Query Planning

You plan web-search queries that surface fresh, public market signals
(news, launches, hiring, funding, community discussions) relevant to a
go-to-market campaign.

Rules:
- Produce at most {max_queries} queries.
- Each query is short (3-8 words) and self-contained.
- Focus on signals about the campaign's target audience or market, not
  generic definitions.
- Never invent company or person names that are not in the brief.

<campaign_brief untrusted="true">
{campaign_brief}
</campaign_brief>` as const;

const researchQueriesSchema = z.object({
	queries: z.array(z.string()).describe('Short web-search queries for market signals')
});

const MAX_SIGNAL_QUERIES = 3;
const MAX_RESULTS_PER_QUERY = 5;

/**
 * `research` stage — collects leads and market signals.
 *
 * Inputs: seed contacts from `request.config.contacts` (explicit list —
 * this stage never fabricates people) + the campaign brief (`request.prompt`).
 * Outputs: `contacts` (normalized + deduplicated) and `signals`
 * (search-facade results for AI-planned signal queries, best-effort).
 */
export class ResearchStep extends BaseGtmStep {
	readonly stepId = 'research' as const;
	readonly name = 'Research';

	async execute(context: GtmPipelineContext, execContext: StepExecutionContext): Promise<GtmPipelineContext> {
		const { logger } = execContext;
		const config = context.request.config ?? {};

		context.contacts = this.normalizeSeedContacts(config.contacts);
		if (context.contacts.length === 0) {
			this.addWarning(
				context,
				'Research: no seed contacts provided (config.contacts) — downstream stages will only produce channel content.'
			);
		}

		const brief = (context.request.prompt ?? '').trim();
		if (brief) {
			context.signals = await this.collectSignals(context, execContext, brief);
		}

		logger.log(
			`[${context.work.slug}] Research complete — ${context.contacts.length} contacts, ${context.signals.length} signals`
		);
		return context;
	}

	private normalizeSeedContacts(raw: unknown): GtmContact[] {
		if (!Array.isArray(raw)) return [];
		const seen = new Set<string>();
		const contacts: GtmContact[] = [];
		for (const entry of raw) {
			if (typeof entry !== 'object' || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const name = typeof record.name === 'string' ? record.name.trim() : '';
			const email = typeof record.email === 'string' ? record.email.trim() : '';
			if (!name && !email) continue;
			const dedupeKey = (email || name).toLowerCase();
			if (seen.has(dedupeKey)) continue;
			seen.add(dedupeKey);
			contacts.push({
				name: name || email,
				email: email || null,
				company: typeof record.company === 'string' ? record.company.trim() || null : null,
				title: typeof record.title === 'string' ? record.title.trim() || null : null,
				source: typeof record.source === 'string' ? record.source.trim() || null : 'seed-list',
				notes: typeof record.notes === 'string' ? record.notes.trim() || null : null
			});
		}
		return contacts;
	}

	private async collectSignals(
		context: GtmPipelineContext,
		execContext: StepExecutionContext,
		brief: string
	): Promise<GtmSignal[]> {
		const { aiFacade, searchFacade, promptFacade, logger } = execContext;
		const facadeOptions = this.facadeOptions(execContext);
		try {
			const resolvedPrompt = (
				promptFacade
					? await promptFacade.getPrompt(GTM_PROMPT_KEYS.RESEARCH_QUERIES, RESEARCH_QUERIES_PROMPT)
					: RESEARCH_QUERIES_PROMPT
			) as typeof RESEARCH_QUERIES_PROMPT;
			const { result } = await aiFacade.askJson(
				resolvedPrompt,
				researchQueriesSchema,
				{
					temperature: 0,
					variables: { campaign_brief: brief, max_queries: String(MAX_SIGNAL_QUERIES) },
					routing: { complexity: 'simple', taskId: 'gtm-research-queries' }
				},
				facadeOptions
			);
			const queries = result.queries
				.filter((q) => typeof q === 'string' && q.trim().length > 0)
				.slice(0, MAX_SIGNAL_QUERIES);

			const signals: GtmSignal[] = [];
			for (const query of queries) {
				try {
					const results = await searchFacade.search(
						query,
						{ maxResults: MAX_RESULTS_PER_QUERY },
						facadeOptions
					);
					for (const item of results) {
						signals.push({
							query,
							title: item.title,
							url: item.url,
							publishedDate: item.publishedDate ?? null
						});
					}
				} catch (error) {
					logger.warn(`Research signal query failed ("${query}"): ${this.formatError(error)}`);
				}
			}
			return signals;
		} catch (error) {
			this.addWarning(context, `Research: signal collection degraded — ${this.formatError(error)}`);
			return [];
		}
	}
}
