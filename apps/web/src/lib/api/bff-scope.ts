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
 * Convert the browser's explicit, per-tab selector into the API contract.
 * Referer is optional, but when present it must come from this deployment's own
 * public origin and agree with the selector. Both browser and API scope headers
 * are always overwritten.
 */
export function applyBffWorkspaceScope(request: Request, baseHeaders: HeadersInit): Headers {
    try {
        const selected = parseWorkspaceSelector(
            request.headers.get(BROWSER_WORKSPACE_SCOPE_HEADER),
        );
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
