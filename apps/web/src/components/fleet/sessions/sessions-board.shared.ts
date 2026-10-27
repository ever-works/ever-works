import {
    FLEET_SESSION_BOARD_COLUMNS,
    isFleetSessionLive,
    type FleetSessionBoardColumn,
    type FleetSessionBoardResponse,
    type FleetSessionView,
} from '@ever-works/contracts';

/**
 * The Sessions board and list (FL-05 P3, spec FR-41 … FR-47, §5.4, §5.5) —
 * the pure rules: the view state in the address bar (so a link reproduces the
 * view, FR-44), the list's grouping by day or week and by who, the columns'
 * moves (for the polite live region), the filters applied to a list read.
 *
 * No React, no network, no `next-intl` — message KEYS and their params only.
 */

export type SessionsMode = 'board' | 'list';
export type SessionsGrouping = 'day' | 'week';
export type SessionsStateFilter = FleetSessionBoardColumn | 'ended';

export interface SessionsViewState {
    mode: SessionsMode;
    /** List only: group by day or by week. */
    grouping: SessionsGrouping;
    agentId: string | null;
    nodeId: string | null;
    kind: 'owner' | 'agent' | null;
    state: SessionsStateFilter | null;
}

export const DEFAULT_SESSIONS_VIEW: SessionsViewState = {
    mode: 'board',
    grouping: 'day',
    agentId: null,
    nodeId: null,
    kind: null,
    state: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_FILTERS: readonly SessionsStateFilter[] = [...FLEET_SESSION_BOARD_COLUMNS, 'ended'];

/** Read the view state from the address bar (unknown values fall back to the defaults). */
export function parseSessionsViewState(source: {
    get(name: string): string | null;
}): SessionsViewState {
    const mode = source.get('mode');
    const grouping = source.get('g');
    const agentId = source.get('agent');
    const nodeId = source.get('node');
    const kind = source.get('kind');
    const state = source.get('state');
    return {
        mode: mode === 'list' ? 'list' : 'board',
        grouping: grouping === 'week' ? 'week' : 'day',
        agentId: agentId && UUID.test(agentId) ? agentId : null,
        nodeId: nodeId && UUID.test(nodeId) ? nodeId : null,
        kind: kind === 'owner' || kind === 'agent' ? kind : null,
        state:
            state && (STATE_FILTERS as readonly string[]).includes(state)
                ? (state as SessionsStateFilter)
                : null,
    };
}

/** The view state as query parameters (defaults omitted), for the Activity page's single URL writer. */
export function buildSessionsQuery(view: SessionsViewState): string {
    const params = new URLSearchParams();
    if (view.mode !== 'board') params.set('mode', view.mode);
    if (view.mode === 'list' && view.grouping !== 'day') params.set('g', view.grouping);
    if (view.agentId) params.set('agent', view.agentId);
    if (view.nodeId) params.set('node', view.nodeId);
    if (view.kind) params.set('kind', view.kind);
    if (view.state) params.set('state', view.state);
    return params.toString();
}

/** The board after the filters a board read cannot apply (state). */
export function filterBoard(
    board: FleetSessionBoardResponse,
    view: Pick<SessionsViewState, 'state'>,
): FleetSessionBoardResponse {
    if (!view.state || view.state === 'ended') return board;
    const columns = {
        needs_you: [],
        working: [],
        done: [],
        idle: [],
    } as FleetSessionBoardResponse['columns'];
    columns[view.state] = board.columns[view.state];
    return { ...board, columns };
}

/** The list after the filters a list read cannot apply (state). */
export function filterList(
    sessions: readonly FleetSessionView[],
    view: Pick<SessionsViewState, 'state'>,
): FleetSessionView[] {
    if (!view.state) return [...sessions];
    if (view.state === 'ended') return sessions.filter((session) => session.state === 'ended');
    return sessions.filter((session) =>
        view.state === 'working'
            ? session.state === 'working' || session.state === 'starting'
            : session.state === view.state,
    );
}

/** Counts per column (the headers, FR-41). */
export function boardCounts(
    board: FleetSessionBoardResponse,
): Record<FleetSessionBoardColumn, number> {
    return {
        needs_you: board.columns.needs_you.length,
        working: board.columns.working.length,
        done: board.columns.done.length,
        idle: board.columns.idle.length,
    };
}

/** Which column every session is in — compared across reads to announce moves (FR-43, §5.14). */
export function columnIndex(
    board: FleetSessionBoardResponse,
): Map<string, FleetSessionBoardColumn> {
    const index = new Map<string, FleetSessionBoardColumn>();
    for (const column of FLEET_SESSION_BOARD_COLUMNS) {
        for (const session of board.columns[column]) index.set(session.id, column);
    }
    return index;
}

/** The sessions that changed column between two reads (new arrivals are not "moves"). */
export function boardMoves(
    before: Map<string, FleetSessionBoardColumn>,
    after: Map<string, FleetSessionBoardColumn>,
): Array<{ id: string; to: FleetSessionBoardColumn }> {
    const moves: Array<{ id: string; to: FleetSessionBoardColumn }> = [];
    for (const [id, to] of after) {
        const from = before.get(id);
        if (from && from !== to) moves.push({ id, to });
    }
    return moves;
}

// ─── The list: by day or week, then by who (spec §5.5) ─────────────────────

export interface SessionsListGroup {
    /** `YYYY-MM-DD` of the day, or of the week's Monday. */
    period: string;
    /** The Agent's id, `you`, or `shell` for a person's plain shells. */
    whoKey: string;
    sessions: FleetSessionView[];
}

function dayKey(at: Date): string {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

function periodOf(session: FleetSessionView, grouping: SessionsGrouping): string {
    const at = new Date(session.stateChangedAt ?? session.lastActivityAt ?? session.createdAt);
    if (Number.isNaN(at.getTime())) return '0000-00-00';
    if (grouping === 'day') return dayKey(at);
    const monday = new Date(at);
    const weekday = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - weekday);
    return dayKey(monday);
}

/**
 * Group the list: newest period first; inside a period, the Agents and "you"
 * in the order their most recent session moved; inside a group, most recently
 * moved first. Live sessions sit with their period like ended ones (the list
 * is a record, the board is the present).
 */
export function groupSessionsList(
    sessions: readonly FleetSessionView[],
    grouping: SessionsGrouping,
): SessionsListGroup[] {
    const movedAt = (session: FleetSessionView) =>
        Date.parse(session.stateChangedAt ?? session.lastActivityAt ?? session.createdAt) || 0;
    const sorted = [...sessions].sort((a, b) => movedAt(b) - movedAt(a));
    const groups = new Map<string, SessionsListGroup>();
    for (const session of sorted) {
        const period = periodOf(session, grouping);
        const whoKey = session.agentId ?? (session.provider === 'shell' ? 'shell' : 'you');
        const key = `${period}|${whoKey}`;
        const group = groups.get(key) ?? { period, whoKey, sessions: [] };
        group.sessions.push(session);
        groups.set(key, group);
    }
    return [...groups.values()];
}

/** The row's state words for an ended session: its reason (FR-42). */
export function endedReasonKey(
    session: Pick<FleetSessionView, 'state' | 'endedReason'>,
): 'exit' | 'user' | 'agent' | 'nodeRestart' | 'timeout' | 'killSwitch' | 'drain' | null {
    if (isFleetSessionLive(session.state)) return null;
    switch (session.endedReason) {
        case 'exit':
            return 'exit';
        case 'user':
            return 'user';
        case 'agent':
            return 'agent';
        case 'node-restart':
            return 'nodeRestart';
        case 'timeout':
            return 'timeout';
        case 'kill-switch':
            return 'killSwitch';
        case 'drain':
            return 'drain';
        default:
            return null;
    }
}

/** Every session the board shows, flattened (the palette's "Needs you" and recents read it). */
export function boardSessions(board: FleetSessionBoardResponse | null): FleetSessionView[] {
    if (!board) return [];
    return FLEET_SESSION_BOARD_COLUMNS.flatMap((column) => board.columns[column]);
}
