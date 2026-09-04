import {
    API_SCOPE_HEADER,
    BROWSER_WORKSPACE_SCOPE_HEADER,
    parseWorkspacePath,
    parseWorkspaceSelector,
    toApiScopeHeader,
    type WorkspaceScope,
} from '../workspace-scope';

function scopesMatch(left: WorkspaceScope, right: WorkspaceScope): boolean {
    return (
        left.kind === right.kind &&
        (left.kind === 'personal' || (right.kind === 'organization' && left.slug === right.slug))
    );
}

/**
 * The origin this deployment is served to browsers on.
 *
 * This MUST NOT be derived from the incoming `Request`. Inside a Next server
 * `request.url` is the server's own view of itself, never the browser-facing
 * URL: `attachRequestMeta` builds it from the bind hostname and port
 * (`http://<hostname>:<port>`), or leaves it relative — so it resolves against
 * Next's dummy `http://n` base — unless `experimental.trustHostHeader` is on,
 * which it is not. In production the app binds `process.env.HOSTNAME || 0.0.0.0`
 * and serves `https://app.ever.works` through an ingress, so comparing a browser
 * Referer against `new URL(request.url).origin` could never match and rejected
 * EVERY call to every guarded route (EW e2e shards 16 and 27, red since
 * 2026-08-23).
 *
 * `WEB_URL` / `NEXT_PUBLIC_WEB_URL` is the deployment's public origin and is
 * already set wherever this runs (prod k8s manifest, the e2e workflow). Read it
 * per call rather than at module load so tests and env changes are honoured.
 */
function trustedBrowserOrigin(): string | null {
    const configured = process.env.NEXT_PUBLIC_WEB_URL || process.env.WEB_URL;
    if (!configured) return null;
    try {
        return new URL(configured).origin;
    } catch {
        return null;
    }
}

/**
 * Query-string carrier for routes a browser NAVIGATES to.
 *
 * `<a href download>`, `<img src>` and `<video src>` cannot send a custom
 * header, so `x-ever-workspace` never reaches those routes — and Next
 * middleware cannot supply it either, because `proxy.ts`'s matcher excludes
 * `/api`. Those routes read the selector from `?scope=` instead.
 *
 * The value is the SAME grammar as the header (`personal` | `org:<slug>`), so
 * the two carriers cannot disagree about what a valid selector is.
 */
export const WORKSPACE_SCOPE_QUERY_PARAM = 'scope' as const;

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

        const upstream = new Headers(baseHeaders);
        upstream.delete(BROWSER_WORKSPACE_SCOPE_HEADER);
        upstream.set(API_SCOPE_HEADER, toApiScopeHeader(selected));
        return upstream;
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
 * Header ONLY. This deliberately ignores `?scope=`: an XHR route that also
 * honoured the query string would let a crafted link influence a fetch the
 * page's own transport thought it controlled. Routes reached by navigation use
 * {@link applyBffWorkspaceScopeFromNavigation}.
 */
export function applyBffWorkspaceScope(request: Request, baseHeaders: HeadersInit): Headers {
    return toScopedHeaders(
        request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER),
        request,
        baseHeaders,
    );
}

/**
 * For routes a browser navigates to: `?scope=` first, then the header.
 *
 * The query string wins when both are present because a navigation IS the
 * user's action — the URL they clicked is the authority, in the same way the
 * visible pathname is for the app shell. When neither is present this throws,
 * exactly like the header variant: an old bookmark with no scope is a request
 * with no answer to "which workspace?", and silently defaulting to personal is
 * the bug this whole family of fixes removes.
 *
 * The Referer check in {@link toScopedHeaders} does extra work here for free.
 * For a navigation, Referer is the page the link sat on — so a `?scope=` that
 * disagrees with the page the user is actually looking at is rejected, which
 * makes a copied-and-edited URL fail closed rather than cross scopes.
 *
 * `request.url`'s ORIGIN is unreliable inside Next (see `trustedBrowserOrigin`),
 * but its path and query are intact, which is all this reads.
 */
export function applyBffWorkspaceScopeFromNavigation(
    request: Request,
    baseHeaders: HeadersInit,
): Headers {
    const fromQuery = new URL(request.url).searchParams.get(WORKSPACE_SCOPE_QUERY_PARAM);
    const raw =
        fromQuery !== null ? fromQuery : request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER);
    return toScopedHeaders(raw, request, baseHeaders);
}
