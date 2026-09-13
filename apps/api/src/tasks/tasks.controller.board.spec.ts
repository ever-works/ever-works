// Same module-scope barrel stubs as `tasks.controller.board-visibility.spec.ts`:
// the controller's DI types come from `@ever-works/agent` barrels whose
// runtime graphs do not load under this app's jest module mapping, and every
// dependency here is a stub anyway. `TaskStatus` / `TaskPriority` carry their
// real values because the board route reuses the list route's parsers.
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskBoardService: class {},
    TaskStatus: {
        BACKLOG: 'backlog',
        TODO: 'todo',
        IN_PROGRESS: 'in_progress',
        IN_REVIEW: 'in_review',
        BLOCKED: 'blocked',
        DONE: 'done',
        CANCELLED: 'cancelled',
    },
    TaskPriority: { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3', P4: 'p4' },
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { TasksController } from './tasks.controller';

/**
 * `GET /api/tasks/board` and `GET /api/tasks/board/column` at the API
 * boundary: the query string is hand-mapped onto the board input, so every
 * default, clamp and toggle is pinned here. A new query field nobody copies
 * into that input is inert no matter how correct the service is.
 */
describe('TasksController — Task board routes', () => {
    const auth = { userId: 'user-1' } as never;
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const emptyBoard = { layout: 'status', columns: [], columnLimit: 50, terminalWindowDays: 7 };

    function make(board: unknown = undefined) {
        const service = board ?? {
            getBoard: jest.fn().mockResolvedValue(emptyBoard),
            getColumn: jest.fn().mockResolvedValue({ key: 'todo', total: 0, cards: [] }),
        };
        const controller = new TasksController(
            { list: jest.fn() } as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { getScope: () => scope } as never,
            undefined,
            service as never,
        );
        return { controller, service: service as { getBoard: jest.Mock; getColumn: jest.Mock } };
    }

    const inputOf = (mock: jest.Mock) => mock.mock.calls[0][1];

    describe('GET /api/tasks/board', () => {
        it('applies the documented defaults and threads the user and the active scope', async () => {
            const { controller, service } = make();
            await expect(controller.board(auth, {})).resolves.toBe(emptyBoard);

            expect(service.getBoard).toHaveBeenCalledWith('user-1', expect.any(Object), scope);
            expect(inputOf(service.getBoard)).toEqual({
                layout: 'status',
                columnLimit: 50,
                terminalWindowDays: 7,
                status: undefined,
                priority: undefined,
                label: undefined,
                search: undefined,
                missionId: undefined,
                ideaId: undefined,
                workId: undefined,
                teamId: undefined,
                agentId: undefined,
                goalId: undefined,
                includeSubtasks: false,
                includeTemplates: false,
                includeHidden: false,
                includeCancelled: false,
            });
        });

        it('passes layout=focus through and falls back to status for anything else', async () => {
            const { controller, service } = make();
            await controller.board(auth, { layout: 'focus' });
            await controller.board(auth, { layout: 'kanban' });
            expect(service.getBoard.mock.calls.map((call) => call[1].layout)).toEqual([
                'focus',
                'status',
            ]);
        });

        it.each([
            ['0', 1],
            ['1', 1],
            ['100', 100],
            ['101', 100],
            ['abc', 50],
            ['', 50],
        ])('clamps columnLimit=%p to %p', async (raw, expected) => {
            const { controller, service } = make();
            await controller.board(auth, { columnLimit: raw });
            expect(inputOf(service.getBoard).columnLimit).toBe(expected);
        });

        it.each([
            ['0', 1],
            ['1', 1],
            ['90', 90],
            ['91', 90],
            ['-3', 1],
            ['week', 7],
        ])('clamps terminalWindowDays=%p to %p', async (raw, expected) => {
            const { controller, service } = make();
            await controller.board(auth, { terminalWindowDays: raw });
            expect(inputOf(service.getBoard).terminalWindowDays).toBe(expected);
        });

        it.each([
            'includeSubtasks',
            'includeTemplates',
            'includeHidden',
            'includeCancelled',
        ] as const)(
            "%s turns on only for the exact string 'true' and flips nothing else",
            async (flag) => {
                const { controller, service } = make();
                await controller.board(auth, {});
                await controller.board(auth, { [flag]: 'true' });
                await controller.board(auth, { [flag]: 'yes' });
                const [baseline, on, junk] = service.getBoard.mock.calls.map((call) => call[1]);

                expect(on[flag]).toBe(true);
                expect(junk[flag]).toBe(false);
                expect({ ...on, [flag]: false }).toEqual(baseline);
            },
        );

        it('parses status and priority lists with the list route rules', async () => {
            const { controller, service } = make();
            await controller.board(auth, { status: 'todo', priority: 'p0,p1' });
            await controller.board(auth, { status: 'todo, blocked' });
            expect(service.getBoard.mock.calls[0][1]).toMatchObject({
                status: ['todo'],
                priority: ['p0', 'p1'],
            });
            expect(service.getBoard.mock.calls[1][1].status).toEqual(['todo', 'blocked']);
        });

        it('refuses an invalid status or priority with a 400, never a 500', async () => {
            const { controller, service } = make();
            await expect(controller.board(auth, { status: 'doing' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            await expect(controller.board(auth, { priority: 'urgent' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(service.getBoard).not.toHaveBeenCalled();
        });

        it('copies every owner filter, label and search onto the input', async () => {
            const { controller, service } = make();
            const ids = {
                missionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                ideaId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                workId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                teamId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                agentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                goalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            };
            await controller.board(auth, { ...ids, label: 'pricing', search: 'faq' });
            expect(inputOf(service.getBoard)).toMatchObject({
                ...ids,
                label: 'pricing',
                search: 'faq',
            });
        });

        it('answers 503 when the board service is absent from the module graph', async () => {
            const controller = new TasksController(
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                { getScope: () => scope } as never,
            );
            await expect(controller.board(auth, {})).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });
    });

    describe('GET /api/tasks/board/column', () => {
        it('reads one column at an offset with the same input the board uses', async () => {
            const { controller, service } = make();
            await controller.boardColumn(auth, {
                column: 'todo',
                offset: '50',
                label: 'pricing',
            });
            expect(service.getColumn).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ layout: 'status', label: 'pricing', columnLimit: 50 }),
                'todo',
                50,
                scope,
            );
        });

        it('resolves focus-layout keys against the focus table', async () => {
            const { controller, service } = make();
            await controller.boardColumn(auth, { column: 'needs_you', layout: 'focus' });
            expect(service.getColumn.mock.calls[0][2]).toBe('needs_you');
        });

        it.each([
            [{ column: 'needs_you' }, 'a focus key on the status layout'],
            [{ column: 'nope' }, 'an unknown key'],
            [{ column: '' }, 'an empty key'],
            [{} as { column: string }, 'a missing key'],
        ])('answers 400 for %p (%s) without reading', async (query) => {
            const { controller, service } = make();
            await expect(controller.boardColumn(auth, query)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(service.getColumn).not.toHaveBeenCalled();
        });

        it.each([
            [undefined, 0],
            ['-5', 0],
            ['abc', 0],
            ['120', 120],
        ])('reads offset=%p as %p', async (raw, expected) => {
            const { controller, service } = make();
            await controller.boardColumn(auth, { column: 'done', offset: raw });
            expect(service.getColumn.mock.calls[0][3]).toBe(expected);
        });
    });
});
