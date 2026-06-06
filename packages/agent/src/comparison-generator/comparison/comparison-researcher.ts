import type { ComparisonPair, ComparisonResearch } from './types';
import { sanitizePrompt } from '../../utils/sanitize.util';

// Security: extracted page bodies and search snippets are HOSTILE external
// content. The writer (comparison-writer.ts) fences this string inside a
// `<web_research untrusted="true">…</web_research>` block and tells the model
// to treat it as data, never instructions. That fence is only effective if the
// untrusted content cannot forge the closing tag (`</web_research>`) to break
// out into the trusted prompt, or re-open the block. Neutralize the fence
// delimiters at the source (here, where research.content is assembled) plus the
// chat-template / instruction tokens that spoof role/turn boundaries, and strip
// control chars. Legitimate article text is unaffected — real pages don't
// contain these literal tokens.
function sanitizeExtractedContent(text: string): string {
    return sanitizePrompt(
        text
            // Break the writer's `<web_research>` / `</web_research>` fence
            // tokens so embedded copies can't close or re-open the untrusted
            // block. The visible text is preserved (angle brackets encoded).
            .replace(/<(\/?)\s*web_research\b/gi, '&lt;$1web_research')
            // Strip instruction / chat-template delimiters (mirrors
            // sanitizeCustomPrompt in comparison-writer.ts).
            .replace(/\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi, ''),
        // Per-source bodies are already trimmed to ~2000 chars below; keep a
        // generous cap so this only strips abusive tokens, never legit content.
        8000,
    );
}

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
                // Security: neutralize prompt-injection / fence-breakout tokens.
                contentParts.push(`Source: ${result.url}\n${sanitizeExtractedContent(trimmed)}`);
            } else if (result.snippet) {
                // Security: neutralize prompt-injection / fence-breakout tokens.
                contentParts.push(
                    `Source: ${result.url}\n${sanitizeExtractedContent(result.snippet)}`,
                );
            }
        } catch {
            // Extraction failed for this URL, still keep the snippet
            if (result.snippet) {
                // Security: neutralize prompt-injection / fence-breakout tokens.
                contentParts.push(
                    `Source: ${result.url}\n${sanitizeExtractedContent(result.snippet)}`,
                );
            }
        }
    }

    return {
        content: contentParts.join('\n\n---\n\n'),
        sources,
    };
}
