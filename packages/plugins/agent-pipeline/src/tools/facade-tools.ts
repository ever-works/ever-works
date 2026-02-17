import { tool } from 'ai';
import { z } from 'zod';
import type {
	ISearchFacade,
	IContentExtractorFacade,
	FacadeOptions,
	PipelineProgressCallback,
	PluginLogger
} from '@ever-works/plugin';
import { MAX_EXTRACT_CONTENT_LENGTH } from '../types.js';
import type { ToolCircuitBreaker } from '../utils/tool-circuit-breaker.js';

export interface FacadeToolOptions {
	breaker: ToolCircuitBreaker;
	logger: PluginLogger;
}

/**
 * Create a search tool that wraps the search facade.
 */
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

/**
 * Create a content extraction tool that wraps the content extractor facade.
 * Truncates content to MAX_EXTRACT_CONTENT_LENGTH to keep context manageable.
 */
export function createExtractContentTool(
	contentExtractorFacade: IContentExtractorFacade,
	facadeOptions: FacadeOptions,
	toolOptions: FacadeToolOptions,
	maxContentLength?: number
) {
	const { breaker, logger } = toolOptions;

	return tool({
		description:
			"Extract the text content from a web page URL. Use this to read details from an item's official page.",
		inputSchema: z.object({
			url: z.string().url().describe('The URL to extract content from')
		}),
		execute: async ({ url }) => {
			if (breaker.isTripped('extractContent')) {
				return { url, content: '', error: breaker.getUnavailableMessage('extractContent') };
			}

			try {
				const result = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);

				// Null/empty content is NOT a service failure — don't trip the breaker
				if (!result?.rawContent) {
					return { url, content: '', error: 'Failed to extract content from this URL' };
				}

				breaker.recordSuccess('extractContent');
				const maxLen = maxContentLength ?? MAX_EXTRACT_CONTENT_LENGTH;

				let content: string;
				if (result.rawContent.length <= maxLen) {
					content = result.rawContent;
				} else {
					content =
						result.rawContent.slice(0, maxLen) +
						`\n\n[Content truncated: ${result.rawContent.length} chars total]`;
				}
				return { url, content, images: result.images };
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				logger.warn(`ExtractContent tool error: ${error.message}`);
				breaker.recordFailure('extractContent', error);

				if (breaker.isTripped('extractContent')) {
					return { url, content: '', error: breaker.getUnavailableMessage('extractContent') };
				}
				return {
					url,
					content: '',
					error: `Content extraction failed: ${error.message}. You may retry once with a different URL.`
				};
			}
		}
	});
}

/**
 * Create a progress reporting tool that calls the onProgress callback.
 */
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
			// Map items created to a progress percentage within the generate step (30-80%)
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
