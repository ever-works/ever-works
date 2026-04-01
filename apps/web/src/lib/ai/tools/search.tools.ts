import { z } from 'zod';
import { tool } from 'ai';
import { ROUTES } from '@/lib/constants';
import { searchAPI } from '@/lib/api/plugins-capabilities/search';

export const webSearch = tool({
    description: [
        "Search the web using the user's configured search provider.",
        'Returns results with title, URL, and relevance score.',
        'If no search provider is configured, returns a setup URL.',
        'Use natural language queries — do NOT use search operators like site: or inurl:.',
    ].join(' '),
    inputSchema: z.object({
        query: z.string().describe('Natural language search query. Do not use site: or other search operators.'),
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
                results: response.results.map((r) => ({
                    title: r.title,
                    url: r.url,
                    score: r.score,
                    publishedDate: r.publishedDate,
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
