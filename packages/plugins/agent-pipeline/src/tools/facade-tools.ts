import { tool } from 'ai';
import { z } from 'zod';
import type { ISearchFacade, FacadeOptions, PipelineProgressCallback, PluginLogger } from '@ever-works/plugin';
import type { ToolCircuitBreaker } from '../utils/tool-circuit-breaker.js';

export interface FacadeToolOptions {
	breaker: ToolCircuitBreaker;
	logger: PluginLogger;
}

export function createSearchTool(
	searchFacade: ISearchFacade,
	facadeOptions: FacadeOptions,
	toolOptions: FacadeToolOptions
) {
	const { breaker, logger } = toolOptions;

	return tool({
		description: 'Search the web for information. Returns a list of results with title, URL, and relevance score.',
		inputSchema: z.object({
			query: z.string().describe('The search query'),
			maxResults: z.number().optional().default(10).describe('Maximum number of results to return (default 10)')
		}),
		execute: async ({ query, maxResults }) => {
			if (breaker.isTripped('search')) {
				return { results: [], error: breaker.getUnavailableMessage('search') };
			}

			try {
				const results = await searchFacade.search(query, { maxResults }, facadeOptions);
				breaker.recordSuccess('search');
				const mapped = results.map((r) => ({
					title: r.title,
					url: r.url,
					score: r.score,
					publishedDate: r.publishedDate
				}));
				logger.log(`Search '${query}': ${mapped.length} results`);
				return mapped;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				logger.warn(`Search tool error: ${error.message}`);
				breaker.recordFailure('search', error);

				if (breaker.isTripped('search')) {
					return { results: [], error: breaker.getUnavailableMessage('search') };
				}
				return {
					results: [],
					error: `Search failed: ${error.message}. You may retry once. If search keeps failing, only use data you already retrieved — do NOT fabricate items from memory.`
				};
			}
		}
	});
}

export function createReportProgressTool(
	onProgress: PipelineProgressCallback | undefined,
	stepIndex: number,
	totalSteps: number
) {
	return tool({
		description: 'Report your progress to the user. Call this periodically as you create items.',
		inputSchema: z.object({
			itemsCreated: z.number().describe('Number of items created so far'),
			message: z.string().optional().describe('Optional progress message')
		}),
		execute: async ({ itemsCreated, message }) => {
			const percent = Math.min(30 + Math.round(itemsCreated * 1.5), 80);
			onProgress?.({
				percent,
				currentStepIndex: stepIndex,
				totalSteps,
				currentStepName: 'Generate Items',
				message: message ?? `Created ${itemsCreated} items`,
				itemsProcessed: itemsCreated
			});
			return { acknowledged: true, itemsCreated };
		}
	});
}
