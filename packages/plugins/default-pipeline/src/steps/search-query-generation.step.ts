import { z } from 'zod';
import type {
	IBuiltInStepExecutor,
	MutableGenerationContext,
	StepExecutionContext,
	PipelineMetrics
} from '@ever-works/plugin';
import { getErrorMessage, getErrorStack } from '../utils/error.utils.js';
import { appendCustomPrompt } from '../utils/prompt.utils.js';

const SEARCH_QUERY_PROMPT =
	`You are a directory builder generating search queries to find the most relevant, official sources.

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
export class SearchQueryGenerationStep implements IBuiltInStepExecutor {
	readonly name = 'Search Query Generation';

	async run(context: MutableGenerationContext, execContext: StepExecutionContext): Promise<MutableGenerationContext> {
		const { request, directory, metrics, advancedPrompts } = context;
		const { logger, aiFacade } = execContext;
		const config = request.config || {};

		logger.log(`[${directory.slug}] AI-Powered Search Query Generation - Starting`);

		const searchQueries = await this.generateSearchQueries(
			request.name || directory.name,
			request.prompt || '',
			(config.target_keywords as string[]) || [],
			(config.max_search_queries as number) || 10,
			metrics,
			advancedPrompts?.searchQuery,
			logger,
			aiFacade
		);

		logger.log(`[${directory.slug}] Generated ${searchQueries.length} search queries.`);

		context.searchQueries = searchQueries;

		return context;
	}

	/**
	 * Generate search queries using AI
	 */
	private async generateSearchQueries(
		name: string,
		description: string,
		targetKeywords: string[],
		maxSearchQueries: number,
		metrics: PipelineMetrics,
		customPrompt: string | null | undefined,
		logger: StepExecutionContext['logger'],
		aiFacade: StepExecutionContext['aiFacade']
	): Promise<string[]> {
		logger.debug(`[${name}] Generating search queries using LLM...`);

		const keywords = targetKeywords || [];

		if (!aiFacade.isConfigured()) {
			logger.warn(`[${name}] AI provider not configured. Falling back to basic query generation.`);
			return this.generateFallbackQueries(name, targetKeywords, maxSearchQueries);
		}

		const now = new Date();
		const dateStr = `${this.getDayName(now)} ${this.formatDate(now)}`;

		const finalPrompt = appendCustomPrompt(SEARCH_QUERY_PROMPT, customPrompt);

		try {
			const { result, usage, cost } = await aiFacade.askJson(finalPrompt, searchQuerySchema, {
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
			});

			if (usage) {
				this.accumulateMetrics(metrics, usage, cost);
			}

			const queries = (result.queries || []).map((q) => q.trim()).filter((q) => q.length > 3);
			const uniqueQueries = Array.from(new Set(queries));

			logger.debug(`[${name}] LLM generated ${uniqueQueries.length} unique queries.`);
			return uniqueQueries.slice(0, maxSearchQueries);
		} catch (error) {
			logger.error(
				`[${name}] Error generating search queries with LLM: ${getErrorMessage(error)}`,
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

	/**
	 * Accumulate token usage and cost metrics
	 */
	private accumulateMetrics(
		metrics: PipelineMetrics,
		usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null,
		cost: number | null
	): void {
		if (!metrics.steps) {
			metrics.steps = {};
		}
		if (!metrics.steps['search-query-generation']) {
			metrics.steps['search-query-generation'] = {
				name: this.name,
				startTime: Date.now(),
				success: true
			};
		}
		const stepMetrics = metrics.steps['search-query-generation'];
		if (!stepMetrics.custom) {
			stepMetrics.custom = {};
		}
		if (usage) {
			stepMetrics.custom.totalTokens = ((stepMetrics.custom.totalTokens as number) || 0) + usage.totalTokens;
		}
		if (cost) {
			stepMetrics.custom.totalCost = ((stepMetrics.custom.totalCost as number) || 0) + cost;
		}
	}

	/**
	 * Get day name from date
	 */
	private getDayName(date: Date): string {
		const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		return days[date.getDay()];
	}

	/**
	 * Format date as yyyy-MM-dd HH:mm
	 */
	private formatDate(date: Date): string {
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${minutes}`;
	}
}
