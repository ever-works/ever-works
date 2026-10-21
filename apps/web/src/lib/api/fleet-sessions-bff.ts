import {
    FLEET_SESSION_CWD_MAX_LENGTH,
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    FLEET_SESSION_KINDS,
    FLEET_SESSION_TITLE_MAX_LENGTH,
    clampFleetSessionSize,
    isFleetSessionAttachRole,
    isFleetSessionKind,
    isFleetSessionStartableProvider,
    type FleetSessionAttachRole,
    type FleetSessionStartRequest,
} from '@ever-works/contracts';
import { API_URL } from '@/lib/constants';
import { isUuid } from './computer-bff';

/**
 * Sessions on computers (FL-04 P1b) — the shared half of the session BFF
 * routes under `app/api/fleet/`.
 *
 * Same two rules as the computer BFF (`computer-bff.ts`): ids are checked
 * before anything leaves the web tier, and every body is REBUILT field by
 * field from an allow-list — the browser never smuggles a field upstream (a
 * `startedBy`, a role it was not offered, a node id inside a body). The
 * platform's status and CONTRACTS §8 error envelope pass through untouched, so
 * the page reads `consent_missing` / `limit_exceeded` / `kill_switch` with
 * their hints instead of a generic failure.
 */

export { isUuid, invalidIdResponse, readJsonBody, forwardComputerCall as forwardFleetCall } from './computer-bff';

/** `${API_URL}/fleet<path>` — the platform's Fleet controller (`api/fleet`). */
export function fleetApiUrl(path: string): string {
    return `${API_URL}/fleet${path.startsWith('/') ? path : `/${path}`}`;
}

function text(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > max || trimmed.includes('\0')) return undefined;
    return trimmed;
}

function size(raw: Record<string, unknown>): { cols?: number; rows?: number } {
    if (typeof raw.cols !== 'number' && typeof raw.rows !== 'number') return {};
    const clamped = clampFleetSessionSize(raw.cols, raw.rows);
    return { cols: clamped.cols, rows: clamped.rows };
}

/**
 * The start body (`POST /api/fleet/nodes/:id/sessions`), rebuilt. Unknown or
 * malformed fields are dropped, never forwarded; the platform re-validates
 * every one (its DTO and service), this only keeps the browser to the shape.
 */
export function sanitizeStartBody(raw: Record<string, unknown>): Partial<FleetSessionStartRequest> {
    const body: Partial<FleetSessionStartRequest> = {};
    if (isFleetSessionKind(raw.kind)) body.kind = raw.kind;
    if (isFleetSessionStartableProvider(raw.provider)) body.provider = raw.provider;
    const cwd = text(raw.cwd, FLEET_SESSION_CWD_MAX_LENGTH);
    if (cwd !== undefined) body.cwd = cwd;
    const title = text(raw.title, FLEET_SESSION_TITLE_MAX_LENGTH);
    if (title !== undefined) body.title = title;
    if (
        typeof raw.firstMessage === 'string' &&
        raw.firstMessage.trim().length > 0 &&
        raw.firstMessage.length <= FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH &&
        !raw.firstMessage.includes('\0')
    ) {
        body.firstMessage = raw.firstMessage;
    }
    if (isUuid(raw.agentId)) body.agentId = raw.agentId;
    if (isUuid(raw.checkoutId)) body.checkoutId = raw.checkoutId;
    else if (isUuid(raw.newWorktreeOf)) body.newWorktreeOf = raw.newWorktreeOf;
    if (isUuid(raw.restartOf)) body.restartOf = raw.restartOf;
    return { ...body, ...size(raw) };
}

/** The rename body: only a 1–200 character title survives. */
export function sanitizeRenameBody(raw: Record<string, unknown>): { title?: string } {
    const title = text(raw.title, FLEET_SESSION_TITLE_MAX_LENGTH);
    return title === undefined ? {} : { title };
}

/** The end body: only `confirm: true` survives (CONTRACTS §2.2 class `confirm`). */
export function sanitizeEndBody(raw: Record<string, unknown>): { confirm?: true } {
    return raw.confirm === true ? { confirm: true } : {};
}

/** The restart body: only a terminal size survives. */
export function sanitizeRestartBody(raw: Record<string, unknown>): { cols?: number; rows?: number } {
    return size(raw);
}

/** The attach-token body: a role the platform knows, or null (the route answers 400). */
export function sanitizeAttachBody(
    raw: Record<string, unknown>,
): { role: FleetSessionAttachRole; cols?: number; rows?: number } | null {
    if (!isFleetSessionAttachRole(raw.role)) return null;
    return { role: raw.role, ...size(raw) };
}

/** The recording toggle body (P3): a boolean, or null. */
export function sanitizeRecordingBody(raw: Record<string, unknown>): { on: boolean } | null {
    return typeof raw.on === 'boolean' ? { on: raw.on } : null;
}

const LIST_STATES = ['live', 'ended'] as const;

/**
 * The list query, rebuilt (`state`, `kind`, `nodeId`, `agentId`, `since`,
 * `limit`, `cursor`), as a `?…` string (empty when nothing survived).
 */
export function sanitizeListQuery(params: URLSearchParams): string {
    const out = new URLSearchParams();
    const state = params.get('state');
    if (state && (LIST_STATES as readonly string[]).includes(state)) out.set('state', state);
    const kind = params.get('kind');
    if (kind && (FLEET_SESSION_KINDS as readonly string[]).includes(kind)) out.set('kind', kind);
    const nodeId = params.get('nodeId');
    if (isUuid(nodeId)) out.set('nodeId', nodeId);
    const agentId = params.get('agentId');
    if (isUuid(agentId)) out.set('agentId', agentId);
    const since = params.get('since');
    if (since && since.length <= 40 && !Number.isNaN(Date.parse(since))) out.set('since', since);
    const limit = Number(params.get('limit'));
    if (Number.isInteger(limit) && limit >= 1 && limit <= 200) out.set('limit', String(limit));
    const cursor = params.get('cursor');
    if (cursor && cursor.length <= 120 && /^[A-Za-z0-9:.|_-]+$/.test(cursor)) out.set('cursor', cursor);
    const query = out.toString();
    return query ? `?${query}` : '';
}
