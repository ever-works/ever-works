import { TASK_BOARD_FOCUS_COLUMNS } from '@ever-works/contracts';
import { SharedView, sharedViewDefaults } from '../../entities/shared-view.entity';
import { SharedViewProjectionService } from '../shared-view-projection.service';

const NOW = new Date('2026-09-14T12:00:00.000Z');

function view(overrides: Partial<SharedView> = {}): SharedView {
    return Object.assign(new SharedView(), {
        id: 'view-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        ownerUserId: 'owner-1',
        tokenHash: 'h'.repeat(64),
        tokenEncrypted: { token: 't'.repeat(43) },
        ...sharedViewDefaults(),
        ...overrides,
    });
}

function card(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        title: `Task ${id}`,
        status: 'todo',
        priority: 'p2',
        labels: [],
        updatedAt: new Date('2026-09-14T11:00:00.000Z'),
        agentId: null,
        missionId: 'mission-secret',
        workId: 'work-secret',
        run: null,
        ...overrides,
    };
}

/** The board the private Focus layout would return: four columns, board order. */
function focusBoard(
    columns: Record<string, { cards: unknown[]; total: number; failed?: boolean }>,
) {
    return {
        layout: 'focus',
        columnLimit: 50,
        terminalWindowDays: 7,
        sort: 'priority',
        columns: TASK_BOARD_FOCUS_COLUMNS.filter((column) => !column.toggleOnly).map((column) => ({
            key: column.key,
            statuses: [...column.statuses],
            total: columns[column.key]?.total ?? 0,
            cards: columns[column.key]?.cards ?? [],
            offset: 0,
            limit: 50,
            failed: columns[column.key]?.failed ?? false,
        })),
    };
}

function makeService(options: {
    board?: ReturnType<typeof focusBoard>;
    actors?: Array<{ agentId: string; label: string; status: string }>;
    feedItems?: unknown[];
    boardError?: Error;
    feedError?: Error;
}) {
    const board = {
        getBoard: options.boardError
            ? jest.fn().mockRejectedValue(options.boardError)
            : jest.fn().mockResolvedValue(options.board ?? focusBoard({})),
    };
    const feed = {
        getActors: jest.fn().mockResolvedValue({
            actors: (options.actors ?? []).map((actor) => ({
                ...actor,
                avatarMode: 'initials',
                count: 0,
                lastActivityAt: null,
            })),
            windowHours: 24,
        }),
        getPage: options.feedError
            ? jest.fn().mockRejectedValue(options.feedError)
            : jest.fn().mockResolvedValue({
                  items: options.feedItems ?? [],
                  nextCursor: null,
                  hasMore: false,
                  historyFloor: NOW.toISOString(),
              }),
    };
    const organizations = {
        findById: jest.fn().mockResolvedValue({ id: 'org-1', displayName: 'Northwind Studio' }),
    };
    const service = new SharedViewProjectionService(
        board as any,
        feed as any,
        organizations as any,
    );
    return { service, board, feed, organizations };
}

