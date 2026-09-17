import { HELP_SECTIONS, type HelpSection } from '@ever-works/contracts/api';
import { HELP_ARTICLES } from './help-catalog.generated';
import type { HelpArticleMeta, HelpHeadingMeta } from './help-types';

type CatalogArticle = (typeof HELP_ARTICLES)[number];

/** Identifier of an article in THIS build's manual. */
export type HelpArticleId = CatalogArticle['id'];

type TargetsOf<A> = A extends {
    readonly id: infer I extends string;
    readonly headings: readonly (infer H)[];
}
    ? I | (H extends { readonly id: infer HI extends string } ? `${I}#${HI}` : never)
    : never;

/**
 * A help link (spec FR-20): `<article>` or `<article>#<heading>`. Derived from
 * the generated catalog, so a link to an article or heading this build does not
 * contain is a type error at the call site (spec FR-5.3).
 */
export type HelpTarget = TargetsOf<CatalogArticle>;

const ARTICLES: readonly HelpArticleMeta[] = HELP_ARTICLES;
const BY_ID = new Map<string, HelpArticleMeta>(ARTICLES.map((article) => [article.id, article]));

export interface ParsedHelpTarget {
    articleId: string;
    headingId: string | null;
}

export interface ResolvedHelpTarget {
    article: HelpArticleMeta;
    /** The heading the target names, when it is one of the article's catalogued headings. */
    heading: HelpHeadingMeta | null;
    /** The heading id as written — kept even when it is not catalogued, so the reader can still try it. */
    headingId: string | null;
    /** A heading was named but this build's article has no such heading (spec S-15). */
    headingMissing: boolean;
}

/** Every article of this build, in section then reading order. */
export function getHelpArticles(): readonly HelpArticleMeta[] {
    return ARTICLES;
}

export function getHelpArticle(id: string): HelpArticleMeta | null {
    return BY_ID.get(id) ?? null;
}

/** Split `<article>#<heading>`. Returns null for an empty or malformed value. */
export function parseHelpTarget(value: string): ParsedHelpTarget | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const hash = trimmed.indexOf('#');
    const articleId = hash === -1 ? trimmed : trimmed.slice(0, hash);
    const headingId = hash === -1 ? null : trimmed.slice(hash + 1) || null;
    if (!articleId) return null;
    return { articleId, headingId };
}

/**
 * The heading a URL fragment names (`#creating-a-task` → `creating-a-task`),
 * or null for an empty fragment. A fragment that is not valid percent-encoding
 * is returned as written rather than thrown: it matches no heading, so the
 * article opens at its top with the "section has moved" line (spec S-15).
 */
export function decodeHelpFragment(hash: string): string | null {
    const raw = hash.replace(/^#/, '');
    if (!raw) return null;
    try {
        return decodeURIComponent(raw) || null;
    } catch {
        return raw;
    }
}

export function formatHelpTarget(articleId: string, headingId?: string | null): string {
    return headingId ? `${articleId}#${headingId}` : articleId;
}

/**
 * Resolve a help target against this build's catalog. An unknown article is
 * `null` (a help link then renders nothing — spec FR-22); a known article with
 * an unknown heading resolves to the article with `headingMissing` (spec S-15).
 */
export function resolveHelpTarget(value: string): ResolvedHelpTarget | null {
    const parsed = parseHelpTarget(value);
    if (!parsed) return null;
    const article = getHelpArticle(parsed.articleId);
    if (!article) return null;
    if (!parsed.headingId)
        return { article, heading: null, headingId: null, headingMissing: false };
    const heading = article.headings.find((candidate) => candidate.id === parsed.headingId) ?? null;
    return { article, heading, headingId: parsed.headingId, headingMissing: heading === null };
}

export interface HelpSectionGroup {
    section: HelpSection;
    articles: HelpArticleMeta[];
}

/** Sections in reading order, each with its articles. Sections with no articles are omitted (spec S-23). */
export function groupHelpArticlesBySection(
    articles: readonly HelpArticleMeta[] = ARTICLES,
): HelpSectionGroup[] {
    return HELP_SECTIONS.map((section) => ({
        section,
        articles: articles.filter((article) => article.section === section),
    })).filter((group) => group.articles.length > 0);
}

/**
 * Up to `limit` article titles nearest to a slug that is not in this build
 * (spec S-14). Token overlap between the slug and each article's id and title;
 * articles sharing nothing are never suggested.
 */
export function suggestHelpArticles(slug: string, limit = 3): HelpArticleMeta[] {
    const tokens = new Set(
        slug
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length >= 3),
    );
    if (tokens.size === 0) return [];
    return ARTICLES.map((article) => {
        const words = `${article.id} ${article.title}`.toLowerCase().split(/[^a-z0-9]+/);
        const score = words.filter(
            (word) =>
                word.length >= 3 &&
                [...tokens].some((token) => word.startsWith(token) || token.startsWith(word)),
        ).length;
        return { article, score };
    })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.article.title.localeCompare(b.article.title))
        .slice(0, limit)
        .map((entry) => entry.article);
}
