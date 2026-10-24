import {
    FLEET_FILES_LIMITS,
    isFleetFileName,
    isFleetFileRootId,
    normalizeFleetFileRelativePath,
} from '@ever-works/contracts';

/**
 * Files on computers (FL-11) — the shared half of the files BFF routes under
 * `app/api/fleet/nodes/[id]/files/`. Same rules as the session and logs BFF:
 * ids are checked before anything leaves the web tier, every query and body
 * is REBUILT from an allow-list (the browser never smuggles a field
 * upstream), and the platform's status and CONTRACTS §8 envelope pass through
 * untouched. Transfers are piped, never buffered.
 */

export {
    fleetApiUrl,
    forwardFleetCall,
    invalidIdResponse,
    isUuid,
    readJsonBody,
} from './fleet-sessions-bff';

/** `root` and `path` of a request, or null when either could leave its root. */
export function filesLocation(raw: {
    root?: unknown;
    path?: unknown;
}): { root: string; path: string } | null {
    if (!isFleetFileRootId(raw.root)) return null;
    const path = normalizeFleetFileRelativePath(raw.path ?? '');
    if (path === null) return null;
    return { root: raw.root, path };
}

/** Plain names (at most the transfer limit), or null when one is not a plain name. */
export function filesNames(
    value: unknown,
    max: number = FLEET_FILES_LIMITS.maxEntries,
): string[] | null {
    if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
    return value.every(isFleetFileName) ? (value as string[]) : null;
}

/**
 * The upstream query string, rebuilt: `root`, `path`, and only the keys the
 * route names (repeated keys kept as repeats, each a plain name). Unknown
 * keys — the navigation scope carrier included — are dropped.
 */
export function filesUpstreamQuery(
    search: URLSearchParams,
    allowed: { single?: readonly string[]; repeated?: readonly string[] } = {},
): string | null {
    const location = filesLocation({ root: search.get('root'), path: search.get('path') ?? '' });
    if (!location) return null;
    const out = new URLSearchParams();
    out.set('root', location.root);
    if (location.path) out.set('path', location.path);
    for (const key of allowed.single ?? []) {
        const value = search.get(key);
        if (value !== null && value.length <= 4096 && !value.includes('\0')) out.set(key, value);
    }
    for (const key of allowed.repeated ?? []) {
        const values = search.getAll(key);
        if (values.length > FLEET_FILES_LIMITS.maxEntries) return null;
        for (const value of values) {
            if (!isFleetFileName(value)) return null;
            out.append(key, value);
        }
    }
    return `?${out.toString()}`;
}

export function invalidLocationResponse(): Response {
    return Response.json(
        {
            error: {
                code: 'invalid',
                hint: 'That path leaves its root',
                details: { field: 'path' },
            },
        },
        { status: 400 },
    );
}
