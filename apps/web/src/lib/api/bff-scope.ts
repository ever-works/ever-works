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
 * Convert the browser's explicit, per-tab selector into the API contract.
 * Referer is optional, but when present it must be same-origin and agree with
 * the selector. Both browser and API scope headers are always overwritten.
 */
export function applyBffWorkspaceScope(request: Request, baseHeaders: HeadersInit): Headers {
    try {
        const selected = parseWorkspaceSelector(
            request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER),
        );
        const referer = request.headers.get('referer');
        if (referer) {
            const refererUrl = new URL(referer);
            if (refererUrl.origin !== new URL(request.url).origin) {
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
