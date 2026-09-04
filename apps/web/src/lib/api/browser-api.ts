import {
    BROWSER_WORKSPACE_SCOPE_HEADER,
    parseWorkspacePath,
    serializeWorkspaceScope,
} from '../workspace-scope';

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
