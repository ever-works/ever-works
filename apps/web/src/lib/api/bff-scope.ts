import {
    API_SCOPE_HEADER,
    BROWSER_WORKSPACE_SCOPE_HEADER,
    WORKSPACE_SCOPE_QUERY_PARAM,
    parseWorkspacePath,
    parseWorkspaceSelector,
    toApiScopeHeader,
    type WorkspaceScope,
} from '../workspace-scope';
import { configuredPublicOrigin } from '../public-origin';

export { WORKSPACE_SCOPE_QUERY_PARAM };

const PERSONAL: WorkspaceScope = { kind: 'personal' };

function scopesMatch(left: WorkspaceScope, right: WorkspaceScope): boolean {
    return (
        left.kind === right.kind &&
        (left.kind === 'personal' || (right.kind === 'organization' && left.slug === right.slug))
    );
}

/**
 * The origin this deployment is served to browsers on — never `request.url`'s
 * origin, which inside a Next server is the pod's own bind address. The shared
 * resolver (and the full reasoning) lives in `lib/public-origin.ts`, which the
 * route-handler redirects use too.
 */
function trustedBrowserOrigin(): string | null {
    return configuredPublicOrigin();
}

/**
 * Overwrite BOTH scope headers: the browser selector never travels upstream,
 * and the API header is always the one this layer resolved — a client-supplied
 * `x-scope-slug` is discarded, never trusted.
 */
function withApiScope(baseHeaders: HeadersInit, scope: WorkspaceScope): Headers {
    const upstream = new Headers(baseHeaders);
    upstream.delete(BROWSER_WORKSPACE_SCOPE_HEADER);
    upstream.set(API_SCOPE_HEADER, toApiScopeHeader(scope));
    return upstream;
}

function toScopedHeaders(
    rawSelector: string | null,
    request: Request,
    baseHeaders: HeadersInit,
): Headers {
    try {
        const selected = parseWorkspaceSelector(rawSelector);
        const referer = request.headers.get('referer');
        if (referer) {
            const refererUrl = new URL(referer);
            const trusted = trustedBrowserOrigin();
            if (trusted !== null && refererUrl.origin !== trusted) {
                throw new Error('Cross-origin Referer');
            }
            if (!scopesMatch(selected, parseWorkspacePath(refererUrl.pathname))) {
                throw new Error('Stale workspace selector');
            }
        }
        return withApiScope(baseHeaders, selected);
    } catch {
        throw new Error('Invalid workspace scope');
    }
}

/**
 * Convert the browser's explicit, per-tab selector into the API contract.
 * Referer is optional, but when present it must come from this deployment's own
 * public origin and agree with the selector. Both browser and API scope headers
 * are always overwritten.
 *
 * Header ONLY, and fail closed without one. This deliberately ignores `?scope=`:
 * an XHR route that also honoured the query string would let a crafted link
 * influence a fetch the page's own transport thought it controlled. Routes
 * reached by navigation use {@link applyBffWorkspaceScopeFromNavigation}.
 */
export function applyBffWorkspaceScope(request: Request, baseHeaders: HeadersInit): Headers {
    return toScopedHeaders(
        request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER),
        request,
        baseHeaders,
    );
}

/**
 * For routes a browser navigates to: `?scope=` first, then the header, then
 * PERSONAL.
 *
 * The query string wins when both are present because a navigation IS the
 * user's action — the URL they clicked is the authority, in the same way the
 * visible pathname is for the app shell.
 *
 * When NEITHER carrier is present the request runs personal. That is not the
 * silent default the header variant refuses; it is the only correct answer for
 * this family. The URLs these routes serve are API-minted and live in stored
 * chat text, attachment lists and old bookmarks that predate any carrier.
 * Every one of them ran personal before the carrier existed, and personal is
 * `userId`-gated upstream, so the fallback narrows nothing and widens nothing —
 * while rejecting it would break every attachment tile in history for zero
 * security gain. Fail closed ONLY on a selector that is present and does not
 * parse: that is the tampered case.
 *
 * The Referer check in {@link toScopedHeaders} applies to a SUPPLIED selector.
 * For a navigation the Referer is the page the link sat on, so a `?scope=` that
 * disagrees with where the user actually is fails closed, which makes a
 * copied-and-edited URL fail rather than cross scopes. A defaulted selector has
 * nothing for the Referer to disagree with, so the fallback skips it — an old
 * `<img src>` rendered inside an Organization page must keep resolving.
 *
 * `request.url`'s ORIGIN is unreliable inside Next (see `trustedBrowserOrigin`),
 * but its path and query are intact, which is all this reads.
 */
export function applyBffWorkspaceScopeFromNavigation(
    request: Request,
    baseHeaders: HeadersInit,
): Headers {
    const fromQuery = new URL(request.url, 'http://n').searchParams.get(
        WORKSPACE_SCOPE_QUERY_PARAM,
    );
    const supplied =
        fromQuery !== null ? fromQuery : request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER);
    if (supplied === null) {
        return withApiScope(baseHeaders, PERSONAL);
    }
    return toScopedHeaders(supplied, request, baseHeaders);
}

/**
 * The upstream query string for a navigation route: whatever the caller
 * forwards, minus the carrier. The API's global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so a forwarded `scope` is a 400 upstream — the
 * carrier is CONSUMED here, never relayed.
 */
export function upstreamSearchWithoutScope(search: URLSearchParams): string {
    const upstream = new URLSearchParams(search);
    upstream.delete(WORKSPACE_SCOPE_QUERY_PARAM);
    const qs = upstream.toString();
    return qs ? `?${qs}` : '';
}
