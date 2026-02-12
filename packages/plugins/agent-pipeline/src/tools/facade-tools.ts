import { tool } from 'ai';
import { z } from 'zod';
import type {
	ISearchFacade,
	IContentExtractorFacade,
	FacadeOptions,
	PipelineProgressCallback
} from '@ever-works/plugin';
import { MAX_EXTRACT_CONTENT_LENGTH } from '../types.js';

/**
 * Create a search tool that wraps the search facade.
 */
export function createSearchTool(searchFacade: ISearchFacade, facadeOptions: FacadeOptions) {
	return tool({
		description: 'Search the web for information. Returns a list of results with title, URL, and relevance score.',
		parameters: z.object({
			query: z.string().describe('The search query'),
			maxResults: z.number().optional().default(10).describe('Maximum number of results to return (default 10)')
		}),
		execute: async ({ query, maxResults }) => {
			const results = await searchFacade.search(query, { maxResults }, facadeOptions);
			return results.map((r) => ({
				title: r.title,
				url: r.url,
				score: r.score,
				publishedDate: r.publishedDate
			}));
		}
	});
}

/**
 * Create a content extraction tool that wraps the content extractor facade.
 * Truncates content to MAX_EXTRACT_CONTENT_LENGTH to keep context manageable.
 */
export function createExtractContentTool(
	contentExtractorFacade: IContentExtractorFacade,
	facadeOptions: FacadeOptions
) {
	return tool({
		description:
			"Extract the text content from a web page URL. Use this to read details from an item's official page.",
		parameters: z.object({
			url: z.string().url().describe('The URL to extract content from')
		}),
		execute: async ({ url }) => {
			const result = await contentExtractorFacade.extractContent(url, undefined, facadeOptions);
			if (!result?.rawContent) {
				return { url, content: '', error: 'Failed to extract content' };
			}
			const content =
				result.rawContent.length > MAX_EXTRACT_CONTENT_LENGTH
					? result.rawContent.slice(0, MAX_EXTRACT_CONTENT_LENGTH) + '\n\n[Content truncated]'
					: result.rawContent;
			return { url, content, images: result.images };
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
		parameters: z.object({
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