describe('SharedViewProjectionService.projectBoard', () => {
    it('reads the owner board in the view Workspace with the private Focus layout', async () => {
        const { service, board, feed } = makeService({});
        await service.projectBoard(view(), NOW);

        expect(board.getBoard).toHaveBeenCalledWith(
            'owner-1',
            expect.objectContaining({ layout: 'focus', columnLimit: 50, includeCancelled: false }),
            { tenantId: 'tenant-1', organizationId: 'org-1' },
        );
        const [, input] = board.getBoard.mock.calls[0];
        // Board defaults stay the board's own: no sub-tasks, templates or hidden Tasks.
        expect(input.includeSubtasks).toBeUndefined();
        expect(input.includeTemplates).toBeUndefined();
        expect(input.includeHidden).toBeUndefined();
        expect(feed.getActors).toHaveBeenCalledWith(
            'owner-1',
            { tenantId: 'tenant-1', organizationId: 'org-1' },
            undefined,
            NOW,
        );
    });

    it('publishes the four Focus columns in board order with their cards in board order', async () => {
        const { service } = makeService({
            board: focusBoard({
                backlog: { cards: [card('b1'), card('b2')], total: 2 },
                in_flight: { cards: [card('f1', { status: 'in_progress' })], total: 1 },
                needs_you: { cards: [card('n1', { status: 'blocked' })], total: 1 },
                done: { cards: [card('d1', { status: 'done' })], total: 1 },
            }),
        });
        const published = await service.projectBoard(view(), NOW);

        expect(published.columns.map((column) => column.key)).toEqual([
            'backlog',
            'in_flight',
            'needs_you',
            'done',
        ]);
        expect(published.columns[0].cards.map((entry) => entry.title)).toEqual([
            'Task b1',
            'Task b2',
        ]);
        expect(published.columns[2].cards[0].column).toBe('needs_you');
        expect(published.workspaceName).toBe('Northwind Studio');
        expect(published.generatedAt).toBe(NOW.toISOString());
        const serialised = JSON.stringify(published);
        expect(serialised).not.toContain('mission-secret');
        expect(serialised).not.toContain('work-secret');
        expect(serialised).not.toContain('"blocked"');
    });

    it('caps a column at fifty cards and reports the rest as +N more', async () => {
        const cards = Array.from({ length: 50 }, (_, index) => card(`c${index}`));
        const { service } = makeService({
            board: focusBoard({ backlog: { cards, total: 73 } }),
        });
        const published = await service.projectBoard(view(), NOW);
        expect(published.columns[0].cards).toHaveLength(50);
        expect(published.columns[0].moreCount).toBe(23);
        expect(published.columns[1].moreCount).toBe(0);
    });

    it('publishes an unreadable column as empty, implying no hidden work', async () => {
        const { service } = makeService({
            board: focusBoard({ done: { cards: [], total: 0, failed: true } }),
        });
        const published = await service.projectBoard(view(), NOW);
        expect(published.columns[3]).toEqual({ key: 'done', cards: [], moreCount: 0 });
    });

    it('renders an empty board without failing', async () => {
        const { service } = makeService({});
        const published = await service.projectBoard(view(), NOW);
        expect(published.columns.every((column) => column.cards.length === 0)).toBe(true);
        expect(published.columns.every((column) => column.moreCount === 0)).toBe(true);
    });

    it('names card Agents from the roster and counts their in-flight cards', async () => {
        const { service } = makeService({
            actors: [
                { agentId: 'agent-nova', label: 'Nova', status: 'active' },
                { agentId: 'agent-ivy', label: 'Ivy', status: 'active' },
                { agentId: 'agent-wren', label: 'Wren', status: 'paused' },
            ],
            board: focusBoard({
                in_flight: {
                    cards: [
                        card('f1', { status: 'in_progress', agentId: 'agent-nova' }),
                        card('f2', { status: 'in_progress', agentId: 'agent-nova' }),
                    ],
                    total: 2,
                },
                backlog: { cards: [card('b1', { agentId: 'agent-ivy' })], total: 1 },
            }),
        });
        const published = await service.projectBoard(view(), NOW);

        expect(published.columns[1].cards[0].agent).toEqual({ name: 'Nova' });
        expect(published.agents).toEqual([
            { name: 'Nova', status: 'working', inFlightCount: 2 },
            { name: 'Ivy', status: 'idle', inFlightCount: 0 },
            { name: 'Wren', status: 'paused', inFlightCount: 0 },
        ]);
        expect(JSON.stringify(published)).not.toContain('agent-nova');
    });

    it('keeps only the publishable activity, at most twenty lines', async () => {
        const entry = (index: number, actionType: string) => ({
            id: `a${index}`,
            createdAt: new Date(NOW.getTime() - index * 60_000).toISOString(),
            kind: 'work',
            status: 'completed',
            actionType,
            actor: { kind: 'agent', agentId: 'agent-nova', label: 'Nova' },
            narration: { key: 'taskCompleted', params: { actor: 'Nova' } },
            target: null,
        });
        const items = [
            entry(0, 'kb_document_created'),
            entry(1, 'git_pushed'),
            ...Array.from({ length: 30 }, (_, index) => entry(index + 2, 'task_completed')),
        ];
        const { service } = makeService({ feedItems: items });
        const published = await service.projectBoard(view(), NOW);

        expect(published.recent).toHaveLength(20);
        expect(published.recent.every((line) => line.narration.key === 'taskCompleted')).toBe(true);
    });

    it('still publishes the board when the roster or the strip cannot be read', async () => {
        const { service } = makeService({
            feedError: new Error('feed down'),
            board: focusBoard({ backlog: { cards: [card('b1')], total: 1 } }),
        });
        const published = await service.projectBoard(view(), NOW);
        expect(published.recent).toEqual([]);
        expect(published.columns[0].cards).toHaveLength(1);
    });

    it('fails the projection when the board itself cannot be read', async () => {
        const { service } = makeService({ boardError: new Error('board down') });
        await expect(service.projectBoard(view(), NOW)).rejects.toThrow('board down');
    });
});
