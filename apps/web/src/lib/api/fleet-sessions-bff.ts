import {
    FLEET_SESSION_ANSWER_TEXT_MAX_CHARS,
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

export {
    isUuid,
    invalidIdResponse,
    readJsonBody,
    forwardComputerCall as forwardFleetCall,
} from './computer-bff';

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
    // FL-15 P1: the Task an Agent session works on.
    if (isUuid(raw.taskId)) body.taskId = raw.taskId;
    return { ...body, ...size(raw) };
}

/** The rename body: only a 1–200 character title survives. */
export function sanitizeRenameBody(raw: Record<string, unknown>): { title?: string } {
    const title = text(raw.title, FLEET_SESSION_TITLE_MAX_LENGTH);
    return title === undefined ? {} : { title };
}

/**
 * FL-05: the PATCH body — a rename (`title`) or an acknowledgement (`acknowledge`,
 * an attention key the reader saw); a title wins when both are sent.
 */
export function sanitizePatchBody(
    raw: Record<string, unknown>,
): { title?: string } | { acknowledge: string } {
    const renamed = sanitizeRenameBody(raw);
    if (renamed.title !== undefined) return renamed;
    const key = text(raw.acknowledge, 200);
    return key === undefined ? {} : { acknowledge: key };
}

const ANSWER_SOURCES = ['card', 'detail', 'inbox', 'decisions'] as const;

/**
 * FL-05: the answer body — the attention key, then EXACTLY one of an option
 * id or a free text, and where it was answered from. Null when it is not one
 * (the route answers 400). The text is passed through as typed: it goes into
 * the session and is never stored.
 */
export function sanitizeAnswerBody(raw: Record<string, unknown>): {
    key: string;
    optionId?: string;
    text?: string;
    source?: (typeof ANSWER_SOURCES)[number];
} | null {
    const key = text(raw.key, 200);
    if (key === undefined) return null;
    const optionId =
        typeof raw.optionId === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(raw.optionId)
            ? raw.optionId
            : undefined;
    const answerText =
        typeof raw.text === 'string' &&
        raw.text.trim().length > 0 &&
        raw.text.length <= FLEET_SESSION_ANSWER_TEXT_MAX_CHARS
            ? raw.text
            : undefined;
    if ((optionId === undefined) === (answerText === undefined)) return null;
    const source = (ANSWER_SOURCES as readonly string[]).includes(raw.source as string)
        ? (raw.source as (typeof ANSWER_SOURCES)[number])
        : undefined;
    return {
        key,
        ...(optionId !== undefined ? { optionId } : {}),
        ...(answerText !== undefined ? { text: answerText } : {}),
        ...(source ? { source } : {}),
    };
}

/** The end body: only `confirm: true` survives (CONTRACTS §2.2 class `confirm`). */
export function sanitizeEndBody(raw: Record<string, unknown>): { confirm?: true } {
    return raw.confirm === true ? { confirm: true } : {};
}

/** The restart body: only a terminal size survives. */
export function sanitizeRestartBody(raw: Record<string, unknown>): {
    cols?: number;
    rows?: number;
} {
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
 * The list query, rebuilt (`state`, `kind`, `nodeId`, `agentId`, `taskId`, `since`,
 * `limit`, `cursor`), as a `?…` string (empty when nothing survived).
 */
export function sanitizeListQuery(params: URLSearchParams): string {
    const out = new URLSearchParams();
    // FL-05 P3: the board's four columns instead of a page.
    const view = params.get('view');
    if (view === 'board' || view === 'list') out.set('view', view);
    const state = params.get('state');
    if (state && (LIST_STATES as readonly string[]).includes(state)) out.set('state', state);
    const kind = params.get('kind');
    if (kind && (FLEET_SESSION_KINDS as readonly string[]).includes(kind)) out.set('kind', kind);
    const nodeId = params.get('nodeId');
    if (isUuid(nodeId)) out.set('nodeId', nodeId);
    const agentId = params.get('agentId');
    if (isUuid(agentId)) out.set('agentId', agentId);
    // FL-15 P1: the Task page's Computer block reads the Task's sessions.
    const taskId = params.get('taskId');
    if (isUuid(taskId)) out.set('taskId', taskId);
    const since = params.get('since');
    if (since && since.length <= 40 && !Number.isNaN(Date.parse(since))) out.set('since', since);
    const limit = Number(params.get('limit'));
    if (Number.isInteger(limit) && limit >= 1 && limit <= 200) out.set('limit', String(limit));
    const cursor = params.get('cursor');
    if (cursor && cursor.length <= 120 && /^[A-Za-z0-9:.|_-]+$/.test(cursor))
        out.set('cursor', cursor);
    const query = out.toString();
    return query ? `?${query}` : '';
}
