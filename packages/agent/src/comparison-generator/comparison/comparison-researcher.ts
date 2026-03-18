import type { ComparisonPair, ComparisonResearch } from './types';

function buildSourceTitle(url: string, snippet?: string): string {
    const cleanedSnippet = snippet?.trim();
    if (cleanedSnippet) {
        const firstSentence = cleanedSnippet.split(/(?<=[.!?])\s+/)[0]?.trim();
        if (firstSentence) return firstSentence;
    }

    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/**
 * Generate search queries for a comparison pair.
 */
export function buildSearchQueries(pair: ComparisonPair): string[] {
    const nameA = pair.itemA.name;
    const nameB = pair.itemB.name;

    return [
        `"${nameA} vs ${nameB}"`,
        `compare ${nameA} and ${nameB}`,
        `${nameA} alternative ${nameB}`,
        `${nameA} or ${nameB} which is better`,
    ];
}

export interface ResearchDependencies {
    readonly search: (
        query: string,
        limit: number,
    ) => Promise<Array<{ url: string; snippet: string }>>;
    readonly extractContent: (url: string) => Promise<string | null>;
}

/**
 * Research a comparison pair by searching the web and extracting content.
 * Returns aggregated research content and source URLs.
 */
export async function researchPair(
    pair: ComparisonPair,
    deps: ResearchDependencies,
    options: { maxQueries?: number; maxResultsPerQuery?: number; maxExtractions?: number } = {},
): Promise<ComparisonResearch> {
    const { maxQueries = 3, maxResultsPerQuery = 5, maxExtractions = 5 } = options;
    const queries = buildSearchQueries(pair).slice(0, maxQueries);

    const allResults: Array<{ url: string; snippet: string }> = [];
    const seenUrls = new Set<string>();

    for (const query of queries) {
        try {
            const results = await deps.search(query, maxResultsPerQuery);
            for (const result of results) {
                if (!seenUrls.has(result.url)) {
                    seenUrls.add(result.url);
                    allResults.push(result);
                }
            }
        } catch {
            // Search query failed, continue with remaining queries
        }
    }

    const topResults = allResults.slice(0, maxExtractions);
    const sources: ComparisonResearch['sources'] = [];
    const contentParts: string[] = [];

    for (const result of topResults) {
        sources.push({
            title: buildSourceTitle(result.url, result.snippet),
            url: result.url,
        });

        try {
            const content = await deps.extractContent(result.url);
            if (content) {
                // Limit each extraction to ~2000 chars to control token cost
                const trimmed = content.length > 2000 ? content.slice(0, 2000) + '...' : content;
                contentParts.push(`Source: ${result.url}\n${trimmed}`);
            } else if (result.snippet) {
                contentParts.push(`Source: ${result.url}\n${result.snippet}`);
            }
        } catch {
            // Extraction failed for this URL, still keep the snippet
            if (result.snippet) {
                contentParts.push(`Source: ${result.url}\n${result.snippet}`);
            }
        }
    }

    return {
        content: contentParts.join('\n\n---\n\n'),
        sources,
    };
}
