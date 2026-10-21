import { describe, expect, it } from 'vitest';
import type { FleetSessionBoardResponse, FleetSessionView } from '@ever-works/contracts';
import {
    boardCounts,
    boardMoves,
    buildSessionsQuery,
    columnIndex,
    filterBoard,
    filterList,
    groupSessionsList,
    parseSessionsViewState,
} from './sessions-board.shared';

/** FL-05 P3 board rules (spec FR-41 … FR-44; ACC-FL05-24 … 26). */

function session(id: string, overrides: Partial<FleetSessionView> = {}): FleetSessionView {
    return {
        id,
        nodeId: 'n1',
        userId: 'u1',
        organizationId: null,
        kind: 'owner',
        provider: 'claude-code',
        agentId: null,
        agentRunId: null,
        checkoutId: null,
        cwd: '~',
        title: id,
        state: 'working',
        outcome: null,
        endedReason: null,
        exitCode: null,
        recordingState: 'off',
        restartOfSessionId: null,
        firstMessage: null,
        startedBy: 'user:u1',
        lastActivityAt: '2026-10-21T10:00:00.000Z',
        startedAt: '2026-10-21T09:00:00.000Z',
        endedAt: null,
        createdAt: '2026-10-21T09:00:00.000Z',
        updatedAt: '2026-10-21T10:00:00.000Z',
        stateChangedAt: '2026-10-21T10:00:00.000Z',
        ...overrides,
    };
}

function board(): FleetSessionBoardResponse {
    return {
        columns: {
            needs_you: [session('a', { state: 'needs_you' })],
            working: [session('b'), session('c')],
            done: [session('d', { state: 'done', outcome: 'success' })],
            idle: [],
        },
        generatedAt: '2026-10-21T10:00:00.000Z',
    };
}

describe('the view state in the address bar (FR-44)', () => {
    it('round-trips, dropping defaults and unknown values', () => {
        const view = parseSessionsViewState(
            new URLSearchParams('mode=list&g=week&kind=agent&state=done&node=not-a-uuid&agent=11111111-1111-4111-8111-111111111111'),
        );
        expect(view).toMatchObject({
            mode: 'list',
            grouping: 'week',
            kind: 'agent',
            state: 'done',
            nodeId: null,
            agentId: '11111111-1111-4111-8111-111111111111',
        });
        expect(parseSessionsViewState(new URLSearchParams(buildSessionsQuery(view)))).toEqual(view);
        expect(buildSessionsQuery(parseSessionsViewState(new URLSearchParams('')))).toBe('');
    });
});

describe('the board (FR-41, FR-43)', () => {
    it('counts each column and filters to one state', () => {
        expect(boardCounts(board())).toEqual({ needs_you: 1, working: 2, done: 1, idle: 0 });
        expect(boardCounts(filterBoard(board(), { state: 'working' }))).toEqual({ needs_you: 0, working: 2, done: 0, idle: 0 });
    });

    it('names the cards that changed column, not the new ones', () => {
        const before = columnIndex(board());
        const next = board();
        next.columns.done.push(next.columns.working.shift() as FleetSessionView);
        next.columns.idle.push(session('new', { state: 'idle' }));
        expect(boardMoves(before, columnIndex(next))).toEqual([{ id: 'b', to: 'done' }]);
    });
});

describe('the list (FR-41, FR-42)', () => {
    it('groups by day then who, newest first, and keeps ended sessions with their period', () => {
        const groups = groupSessionsList(
            [
                session('x', { agentId: 'agent-1', stateChangedAt: '2026-10-21T08:00:00.000Z' }),
                session('y', { stateChangedAt: '2026-10-21T11:00:00.000Z' }),
                session('z', { state: 'ended', provider: 'shell', stateChangedAt: '2026-10-20T11:00:00.000Z' }),
            ],
            'day',
        );
        expect(groups.map((group) => group.whoKey)).toEqual(['you', 'agent-1', 'shell']);
        expect(filterList(groups.flatMap((group) => group.sessions), { state: 'ended' }).map((s) => s.id)).toEqual(['z']);
    });
});
