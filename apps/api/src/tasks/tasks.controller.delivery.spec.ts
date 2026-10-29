// Same posture as `tasks.controller.pr-insights.spec.ts`: the controller's DI types come from
// `@ever-works/agent` barrels whose runtime graphs do not load under this app's jest mapping,
// and every dependency is a stub here, so the barrels are stubbed. Nothing about the
// controller's behaviour is mocked.
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskDeliveryService: class {},
    TaskStatus: {},
    TaskPriority: {},
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));

import 'reflect-metadata';
import {
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException,
    UnprocessableEntityException,
} from '@nestjs/common';
import { TasksController } from './tasks.controller';

/**
 * APW-08 T24 (ACC-08-19, 22, 28, 29) — `GET /api/tasks/:id/delivery`,
 * `POST …/delivery/close`, `POST …/delivery/follow-up`.
 *
 * The API boundary only: every route resolves the Task through `TasksService.getOne` with the
 * AUTHENTICATED user and the request scope first (another account's Task is a 404 before the
 * chain is touched), then hands the LOADED Task to the delivery service. The service's own
 * rules are pinned in `packages/agent/src/app-works/__tests__/task-delivery.service.spec.ts`.
 */
describe('TasksController — App Works delivery routes (APW-08 T24)', () => {
    const auth = { userId: 'user-1', authMethod: 'session' } as never;
    const apiKey = { userId: 'user-1', authMethod: 'api-key' } as never;
    const scope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const TASK = { id: 'task-1', deliveryState: 'deploy_failed', ...scope };
    const VIEW = { taskId: 'task-1', state: 'deploy_failed' };

    function make(withDelivery = true) {
        const getOne = jest.fn().mockResolvedValue(TASK);
        const delivery = {
            getView: jest.fn().mockResolvedValue(VIEW),
            closeWithoutDeploy: jest.fn().mockResolvedValue({ ...VIEW, state: 'closed_without_deploy' }),
            requestFollowUp: jest.fn().mockResolvedValue({ taskId: 'follow-1' }),
            createFixTask: jest
                .fn()
                .mockResolvedValue({ taskId: 'fix-1', slug: 'T-9', created: true }),
        };
        const controller = new TasksController(
            { getOne } as never,
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
            withDelivery ? (delivery as never) : undefined,
        );
        return { controller, getOne, delivery };
    }

    describe('GET /tasks/:id/delivery', () => {
        it('loads the Task owner-scoped, then answers the chain for THAT Task', async () => {
            const { controller, getOne, delivery } = make();
            await expect(controller.getDelivery(auth, 'task-1')).resolves.toBe(VIEW);
            expect(getOne).toHaveBeenCalledWith('user-1', 'task-1', scope);
            expect(delivery.getView).toHaveBeenCalledWith(TASK);
        });

        it("another account's Task is a 404 and the chain is never read", async () => {
            const { controller, getOne, delivery } = make();
            getOne.mockRejectedValue(new NotFoundException('Task task-1 not found.'));
            await expect(controller.getDelivery(auth, 'task-1')).rejects.toBeInstanceOf(NotFoundException);
            expect(delivery.getView).not.toHaveBeenCalled();
        });

        it('answers an untracked chain in a runtime without the delivery chain', async () => {
            const { controller } = make(false);
            await expect(controller.getDelivery(auth, 'task-1')).resolves.toEqual({
                taskId: 'task-1',
                state: null,
                mergeCommitSha: null,
                pullRequest: null,
                build: null,
                deployment: null,
                liveUrl: null,
                liveWithWarnings: false,
                carriedByLaterChange: false,
                followUps: [],
                history: [],
            });
        });
    });

    describe('POST /tasks/:id/delivery/close', () => {
        it('closes as the authenticated user with the note', async () => {
            const { controller, delivery } = make();
            const view = await controller.closeDelivery(auth, 'task-1', { note: 'accepted' });
            expect(delivery.closeWithoutDeploy).toHaveBeenCalledWith('user-1', TASK, 'accepted');
            expect(view.state).toBe('closed_without_deploy');
        });

        it('passes the service refusal through (422 notClosable)', async () => {
            const { controller, delivery } = make();
            delivery.closeWithoutDeploy.mockRejectedValue(
                new UnprocessableEntityException({ code: 'notClosable', state: 'live' }),
            );
            await expect(controller.closeDelivery(auth, 'task-1', {})).rejects.toMatchObject({
                response: { code: 'notClosable', state: 'live' },
            });
        });

        it('a cross-account Task is a 404 before anything is written', async () => {
            const { controller, getOne, delivery } = make();
            getOne.mockRejectedValue(new NotFoundException());
            await expect(controller.closeDelivery(auth, 'task-1', {})).rejects.toBeInstanceOf(NotFoundException);
            expect(delivery.closeWithoutDeploy).not.toHaveBeenCalled();
        });

        it('answers 503 without the delivery chain', async () => {
            const { controller } = make(false);
            await expect(controller.closeDelivery(auth, 'task-1', {})).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });
    });

    describe('POST /tasks/:id/delivery/follow-up', () => {
        it('hands the escalation id, the user and the request scope to the service', async () => {
            const { controller, delivery } = make();
            await expect(
                controller.requestDeliveryFollowUp(auth, 'task-1', { escalationId: 'esc-1' }),
            ).resolves.toEqual({ taskId: 'follow-1' });
            expect(delivery.requestFollowUp).toHaveBeenCalledWith('user-1', TASK, 'esc-1', scope);
        });

        it('passes the one refusal code through (422 followUpLimit)', async () => {
            const { controller, delivery } = make();
            delivery.requestFollowUp.mockRejectedValue(
                new UnprocessableEntityException({ code: 'followUpLimit' }),
            );
            await expect(
                controller.requestDeliveryFollowUp(auth, 'task-1', { escalationId: 'esc-1' }),
            ).rejects.toMatchObject({ response: { code: 'followUpLimit' } });
        });
    });

    describe('POST /tasks/:id/delivery/fix-task (APW-08 T27)', () => {
        it('loads the Task owner-scoped, then files the fix Task for THAT Task as the user', async () => {
            const { controller, getOne, delivery } = make();
            await expect(controller.createDeliveryFixTask(auth, 'task-1')).resolves.toEqual({
                taskId: 'fix-1',
                slug: 'T-9',
                created: true,
            });
            expect(getOne).toHaveBeenCalledWith('user-1', 'task-1', scope);
            expect(delivery.createFixTask).toHaveBeenCalledWith('user-1', TASK);
        });

        it('passes the one refusal code through (422 fixTaskUnavailable)', async () => {
            const { controller, delivery } = make();
            delivery.createFixTask.mockRejectedValue(
                new UnprocessableEntityException({ code: 'fixTaskUnavailable' }),
            );
            await expect(controller.createDeliveryFixTask(auth, 'task-1')).rejects.toMatchObject({
                response: { code: 'fixTaskUnavailable' },
            });
        });

        it('a cross-account Task is a 404 before anything is filed', async () => {
            const { controller, getOne, delivery } = make();
            getOne.mockRejectedValue(new NotFoundException());
            await expect(controller.createDeliveryFixTask(auth, 'task-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(delivery.createFixTask).not.toHaveBeenCalled();
        });

        it('refuses an API key before the Task is read (it can start a paid run)', async () => {
            const { controller, getOne, delivery } = make();
            await expect(controller.createDeliveryFixTask(apiKey, 'task-1')).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(getOne).not.toHaveBeenCalled();
            expect(delivery.createFixTask).not.toHaveBeenCalled();
        });

        it('answers 503 without the delivery chain', async () => {
            const { controller } = make(false);
            await expect(controller.createDeliveryFixTask(auth, 'task-1')).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
        });

        it('mounts POST :id/delivery/fix-task, 201, throttled at 10/min', () => {
            const proto = TasksController.prototype as unknown as Record<string, unknown>;
            const handler = proto.createDeliveryFixTask as object;
            expect(Reflect.getMetadata('path', handler)).toBe(':id/delivery/fix-task');
            expect(Reflect.getMetadata('method', handler)).toBe(1);
            expect(Reflect.getMetadata('__httpCode__', handler)).toBe(201);
            const limits = Reflect.getMetadataKeys(handler)
                .filter((key) => String(key).includes('THROTTLER') && String(key).includes('LIMIT'))
                .map((key) => Reflect.getMetadata(key, handler));
            expect(limits).toContain(10);
        });
    });

    describe('human-only decisions (review of #3030)', () => {
        it('Close anyway refuses an API key before the Task is read or the chain written', async () => {
            const { controller, getOne, delivery } = make();
            await expect(controller.closeDelivery(apiKey, 'task-1', {})).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(getOne).not.toHaveBeenCalled();
            expect(delivery.closeWithoutDeploy).not.toHaveBeenCalled();
        });

        it('Try once more refuses an API key before the Inbox item is touched', async () => {
            const { controller, getOne, delivery } = make();
            await expect(
                controller.requestDeliveryFollowUp(apiKey, 'task-1', { escalationId: 'esc-1' }),
            ).rejects.toBeInstanceOf(ForbiddenException);
            expect(getOne).not.toHaveBeenCalled();
            expect(delivery.requestFollowUp).not.toHaveBeenCalled();
        });

        it('the read stays open to an API key (it decides nothing)', async () => {
            const { controller, delivery } = make();
            await expect(controller.getDelivery(apiKey, 'task-1')).resolves.toBe(VIEW);
            expect(delivery.getView).toHaveBeenCalledTimes(1);
        });
    });

    describe('route metadata', () => {
        const proto = TasksController.prototype as unknown as Record<string, unknown>;
        const throttle = (handler: string) => {
            const keys = Reflect.getMetadataKeys(proto[handler] as object);
            const limits = keys
                .filter((key) => String(key).includes('THROTTLER') && String(key).includes('LIMIT'))
                .map((key) => Reflect.getMetadata(key, proto[handler] as object));
            return limits;
        };

        it('throttles close at 30/min and follow-up at 10/min (plan §4)', () => {
            expect(throttle('closeDelivery')).toContain(30);
            expect(throttle('requestDeliveryFollowUp')).toContain(10);
        });

        it('mounts GET :id/delivery, POST :id/delivery/close and POST :id/delivery/follow-up', () => {
            expect(Reflect.getMetadata('path', proto.getDelivery as object)).toBe(':id/delivery');
            expect(Reflect.getMetadata('path', proto.closeDelivery as object)).toBe(':id/delivery/close');
            expect(Reflect.getMetadata('path', proto.requestDeliveryFollowUp as object)).toBe(
                ':id/delivery/follow-up',
            );
            // RequestMethod: GET = 0, POST = 1.
            expect(Reflect.getMetadata('method', proto.getDelivery as object)).toBe(0);
            expect(Reflect.getMetadata('method', proto.closeDelivery as object)).toBe(1);
            expect(Reflect.getMetadata('method', proto.requestDeliveryFollowUp as object)).toBe(1);
            expect(Reflect.getMetadata('__httpCode__', proto.requestDeliveryFollowUp as object)).toBe(202);
        });
    });
});
