import { HELP_SECTIONS, type HelpSection } from '@ever-works/contracts/api';
import type { HelpArticleMeta, HelpHeadingMeta } from './help-types';

/** Spec FR-18 — search floor and caps. */
export const HELP_SEARCH_MIN_CHARS = 2;
export const HELP_SEARCH_MAX_RESULTS = 20;
export const HELP_SEARCH_MAX_PER_SECTION = 6;
export const HELP_SEARCH_DEBOUNCE_MS = 120;
const CURRENT_SCREEN_BOOST = 5;

/** Spec FR-18.5 — the score table. */
export const HELP_SEARCH_SCORES = {
    titleEquals: 100,
    titleStartsWith: 90,
    headingStartsWith: 80,
    keywordEquals: 75,
    titleContains: 65,
    summaryContains: 45,
    headingContains: 40,
    bodyContains: 25,
} as const;

export interface HelpSearchResult {
    article: HelpArticleMeta;
    score: number;
    /** Set when the best match was a heading — the result opens the article there (spec FR-18.7). */
    heading: HelpHeadingMeta | null;
    documentsCurrentScreen: boolean;
}

export interface HelpSearchGroup {
    section: HelpSection;
    results: HelpSearchResult[];
}

export interface HelpSearchOutcome {
    groups: HelpSearchGroup[];
    /** Results in display order, flattened — the order arrow keys walk. */
    results: HelpSearchResult[];
    total: number;
}

export interface RankHelpArticlesInput {
    query: string;
    articles: readonly HelpArticleMeta[];
    /** Ids of the articles that document the screen the reader is on (+5, spec FR-18.5). */
    currentArticleIds?: readonly string[];
    /**
     * Plain-text article bodies keyed by article id. Absent in the first phase:
     * search then matches titles, summaries, keywords and headings only.
     */
    bodies?: ReadonlyMap<string, string>;
}

/** Case- and diacritic-insensitive form of a string for matching (spec FR-18.3). */
export function foldForSearch(value: string): string {
    return value
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreArticle(
    article: HelpArticleMeta,
    query: string,
    bodies?: ReadonlyMap<string, string>,
): { score: number; heading: HelpHeadingMeta | null } {
    const title = foldForSearch(article.title);
    let best = 0;
    let heading: HelpHeadingMeta | null = null;
    const consider = (score: number, matchedHeading: HelpHeadingMeta | null = null) => {
        if (score > best) {
            best = score;
            heading = matchedHeading;
        }
    };

    if (title === query) consider(HELP_SEARCH_SCORES.titleEquals);
    else if (title.startsWith(query)) consider(HELP_SEARCH_SCORES.titleStartsWith);
    else if (title.includes(query)) consider(HELP_SEARCH_SCORES.titleContains);

    for (const candidate of article.headings) {
        const text = foldForSearch(candidate.text);
        if (text.startsWith(query)) consider(HELP_SEARCH_SCORES.headingStartsWith, candidate);
        else if (text.includes(query)) consider(HELP_SEARCH_SCORES.headingContains, candidate);
    }

    if (article.keywords.some((keyword) => foldForSearch(keyword) === query)) {
        consider(HELP_SEARCH_SCORES.keywordEquals);
    }
    if (foldForSearch(article.summary).includes(query))
        consider(HELP_SEARCH_SCORES.summaryContains);

    const body = bodies?.get(article.id);
    if (body !== undefined && foldForSearch(body).includes(query)) {
        consider(HELP_SEARCH_SCORES.bodyContains);
    }
    return { score: best, heading };
}

/**
 * Rank the manual for a query (spec FR-18). Pure and deterministic: no I/O,
 * no clock, no randomness. Returns nothing for a query shorter than two
 * trimmed characters.
 */
export function rankHelpArticles({
    query,
    articles,
    currentArticleIds = [],
    bodies,
}: RankHelpArticlesInput): HelpSearchOutcome {
    const folded = foldForSearch(query);
    if (folded.length < HELP_SEARCH_MIN_CHARS) return { groups: [], results: [], total: 0 };

    const current = new Set(currentArticleIds);
    const sectionIndex = (section: HelpSection) => HELP_SECTIONS.indexOf(section);

    const ranked: HelpSearchResult[] = [];
    for (const article of articles) {
        const { score, heading } = scoreArticle(article, folded, bodies);
        if (score === 0) continue;
        const documentsCurrentScreen = current.has(article.id);
        ranked.push({
            article,
            heading,
            documentsCurrentScreen,
            score: Math.min(100, score + (documentsCurrentScreen ? CURRENT_SCREEN_BOOST : 0)),
        });
    }

    ranked.sort(
        (a, b) =>
            b.score - a.score ||
            Number(b.documentsCurrentScreen) - Number(a.documentsCurrentScreen) ||
            sectionIndex(a.article.section) - sectionIndex(b.article.section) ||
            a.article.title.toLowerCase().localeCompare(b.article.title.toLowerCase(), 'en'),
    );

    const perSection = new Map<HelpSection, HelpSearchResult[]>();
    let kept = 0;
    for (const result of ranked) {
        if (kept >= HELP_SEARCH_MAX_RESULTS) break;
        const bucket = perSection.get(result.article.section) ?? [];
        if (bucket.length >= HELP_SEARCH_MAX_PER_SECTION) continue;
        bucket.push(result);
        perSection.set(result.article.section, bucket);
        kept += 1;
    }

    const groups: HelpSearchGroup[] = HELP_SECTIONS.filter((section) =>
        perSection.has(section),
    ).map((section) => ({ section, results: perSection.get(section) ?? [] }));
    // A section holding an exact title match is promoted to the top (spec FR-18.4).
    groups.sort(
        (a, b) =>
            Number(b.results.some((r) => r.score === 100)) -
            Number(a.results.some((r) => r.score === 100)),
    );

    const results = groups.flatMap((group) => group.results);
    return { groups, results, total: results.length };
}
