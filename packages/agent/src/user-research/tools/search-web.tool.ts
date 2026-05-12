import { tool } from 'ai';
import { z } from 'zod';
import { Logger } from '@nestjs/common';
import type { SearchFacadeService } from '../../facades/search.facade';
import type { UserResearchLimitsService } from '../limits';

interface CreateSearchWebToolOptions {
	searchFacade: SearchFacadeService;
	limits: UserResearchLimitsService;
	userId: string;
	logger?: Logger;
	onResult?: (results: { title: string; url: string }[]) => void;
}

const inputSchema = z.object({
	query: z.string().min(2).max(200).describe('The web search query.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(10)
		.optional()
		.describe('Max results to return. Default 5.')
});

/**
 * Web search tool for the user-research agent. Wraps SearchFacadeService and
 * enforces the per-user daily search cap before each call. Returns a compact
 * results list (title, url, snippet placeholder, published date) — small enough
 * to keep the model's context lean across many calls.
 */
export function createSearchWebTool(opts: CreateSearchWebToolOptions) {
	const log = opts.logger ?? new Logger('UserResearch:searchWeb');

	return tool({
		description:
			'Search the web for information about a person. Use 2-6 times with varied queries. Returns title, url, and published date for each result.',
		inputSchema,
		execute: async (input) => {
			try {
				await opts.limits.assertSearchAllowed(opts.userId);
			} catch (err) {
				log.warn(`searchWeb blocked by rate limit: ${(err as Error).message}`);
				return { results: [], error: 'rate_limited' as const };
			}

			try {
				const results = await opts.searchFacade.search(
					input.query,
					{ maxResults: input.limit ?? 5 },
					{ userId: opts.userId, workId: opts.userId }
				);

				await opts.limits.incrementSearches(opts.userId);

				const compact = results.slice(0, input.limit ?? 5).map((r) => ({
					title: r.title,
					url: r.url,
					publishedDate: r.publishedDate
				}));

				opts.onResult?.(compact);
				return { results: compact };
			} catch (err) {
				log.warn(`searchWeb failed: ${(err as Error).message}`);
				return { results: [], error: (err as Error).message };
			}
		}
	});
}
