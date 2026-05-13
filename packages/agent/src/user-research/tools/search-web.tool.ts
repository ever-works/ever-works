import { tool } from 'ai';
import { z } from 'zod';
import { Logger } from '@nestjs/common';
import type { SearchFacadeService } from '../../facades/search.facade';
import type { UserResearchLimitsService } from '../limits';
import { isTransientProviderError } from '../provider-resolver';

interface CreateSearchWebToolOptions {
    searchFacade: SearchFacadeService;
    limits: UserResearchLimitsService;
    userId: string;
    /**
     * Ordered list of search plugin IDs to try. Empty / undefined means
     * "let the facade pick its default". The tool walks the chain on
     * transient errors so a flapping provider doesn't drop the whole run.
     */
    providerChain?: string[];
    logger?: Logger;
    onResult?: (results: { title: string; url: string }[]) => void;
}

const inputSchema = z.object({
    query: z.string().min(2).max(200).describe('The web search query.'),
    limit: z.number().int().min(1).max(10).optional().describe('Max results to return. Default 5.'),
});

export function createSearchWebTool(opts: CreateSearchWebToolOptions) {
    const log = opts.logger ?? new Logger('UserResearch:searchWeb');
    const chain =
        opts.providerChain && opts.providerChain.length > 0 ? opts.providerChain : [undefined];

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

            let lastErr: unknown;
            for (const providerOverride of chain) {
                try {
                    const results = await opts.searchFacade.search(
                        input.query,
                        { maxResults: input.limit ?? 5 },
                        { userId: opts.userId, providerOverride },
                    );

                    await opts.limits.incrementSearches(opts.userId);

                    const compact = results.slice(0, input.limit ?? 5).map((r) => ({
                        title: r.title,
                        url: r.url,
                        publishedDate: r.publishedDate,
                    }));

                    opts.onResult?.(compact);
                    return { results: compact };
                } catch (err) {
                    lastErr = err;
                    if (!isTransientProviderError(err)) {
                        log.warn(`searchWeb failed (non-retryable): ${(err as Error).message}`);
                        return { results: [], error: (err as Error).message };
                    }
                    log.warn(
                        `searchWeb provider ${providerOverride ?? '<default>'} failed (retryable): ${(err as Error).message}`,
                    );
                }
            }
            return {
                results: [],
                error: (lastErr as Error)?.message ?? 'all search providers failed',
            };
        },
    });
}
