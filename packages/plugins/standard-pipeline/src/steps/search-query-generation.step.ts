import { z } from 'zod';
import type { StepExecutionContext, FacadeOptions } from '@ever-works/plugin';
import { getCurrentDateString } from '@ever-works/plugin';
import type { MutableGenerationContext, StandardPipelineMetrics } from '../context/index.js';
import { BasePipelineStep } from '../base-pipeline-step.js';
import { getErrorStack } from '../utils/error.utils.js';
import { appendCustomPrompt } from '../utils/prompt.utils.js';
import { PROMPT_KEYS } from '../prompt-keys.js';

const SEARCH_QUERY_PROMPT =
	`You are a work builder generating search queries to find the most relevant, official sources.

Topic: "{name}"
Description: "{description}"
Target keywords: {keywords}
Today is {date}.

Rules:
- Generate {query_count} distinct, high-intent search queries as an array of strings.
- Prefer queries that surface official resources (homepages, docs, repositories) over listicles.
- Mix broad and long-tail variations to improve recall.` as const;

const searchQuerySchema = z
	.object({
		queries: z.array(z.string().min(3))
	})
	.strict();

/**
 * Search Query Generation Step
 *
 * Generates search queries using AI based on the topic.
 */
export class SearchQueryGenerationStep extends BasePipelineStep {
	readonly name = 'Search Query Generation';
	readonly stepId = 'search-queries-generation' as const;

	async execute(
		context: MutableGenerationContext,
		execContext: StepExecutionContext
	): Promise<MutableGenerationContext> {
		const { request, work, metrics, advancedPrompts } = context;
		const { logger, aiFacade, promptFacade } = execContext;
		const config = request.config || {};

		const facadeOptions: FacadeOptions = {
			userId: execContext.user!.id,
			workId: execContext.work.id
		};

		logger.log(`[${work.slug}] AI-Powered Search Query Generation - Starting`);

		const searchQueries = await this.generateSearchQueries(
			context,
			request.name || work.name,
			request.prompt || '',
			(config.target_keywords as string[]) || [],
			(config.max_search_queries as number) || 10,
			metrics,
			advancedPrompts?.searchQuery,
			logger,
			aiFacade,
			facadeOptions,
			promptFacade
		);

		logger.log(`[${work.slug}] Generated ${searchQueries.length} search queries.`);

		context.searchQueries = searchQueries;

		return context;
	}

	/**
	 * Generate search queries using AI
	 */
	private async generateSearchQueries(
		context: MutableGenerationContext,
		name: string,
		description: string,
		targetKeywords: string[],
		maxSearchQueries: number,
		metrics: StandardPipelineMetrics,
		customPrompt: string | null | undefined,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade'],
		facadeOptions: FacadeOptions,
		promptFacade?: StepExecutionContext['promptFacade']
	): Promise<string[]> {
		logger.debug(`[${name}] Generating search queries using LLM...`);

		const keywords = targetKeywords || [];

		if (!aiFacade.isConfigured()) {
			logger.warn(`[${name}] AI provider not configured. Falling back to basic query generation.`);
			this.addWarning(context, 'AI provider not configured. Using basic search queries.');
			return this.generateFallbackQueries(name, targetKeywords, maxSearchQueries);
		}

		const dateStr = getCurrentDateString();

		const resolvedPrompt = (
			promptFacade
				? await promptFacade.getPrompt(PROMPT_KEYS.SEARCH_QUERY_GENERATION, SEARCH_QUERY_PROMPT)
				: SEARCH_QUERY_PROMPT
		) as typeof SEARCH_QUERY_PROMPT;
		const finalPrompt = appendCustomPrompt(resolvedPrompt, customPrompt);

		try {
			const { result, usage, cost } = await aiFacade.askJson(
				finalPrompt,
				searchQuerySchema,
				{
					temperature: 0.2,
					variables: {
						name,
						description,
						keywords: keywords.length ? keywords.join(', ') : 'N/A',
						date: dateStr,
						query_count: String(maxSearchQueries * 2)
					},
					routing: {
						complexity: 'simple',
						taskId: 'search-query-generation'
					}
				},
				facadeOptions
			);

			if (usage) {
				this.accumulateMetrics(metrics, usage, cost);
			}

			const queries = (result.queries || []).map((q) => q.trim()).filter((q) => q.length > 3);
			const uniqueQueries = Array.from(new Set(queries));

			logger.debug(`[${name}] LLM generated ${uniqueQueries.length} unique queries.`);
			return uniqueQueries.slice(0, maxSearchQueries);
		} catch (error) {
			logger.error(
				`[${name}] Error generating search queries with LLM: ${this.formatError(error)}`,
				getErrorStack(error)
			);
			logger.warn(`[${name}] Falling back to basic query generation due to LLM error.`);
			return this.generateFallbackQueries(name, targetKeywords, maxSearchQueries);
		}
	}

	/**
	 * Generate fallback queries when AI is unavailable
	 */
	private generateFallbackQueries(name: string, targetKeywords: string[], maxSearchQueries: number): string[] {
		const fallbackQueries = [
			`best tools for ${name}`,
			`${name} resources`,
			`${name} libraries`,
			`${name} tutorials`,
			`official documentation ${name}`,
			`community ${name}`
		];

		if (targetKeywords && targetKeywords.length > 0) {
			return [...new Set([...targetKeywords.map((kw) => `${kw} ${name}`), ...fallbackQueries])].slice(
				0,
				maxSearchQueries
			);
		}
		return [...new Set(fallbackQueries)].slice(0, maxSearchQueries);
	}
}
