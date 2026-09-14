import type { HelpArticleBody } from '@ever-works/contracts/api';
import { getWebBuildInfo } from '@/lib/build-info';

/** Where the build writes article bodies (`scripts/build-help-catalog.mjs --bodies`). */
export const HELP_CONTENT_BASE_PATH = '/help-content';

const inflight = new Map<string, Promise<HelpArticleBody | null>>();

export function helpBodyUrl(articleId: string): string {
    const build = getWebBuildInfo();
    const version = encodeURIComponent(build.gitSha === 'dev' ? build.version : build.shortSha);
    return `${HELP_CONTENT_BASE_PATH}/${encodeURIComponent(articleId)}.json?v=${version}`;
}

function isArticleBody(value: unknown, articleId: string): value is HelpArticleBody {
    if (!value || typeof value !== 'object') return false;
    const body = value as Partial<HelpArticleBody>;
    return body.version === 1 && body.id === articleId && Array.isArray(body.blocks);
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
            return isArticleBody(json, articleId) ? json : null;
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
