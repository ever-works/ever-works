import {
    isFleetPortNumber,
    isFleetPortOpenTarget,
    parseFleetPortWatchList,
} from '@ever-works/contracts';

/**
 * Servers and ports (FL-10) — the shared half of the ports BFF routes under
 * `app/api/fleet/nodes/[id]/ports/`. Same two rules as the session BFF:
 * ids and port numbers are checked before anything leaves the web tier, and
 * every body or query is REBUILT from an allow-list. The platform's status and
 * CONTRACTS §8 envelope pass through untouched.
 */

export {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from './fleet-sessions-bff';

/** `?watch=4000,4001` rebuilt: valid, distinct ports only, at most eight. Empty string when none. */
export function sanitizePortsQuery(params: URLSearchParams): string {
    const watch = parseFleetPortWatchList(params.get('watch') ?? undefined);
    return watch.length > 0 ? `?watch=${watch.join(',')}` : '';
}

/** A `:port` path segment, or null. */
export function parsePortSegment(value: string): number | null {
    if (!/^\d{1,5}$/.test(value)) return null;
    const port = Number(value);
    return isFleetPortNumber(port) ? port : null;
}

/** The open body: `target` and `scheme` only, each from its allow-list. */
export function sanitizeOpenBody(raw: Record<string, unknown>): {
    target?: 'desktop' | 'preview-profile';
    scheme?: 'http' | 'https';
} {
    const body: { target?: 'desktop' | 'preview-profile'; scheme?: 'http' | 'https' } = {};
    if (isFleetPortOpenTarget(raw.target)) body.target = raw.target;
    if (raw.scheme === 'http' || raw.scheme === 'https') body.scheme = raw.scheme;
    return body;
}
