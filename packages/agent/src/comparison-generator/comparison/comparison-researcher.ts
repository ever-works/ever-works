import type { ComparisonPair, ComparisonResearch } from './types';

function buildSourceTitle(url: string, snippet?: string): string {
    const cleanedSnippet = snippet?.trim();
    if (cleanedSnippet) {
        const firstSentence = cleanedSnippet.split(/(?<=[.!?])\s+/)[0]?.trim();
        if (firstSentence && firstSentence.length <= 80) return firstSentence;
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

export interface ResearchSeedResult {
    readonly url: string;
    readonly snippet: string;
}

/**
 * Research a comparison pair by web-searching the pair, deduping
 * across queries, extracting article content, and assembling a
 * citation-bearing summary the writer can consume.
 *
 * Budget defaults (override via `options`):
 *  - `maxQueries: 3` — only the first three of {@link buildSearchQueries}'s
 *    four queries fire by default. The fourth ("which is better")
 *    is reserved for callers that explicitly need it.
 *  - `maxResultsPerQuery: 5` — search depth per query.
 *  - `maxExtractions: 5` — total article extractions across all
 *    deduped results. Caps end-to-end cost at 5 × (search + extract).
 *  - Per-extraction body is trimmed to ~2000 chars to keep the
 *    writer prompt's token cost bounded; longer pages lose the tail
 *    with a trailing `'...'`.
 *
 * Failure semantics — all best-effort:
 *  - A search-query throw is silently swallowed; the loop continues
 *    with the next query so one flaky provider call doesn't lose the
 *    whole research pass.
 *  - An extraction throw falls back to the search-result snippet
 *    (kept as the source body) rather than dropping the source.
 *  - `seedResults` are pre-deduped and inserted FIRST, so a caller
 *    that already has the best results from an upstream phase
 *    guarantees they survive the dedup pass and aren't shadowed by
 *    fresh search hits.
 */
export async function researchPair(
    pair: ComparisonPair,
    deps: ResearchDependencies,
    options: {
        maxQueries?: number;
        maxResultsPerQuery?: number;
        maxExtractions?: number;
        seedResults?: ResearchSeedResult[];
    } = {},
): Promise<ComparisonResearch> {
    const {
        maxQueries = 3,
        maxResultsPerQuery = 5,
        maxExtractions = 5,
        seedResults = [],
    } = options;
    const queries = buildSearchQueries(pair).slice(0, maxQueries);

    const allResults: Array<{ url: string; snippet: string }> = [];
    const seenUrls = new Set<string>();

    for (const result of seedResults) {
        if (!seenUrls.has(result.url)) {
            seenUrls.add(result.url);
            allResults.push(result);
        }
    }

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
