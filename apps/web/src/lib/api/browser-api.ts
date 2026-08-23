import {
    BROWSER_WORKSPACE_SCOPE_HEADER,
    parseWorkspacePath,
    serializeWorkspaceScope,
} from '../workspace-scope';

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

    const headers = new Headers(init.headers);
    headers.set(
        BROWSER_WORKSPACE_SCOPE_HEADER,
        serializeWorkspaceScope(parseWorkspacePath(window.location.pathname)),
    );

    return fetch(input, { ...init, headers });
}
