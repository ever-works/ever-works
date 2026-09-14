// Same module-scope barrel stubs as `tasks.controller.pr-insights.spec.ts`:
// the controller's DI types come from `@ever-works/agent` barrels whose
// runtime graphs do not load under this app's jest module mapping, and
// every dependency here is a stub anyway.
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskStatus: {},
    TaskPriority: {},
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));

import { TasksController } from './tasks.controller';

/**
 * Board visibility (Task Triggers) at the API boundary.
 *
 * `hiddenFromBoard` is only worth anything if the flag actually reaches
 * the repository filter: this list handler builds its filter from
 * individual `@Query` params by hand, so a new field that nobody copies
 * into that object is inert no matter how correct the repository is.
 * These cases pin the copy.
 */
describe('TasksController — includeHidden query mapping', () => {
    const auth = { userId: 'user-1' } as never;
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function make() {
        const list = jest.fn().mockResolvedValue({ rows: [], total: 0 });
        const controller = new TasksController(
            { list } as never,
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
        return { controller, list };
    }

    /** Call `list` with only the params under test; the rest are optional. */
    async function callList(controller: TasksController, includeHidden?: string): Promise<void> {
        await controller.list(
            auth,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            includeHidden,
        );
    }

    it('defaults to excluding hidden Tasks', async () => {
        const { controller, list } = make();
        await callList(controller);
        expect(list.mock.calls[0][1]).toMatchObject({ includeHidden: false });
    });

    it("passes the opt-in through only for the exact string 'true'", async () => {
        const { controller, list } = make();
        await callList(controller, 'true');
        expect(list.mock.calls[0][1]).toMatchObject({ includeHidden: true });

        await callList(controller, 'yes');
        expect(list.mock.calls[1][1]).toMatchObject({ includeHidden: false });
    });
});

/**
 * Task board read (AW-02) — the same flag on the board route. The board
 * hand-builds its input from the query string too, so the copy is pinned
 * here beside the list route's. That hidden rows are then absent from the
 * board's columns AND its counts, and present with `includeHidden=true`, is
 * proven against a real database in the agent package's
 * `task-board.integration.spec.ts`.
 */
describe('TasksController — includeHidden on the board read', () => {
    const auth = { userId: 'user-1' } as never;
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function make() {
        const getBoard = jest.fn().mockResolvedValue({ columns: [] });
        const getColumn = jest.fn().mockResolvedValue({ cards: [] });
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
            { getBoard, getColumn } as never,
        );
        return { controller, getBoard, getColumn };
    }

    it('keeps hidden Tasks off the board and out of its counts by default', async () => {
        const { controller, getBoard, getColumn } = make();
        await controller.board(auth, {});
        await controller.boardColumn(auth, { column: 'todo' });
        expect(getBoard.mock.calls[0][1]).toMatchObject({ includeHidden: false });
        expect(getColumn.mock.calls[0][1]).toMatchObject({ includeHidden: false });
    });

    it("reveals them only for the exact string 'true', on both board routes", async () => {
        const { controller, getBoard, getColumn } = make();
        await controller.board(auth, { includeHidden: 'true' });
        await controller.board(auth, { includeHidden: '1' });
        await controller.boardColumn(auth, { column: 'todo', includeHidden: 'true' });
        expect(getBoard.mock.calls[0][1]).toMatchObject({ includeHidden: true });
        expect(getBoard.mock.calls[1][1]).toMatchObject({ includeHidden: false });
        expect(getColumn.mock.calls[0][1]).toMatchObject({ includeHidden: true });
    });
});
