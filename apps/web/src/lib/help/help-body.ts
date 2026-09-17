import {
    HELP_NOTE_TONES,
    type HelpArticleBody,
    type HelpBlock,
    type HelpBlockKind,
    type HelpInline,
    type HelpLinkTarget,
    type HelpListItem,
} from '@ever-works/contracts/api';
import { getWebBuildInfo } from '@/lib/build-info';

/** Where the build writes article bodies (`scripts/build-help-catalog.mjs --bodies`). */
export const HELP_CONTENT_BASE_PATH = '/help-content';

const inflight = new Map<string, Promise<HelpArticleBody | null>>();

export function helpBodyUrl(articleId: string): string {
    const build = getWebBuildInfo();
    const version = encodeURIComponent(build.gitSha === 'dev' ? build.version : build.shortSha);
    return `${HELP_CONTENT_BASE_PATH}/${encodeURIComponent(articleId)}.json?v=${version}`;
}

/**
 * Deepest nesting of blocks and inline nodes a body may use. The generator's
 * output stays in single digits; the ceiling only keeps a corrupt file from
 * recursing the validator and the renderer without bound.
 */
export const HELP_BODY_MAX_DEPTH = 64;

type Shape = Record<string, unknown>;

const isShape = (value: unknown): value is Shape =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const everyOf = (value: unknown, check: (entry: unknown) => boolean): boolean =>
    Array.isArray(value) && value.every(check);

function isLinkTarget(value: unknown): value is HelpLinkTarget {
    if (!isShape(value)) return false;
    switch (value.type) {
        case 'article':
            return isString(value.articleId) && isNullableString(value.headingId);
        case 'screen':
            return isString(value.routeKey);
        case 'external':
            return isString(value.href);
        default:
            return false;
    }
}

function isInlineList(value: unknown, depth: number): value is HelpInline[] {
    return depth <= HELP_BODY_MAX_DEPTH && everyOf(value, (node) => isInline(node, depth));
}

function isInline(value: unknown, depth: number): value is HelpInline {
    if (!isShape(value)) return false;
    switch (value.type) {
        case 'text':
        case 'code':
            return isString(value.text);
        case 'strong':
        case 'emphasis':
            return isInlineList(value.children, depth + 1);
        case 'link':
            return isLinkTarget(value.target) && isInlineList(value.children, depth + 1);
        default:
            return false;
    }
}

function isListItem(value: unknown, depth: number): value is HelpListItem {
    return (
        isShape(value) &&
        isInlineList(value.content, depth + 1) &&
        isBlockList(value.children, depth + 1)
    );
}

function isBlockList(value: unknown, depth: number): value is HelpBlock[] {
    return depth <= HELP_BODY_MAX_DEPTH && everyOf(value, (block) => isBlock(block, depth));
}

function isBlock(value: unknown, depth: number): value is HelpBlock {
    if (!isShape(value)) return false;
    switch (value.kind as HelpBlockKind) {
        case 'paragraph':
            return isInlineList(value.content, depth + 1);
        case 'heading':
            return (
                (value.level === 2 || value.level === 3 || value.level === 4) &&
                isString(value.id) &&
                isInlineList(value.content, depth + 1)
            );
        case 'orderedList':
        case 'unorderedList':
            return everyOf(value.items, (item) => isListItem(item, depth + 1));
        case 'note':
            return (
                (HELP_NOTE_TONES as readonly unknown[]).includes(value.tone) &&
                isNullableString(value.title) &&
                isBlockList(value.blocks, depth + 1)
            );
        case 'shortcut':
            return everyOf(value.keys, isString) && isString(value.label);
        case 'code':
            return isNullableString(value.language) && isString(value.text);
        case 'link':
            return isString(value.label) && isLinkTarget(value.target);
        case 'table':
            return (
                everyOf(value.header, (cell) => isInlineList(cell, depth + 1)) &&
                everyOf(value.rows, (row) => everyOf(row, (cell) => isInlineList(cell, depth + 1)))
            );
        default:
            return false;
    }
}

/**
 * Whether a value is a well-formed body for this article — the envelope AND
 * every block and inline node against the closed grammar (spec FR-27), so a
 * malformed or stale static file shows the unavailable-body fallback instead
 * of breaking the renderer.
 */
export function isHelpArticleBody(value: unknown, articleId: string): value is HelpArticleBody {
    if (!isShape(value)) return false;
    return value.version === 1 && value.id === articleId && isBlockList(value.blocks, 0);
}

/**
 * Load one article body from this deployment (never from another origin —
 * spec FR-1). Resolves `null` when the body is missing, malformed or the
 * request fails; a failure is not cached, so opening the article again retries.
 */
export function loadHelpArticleBody(
    articleId: string,
    fetcher: typeof fetch = fetch,
): Promise<HelpArticleBody | null> {
    const existing = inflight.get(articleId);
    if (existing) return existing;
    const request = Promise.resolve()
        .then(() => fetcher(helpBodyUrl(articleId), { credentials: 'same-origin' }))
        .then(async (response) => {
            if (!response.ok) return null;
            const json: unknown = await response.json();
            return isHelpArticleBody(json, articleId) ? json : null;
        })
        .catch(() => null)
        .then((body) => {
            if (body === null) inflight.delete(articleId);
            return body;
        });
    inflight.set(articleId, request);
    return request;
}

/** Test seam — forget every cached body. */
export function resetHelpBodyCache(): void {
    inflight.clear();
}
