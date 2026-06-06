import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { searchAPI } from '@/lib/api/plugins-capabilities/search';
import { sanitizeText } from '@/lib/utils';

export const webSearch = tool({
    description: [
        "Search the web using the user's configured search provider.",
        'Returns results with title, URL, and relevance score.',
        'If no search provider is configured, returns a setup URL.',
        'Use natural language queries — do NOT use search operators like site: or inurl:.',
    ].join(' '),
    inputSchema: z.object({
        query: z
            .string()
            .describe('Natural language search query. Do not use site: or other search operators.'),
        maxResults: z.number().optional().describe('Maximum number of results (default: 10)'),
    }),
    execute: async ({ query, maxResults }) => {
        try {
            const availability = await searchAPI.checkAvailability();

            if (!availability.available) {
                return {
                    success: false,
                    results: [],
                    message:
                        availability.message ||
                        'No search provider is enabled or configured. The user needs to enable a search plugin (e.g. Tavily, Linkup, Brave, Exa) in settings.',
                    setupUrl: ROUTES.DASHBOARD_SETTINGS_PLUGIN_CATEGORY('search'),
                };
            }

            const response = await searchAPI.search({ query, maxResults: maxResults ?? 10 });

            return {
                success: true,
                // Security: search results come from untrusted external pages (SEO-poisoned
                // titles/URLs) and flow straight back into the agent tool loop — where a
                // subagent also holds getUserInfo. Sanitize the attacker-controllable string
                // fields (strip control chars, collapse newlines that enable instruction-format
                // breakouts, truncate) so injected text can't masquerade as instructions.
                // Legitimate titles/URLs/dates are well within these limits and pass through.
                results: response.results.map((r) => ({
                    title: sanitizeText(r.title, { maxLength: 300 }),
                    url: sanitizeText(r.url, { maxLength: 2048 }),
                    score: r.score,
                    publishedDate: r.publishedDate
                        ? sanitizeText(r.publishedDate, { maxLength: 64 })
                        : r.publishedDate,
                })),
                resultCount: response.results.length,
            };
        } catch {
            return {
                success: false,
                results: [],
                message: 'Search failed. Please try again.',
            };
        }
    },
});
