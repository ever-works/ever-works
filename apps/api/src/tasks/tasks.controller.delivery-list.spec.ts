// Same posture as `tasks.controller.delivery.spec.ts`: the controller's DI types come from
// `@ever-works/agent` barrels whose runtime graphs do not load under this app's jest mapping,
// and every dependency is a stub here, so the barrels are stubbed. Nothing about the
// controller's behaviour is mocked.
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskDeliveryService: class {},
    TaskStatus: {
        BACKLOG: 'backlog',
        TODO: 'todo',
        IN_PROGRESS: 'in_progress',
        IN_REVIEW: 'in_review',
        BLOCKED: 'blocked',
        DONE: 'done',
        CANCELLED: 'cancelled',
    },
    TaskPriority: {},
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));

import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { TasksController } from './tasks.controller';

/**
 * APW-08 T24 — the list half: `GET /api/tasks?deliveryState=&includeDelivery=`.
 *
 *  - `deliveryState` is parsed into the filter's token list (states and `waiting`), and an unknown
 *    token is a 400 like the status / priority filters — the SQL itself is pinned in
 *    `packages/agent/src/database/repositories/__tests__/task.repository.delivery-filter.spec.ts`;
 *  - the filter reaches `TasksService.list` with the AUTHENTICATED user and the request scope,
 *    so it only ever narrows the caller's own list;
 *  - `includeDelivery=true` attaches `delivery` to each row from the rows `list` returned (never
 *    from client ids): the chain's embed when tracked, `null` when not, and the row's own state
 *    when the chain is absent or its read fails.
 */
describe('TasksController — list delivery filter and embed (APW-08 T24)', () => {
    const auth = { userId: 'user-1', authMethod: 'session' } as never;
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const ROWS = [
        { id: 'a', userId: 'user-1', deliveryState: 'live', deliveryDeploymentId: 'd-1' },
        { id: 'b', userId: 'user-1', deliveryState: null },
        { id: 'c', userId: 'user-1', deliveryState: 'deploy_failed', deliveryDeploymentId: 'd-2' },
    ];
    const EMBED_A = {
        state: 'live',
        liveUrl: 'https://bookings.example.app',
        outcome: null,
        liveWithWarnings: false,
        carriedByLaterChange: false,
    };

    function make(delivery: { listEmbeds: jest.Mock } | undefined = undefined) {
        const list = jest.fn().mockResolvedValue({ rows: ROWS, total: ROWS.length });
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
            undefined,
            undefined,
            undefined,
            delivery as never,
        );
        return { controller, list };
    }

    /** `list(auth, …)` with only the two APW-08 query params set (they are appended LAST). */
    function callList(
        controller: TasksController,
        deliveryState?: string,
        includeDelivery?: string,
        workId?: string,
    ) {
        return controller.list(
            auth,
            undefined, // status
            undefined, // priority
            undefined, // missionId
            undefined, // ideaId
            workId,
            undefined, // teamId
            undefined, // agentId
            undefined, // goalId
            undefined, // parentTaskId
            undefined, // label
            undefined, // search
            undefined, // limit
            undefined, // offset
            undefined, // includeRun
            undefined, // includeHidden
            undefined, // view
            deliveryState,
            includeDelivery,
        );
    }

    describe('?deliveryState=', () => {
        it('passes the tokens to the owner-scoped list, de-duplicated, with the other filters', async () => {
            const { controller, list } = make();
            await callList(controller, 'build_failed, deploy_failed,waiting,build_failed', undefined, 'w-1');
            expect(list).toHaveBeenCalledTimes(1);
            const [userId, filter, , passedScope] = list.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(passedScope).toBe(scope);
            expect(filter).toMatchObject({
                workId: 'w-1',
                deliveryState: ['build_failed', 'deploy_failed', 'waiting'],
            });
        });

        it('absent or empty adds no predicate (today’s list, unchanged)', async () => {
            const { controller, list } = make();
            await callList(controller, undefined);
            await callList(controller, ' , ');
            for (const [, filter] of list.mock.calls) {
                expect(filter).not.toHaveProperty('deliveryState');
            }
        });

        it('an unknown token is a 400 and the list is never read', async () => {
            const { controller, list } = make();
            await expect(callList(controller, 'live,shipped')).rejects.toBeInstanceOf(BadRequestException);
            await expect(callList(controller, 'LIVE')).rejects.toBeInstanceOf(BadRequestException);
            expect(list).not.toHaveBeenCalled();
        });
    });

    describe('?includeDelivery=', () => {
        it('omitted: rows are returned exactly as the list answered them', async () => {
            const delivery = { listEmbeds: jest.fn() };
            const { controller } = make(delivery);
            const result = await callList(controller);
            expect(result.data).toBe(ROWS);
            expect(delivery.listEmbeds).not.toHaveBeenCalled();
        });

        it('true: each row gains `delivery` from the chain, `null` when the Task is untracked', async () => {
            const delivery = { listEmbeds: jest.fn().mockResolvedValue(new Map([['a', EMBED_A]])) };
            const { controller } = make(delivery);
            const result = await callList(controller, undefined, 'true');

            // The embed is computed from the rows the owner-scoped list returned.
            expect(delivery.listEmbeds).toHaveBeenCalledWith(ROWS);
            const byId = Object.fromEntries(
                (result.data as unknown as Array<{ id: string; delivery: unknown }>).map((row) => [row.id, row.delivery]),
            );
            expect(byId.a).toEqual(EMBED_A);
            expect(byId.b).toBeNull();
            // Tracked but missing from the chain's answer: the row's own state, no details.
            expect(byId.c).toEqual({
                state: 'deploy_failed',
                liveUrl: null,
                outcome: null,
                liveWithWarnings: false,
                carriedByLaterChange: false,
            });
            expect(result.meta).toEqual({ total: 3, limit: 50, offset: 0 });
        });

        it('a runtime without the chain, or a failed chain read, still answers each state', async () => {
            for (const delivery of [undefined, { listEmbeds: jest.fn().mockRejectedValue(new Error('down')) }]) {
                const { controller } = make(delivery);
                const result = await callList(controller, undefined, 'true');
                const states = (result.data as unknown as Array<{ delivery: { state: string } | null }>).map(
                    (row) => row.delivery?.state ?? null,
                );
                expect(states).toEqual(['live', null, 'deploy_failed']);
            }
        });
    });
});
