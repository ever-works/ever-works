import {
    BROWSER_WORKSPACE_SCOPE_HEADER,
    parseWorkspacePath,
    serializeWorkspaceScope,
} from '../workspace-scope';
import { WORKSPACE_SCOPE_QUERY_PARAM } from './bff-scope';

/**
 * Put the per-tab workspace selector on a URL the browser will NAVIGATE to.
 *
 * `<a href download>`, `<img src>` and `<video src>` cannot carry a header, so
 * {@link browserApiFetch} cannot help them — the selector has to travel in the
 * URL. The BFF route reads it back with `applyBffWorkspaceScopeFromNavigation`,
 * using the same grammar as the header, and its Referer check rejects a
 * `?scope=` that disagrees with the page the link sat on. So a copied-and-edited
 * URL fails closed rather than crossing scopes.
 *
 * Same-origin only, on purpose: this is for BFF routes. A cross-origin href here
 * is a mistake, and silently stripping the origin would hide it.
 */
export function withWorkspaceScopeQuery(href: string): string {
    if (typeof window === 'undefined') {
        throw new Error('withWorkspaceScopeQuery requires a browser workspace path');
    }

    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {
        throw new Error('withWorkspaceScopeQuery only decorates same-origin BFF URLs');
    }
    url.searchParams.set(
        WORKSPACE_SCOPE_QUERY_PARAM,
        serializeWorkspaceScope(parseWorkspacePath(window.location.pathname)),
    );
    return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Stamp the per-tab workspace selector onto an outgoing header set.
 *
 * Every browser→BFF call must carry this. A BFF route can only ever receive the
 * selector when the client sends it, because `proxy.ts`'s matcher deliberately
 * excludes `/api`, and the server side fails CLOSED without it: `serverFetch`
 * runs `parseWorkspaceSelector` on this header and throws `Invalid workspace
 * scope` when it is absent, while a scope-aware BFF route answers 400. That is
 * true in personal scope as well as org scope — a missing selector is not a
 * degraded call, it is a failed one.
 *
 * Scope is re-derived from the visible tab URL on every call, so a second tab on
 * another Organization cannot leak its scope into this one, and no persisted
 * preference can race with what the user is actually looking at.
 *
 * Prefer {@link browserApiFetch}. Use this directly only where the request is
 * issued by machinery that owns its own transport (e.g. the AI SDK's
 * `DefaultChatTransport`) and cannot be routed through `fetch` here.
 */
export function applyBrowserWorkspaceScope(headers?: HeadersInit): Headers {
    if (typeof window === 'undefined') {
        throw new Error('applyBrowserWorkspaceScope requires a browser workspace path');
    }

    const out = new Headers(headers);
    out.set(
        BROWSER_WORKSPACE_SCOPE_HEADER,
        serializeWorkspaceScope(parseWorkspacePath(window.location.pathname)),
    );
    return out;
}

/**
 * Browser-to-BFF transport. Scope is re-derived for every call from the
 * visible tab URL, so it cannot race with another tab's persisted preference.
 */
export function browserApiFetch(
    input: RequestInfo | URL,
    init: RequestInit = {},
): Promise<Response> {
    if (typeof window === 'undefined') {
        throw new Error('browserApiFetch requires a browser workspace path');
    }

    return fetch(input, { ...init, headers: applyBrowserWorkspaceScope(init.headers) });
}
