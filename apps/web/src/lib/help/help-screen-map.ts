import { ROUTES } from '@/lib/constants';
import type { HelpArticleMeta } from './help-types';

type RouteKey = keyof typeof ROUTES;

interface ScreenPattern {
    key: string;
    segments: string[];
}

const PARAM = ':param';

/**
 * The path pattern of a dashboard `ROUTES` entry: a literal path with its
 * query and hash dropped, or a builder called with placeholder parameters.
 * `null` for anything that is not a dashboard screen.
 */
export function screenPattern(key: string): string | null {
    if (!key.startsWith('DASHBOARD')) return null;
    const value = ROUTES[key as RouteKey] as unknown;
    let path: string;
    if (typeof value === 'string') path = value;
    else if (typeof value === 'function') {
        const builder = value as (...args: string[]) => string;
        path = builder(...Array.from({ length: builder.length }, () => PARAM));
    } else return null;
    return normalizePath(path);
}

function normalizePath(path: string): string {
    const bare = path.split(/[?#]/)[0] || '/';
    const trimmed = bare.length > 1 ? bare.replace(/\/+$/, '') : bare;
    return trimmed || '/';
}

function toSegments(path: string): string[] {
    return path.split('/').filter(Boolean);
}

let patternsCache: ScreenPattern[] | null = null;
function patterns(): ScreenPattern[] {
    if (!patternsCache) {
        patternsCache = Object.keys(ROUTES)
            .map((key) => {
                const pattern = screenPattern(key);
                return pattern === null ? null : { key, segments: toSegments(pattern) };
            })
            .filter((entry): entry is ScreenPattern => entry !== null);
    }
    return patternsCache;
}

interface Candidate {
    keys: string[];
    exact: boolean;
    length: number;
    literals: number;
}

/**
 * Candidate screens for a pathname, best first: exact matches before prefix
 * matches, then the longer pattern, then the one with more literal segments —
 * so `/works/:id/kb/…` maps to the Knowledge Base screen, not to the Work.
 */
function candidatesFor(pathname: string): Candidate[] {
    const path = toSegments(normalizePath(pathname));
    const byPattern = new Map<string, Candidate>();
    for (const { key, segments } of patterns()) {
        if (segments.length > path.length) continue;
        if (segments.length === 0 && path.length > 0) continue; // `/` is the home screen only
        const matches = segments.every((segment, i) => segment === PARAM || segment === path[i]);
        if (!matches) continue;
        const signature = segments.join('/');
        const existing = byPattern.get(signature);
        if (existing) {
            existing.keys.push(key);
            continue;
        }
        byPattern.set(signature, {
            keys: [key],
            exact: segments.length === path.length,
            length: segments.length,
            literals: segments.filter((segment) => segment !== PARAM).length,
        });
    }
    return [...byPattern.values()].sort(
        (a, b) =>
            Number(b.exact) - Number(a.exact) || b.length - a.length || b.literals - a.literals,
    );
}

export interface HelpScreenMatch {
    /** The `ROUTES` keys of the screen the articles were found for (several keys can share a path). */
    routeKeys: string[];
    articleIds: string[];
}

/**
 * The articles that document the screen at `pathname` (spec S-1 "On this
 * screen"). Walks from the most specific matching screen outwards and stops at
 * the first one any article documents. An unmapped path yields an empty
 * result, never an error.
 */
export function matchHelpScreen(
    pathname: string | null | undefined,
    articles: readonly HelpArticleMeta[],
): HelpScreenMatch {
    if (!pathname) return { routeKeys: [], articleIds: [] };
    for (const candidate of candidatesFor(pathname)) {
        const keys = new Set(candidate.keys);
        const articleIds = articles
            .filter((article) => article.documents.some((key) => keys.has(key)))
            .map((article) => article.id);
        if (articleIds.length > 0) return { routeKeys: candidate.keys, articleIds };
    }
    return { routeKeys: [], articleIds: [] };
}
