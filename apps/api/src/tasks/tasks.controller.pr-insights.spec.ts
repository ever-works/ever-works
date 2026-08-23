// The controller's DI types come from several `@ever-works/agent`
// barrels whose runtime graphs (entities → items-generator DTOs) do not
// load under this app's jest module mapping. Every dependency is a stub
// here anyway, so stub the barrels at module scope — the same posture
// `merge-policy.controller.spec.ts` uses. Nothing about the controller's
// behaviour is mocked.
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
 * PR insights (kanban run cockpit M5/M6) — the two new read endpoints.
 *
 * What is asserted here is the API-boundary contract only (the service's
 * own throttling / owner scoping / provider behaviour is pinned in
 * `packages/agent/.../task-pr-status.service.spec.ts`):
 *
 *  1. both endpoints pass the AUTHENTICATED user id through — the owner
 *     scope is enforced inside the service off THIS id, never off a
 *     client-supplied one;
 *  2. `?refresh=true` is an explicit opt-in and nothing else enables it;
 *  3. the diff caps are CLAMPED — a caller can ask for less, never more,
 *     and junk input falls back to the platform default rather than
 *     becoming NaN / unbounded;
 *  4. the diff response is marked `private, no-store` (repo content
 *     egress — plan 04 §7.2).
 */
describe('TasksController — PR insights endpoints', () => {
    const auth = { userId: 'user-1' } as never;
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function make() {
        const getOne = jest.fn().mockResolvedValue({ id: 'task-1', ...scope });
        const getForTask = jest.fn().mockResolvedValue({ taskId: 'task-1', cached: true });
        const getDiffForTask = jest.fn().mockResolvedValue({ taskId: 'task-1', diff: {} });
        const controller = new TasksController(
            { getOne } as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            { getForTask, getDiffForTask } as never,
            { getScope: () => scope } as never,
        );
        return { controller, getOne, getForTask, getDiffForTask };
    }

    describe('GET /tasks/:id/pr-status', () => {
        it('scopes the read to the authenticated user', async () => {
            const { controller, getOne, getForTask } = make();
            await controller.prStatus(auth, 'task-1');
            expect(getOne).toHaveBeenCalledWith('user-1', 'task-1', scope);
            expect(getForTask).toHaveBeenCalledWith('user-1', 'task-1', { refresh: false });
        });

        it('forwards an explicit refresh opt-in', async () => {
            const { controller, getForTask } = make();
            await controller.prStatus(auth, 'task-1', 'true');
            expect(getForTask).toHaveBeenCalledWith('user-1', 'task-1', { refresh: true });
        });

        it('treats any other refresh value as "use the cache"', async () => {
            const { controller, getForTask } = make();
            await controller.prStatus(auth, 'task-1', '1');
            expect(getForTask).toHaveBeenCalledWith('user-1', 'task-1', { refresh: false });
        });
    });

    describe('GET /tasks/:id/diff', () => {
        it('scopes the read to the authenticated user and applies the platform caps', async () => {
            const { controller, getDiffForTask } = make();
            await controller.diff(auth, 'task-1');
            expect(getDiffForTask).toHaveBeenCalledWith('user-1', 'task-1', {
                maxFiles: 100,
                maxBytes: 262144,
            });
        });

        it('honours a SMALLER caller cap', async () => {
            const { controller, getDiffForTask } = make();
            await controller.diff(auth, 'task-1', '10', '4096');
            expect(getDiffForTask).toHaveBeenCalledWith('user-1', 'task-1', {
                maxFiles: 10,
                maxBytes: 4096,
            });
        });

        it('clamps a caller asking for MORE than the platform ceiling', async () => {
            const { controller, getDiffForTask } = make();
            await controller.diff(auth, 'task-1', '99999', '99999999');
            expect(getDiffForTask).toHaveBeenCalledWith('user-1', 'task-1', {
                maxFiles: 100,
                maxBytes: 262144,
            });
        });

        it('falls back to the default for junk / negative caps instead of NaN', async () => {
            const { controller, getDiffForTask } = make();
            await controller.diff(auth, 'task-1', 'abc', '-5');
            expect(getDiffForTask).toHaveBeenCalledWith('user-1', 'task-1', {
                maxFiles: 100,
                maxBytes: 262144,
            });
        });

        it('declares Cache-Control: private, no-store on the handler', () => {
            // Nest stores @Header() metadata on the handler; asserting it
            // here keeps the repo-content-egress rule from silently being
            // dropped in a refactor.
            const headers = Reflect.getMetadata('__headers__', TasksController.prototype.diff) as
                | Array<{ name: string; value: string }>
                | undefined;
            expect(headers).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ name: 'Cache-Control', value: 'private, no-store' }),
                ]),
            );
        });

        it('does NOT declare a cache header on the pr-status handler', () => {
            const headers = Reflect.getMetadata('__headers__', TasksController.prototype.prStatus);
            expect(headers).toBeUndefined();
        });
    });
});
