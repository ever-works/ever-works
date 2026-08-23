jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskStatus: { TODO: 'todo', IN_PROGRESS: 'in_progress' },
    TaskPriority: { P3: 'p3' },
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
    ownershipScopeOf: (row: { tenantId?: string | null; organizationId?: string | null }) => ({
        tenantId: row.tenantId ?? null,
        organizationId: row.organizationId ?? null,
    }),
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import { TasksController } from './tasks.controller';
import { NotFoundException } from '@nestjs/common';

describe('TasksController — board-run active scope', () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const auth = { userId } as never;
    const taskId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const agentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };

    function build() {
        const service = {
            list: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            create: jest.fn().mockResolvedValue({ id: taskId }),
            getOne: jest.fn().mockResolvedValue({ id: taskId, workId: null, ...everScope }),
            update: jest.fn().mockResolvedValue({ id: taskId }),
            listSubtasks: jest.fn().mockResolvedValue({ rows: [], total: 0, doneCount: 0 }),
            remove: jest.fn().mockResolvedValue({ deleted: true }),
            setRecurring: jest.fn().mockResolvedValue({ id: taskId }),
            clearRecurring: jest.fn().mockResolvedValue({ id: taskId }),
            scheduleTask: jest.fn().mockResolvedValue({ id: taskId }),
            unscheduleTask: jest.fn().mockResolvedValue({ id: taskId }),
            transition: jest.fn().mockResolvedValue({ id: taskId }),
            addAssignee: jest.fn().mockResolvedValue({}),
            removeAssignee: jest.fn().mockResolvedValue({ deleted: true }),
            addReviewer: jest.fn().mockResolvedValue({}),
            addApprover: jest.fn().mockResolvedValue({}),
            addBlocker: jest.fn().mockResolvedValue({}),
            removeBlocker: jest.fn().mockResolvedValue({ deleted: true }),
            listAttachments: jest.fn().mockResolvedValue([]),
            addAttachment: jest.fn().mockResolvedValue({}),
            removeAttachment: jest.fn().mockResolvedValue({ deleted: true }),
            addRelation: jest.fn().mockResolvedValue({}),
            runTasksBatch: jest.fn().mockResolvedValue({ results: [] }),
            listRunCandidates: jest.fn().mockResolvedValue([]),
            runTask: jest.fn().mockResolvedValue({ taskId, agentId }),
        };
        const chat = {
            list: jest.fn().mockResolvedValue([]),
            post: jest.fn().mockResolvedValue({ id: 'message-1' }),
        };
        const agents = { findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [] }) };
        const escalations = { resolveForTask: jest.fn().mockResolvedValue(true) };
        const controller = new TasksController(
            service as never,
            chat as never,
            { getTotalSpendCentsForTask: jest.fn().mockResolvedValue(0) } as never,
            agents as never,
            {} as never,
            {} as never,
            {} as never,
            escalations as never,
            {} as never,
            { getScope: () => everScope } as never,
        );
        return { controller, service, chat, agents, escalations };
    }

    it('threads the exact active tenant and Organization through run, batch, and candidates', async () => {
        const { controller, service } = build();

        await controller.run(auth, taskId, { agentId });
        await controller.runBatch(auth, { items: [{ taskId, agentId }] });
        await controller.runCandidates(auth, taskId);

        expect(service.runTask).toHaveBeenCalledWith(userId, taskId, { agentId }, everScope);
        expect(service.runTasksBatch).toHaveBeenCalledWith(
            userId,
            [{ taskId, agentId }],
            everScope,
        );
        expect(service.listRunCandidates).toHaveBeenCalledWith(userId, taskId, everScope);
    });

    it('binds escalation resolution to the routed Task and its persisted scope', async () => {
        const { controller, service, escalations } = build();
        const escalationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

        await controller.resolveEscalation(auth, taskId, escalationId, { note: 'Approved' });

        expect(service.getOne).toHaveBeenCalledWith(userId, taskId, everScope);
        expect(escalations.resolveForTask).toHaveBeenCalledWith(
            escalationId,
            userId,
            taskId,
            everScope,
            'Approved',
        );
    });

    it('uses the same opaque 404 when scoped Task escalation CAS loses', async () => {
        const { controller, escalations } = build();
        const escalationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        escalations.resolveForTask.mockResolvedValueOnce(false);

        await expect(
            controller.resolveEscalation(auth, taskId, escalationId, { note: 'Approved' }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('threads the exact active scope through every core Task and chat request operation', async () => {
        const { controller, service, chat, agents } = build();
        const assigneeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        const attachmentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        const relatedTaskId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

        await (controller.list as any)(auth);
        await controller.create(auth, { title: 'Scoped' } as never);
        await controller.getOne(auth, taskId);
        await controller.update(auth, taskId, {} as never);
        await controller.listSubtasks(auth, taskId);
        await controller.remove(auth, taskId);
        await controller.setRecurring(auth, taskId, { recurrenceRule: 'FREQ=DAILY' } as never);
        await controller.schedule(auth, taskId, { runAt: '2099-01-01T00:00:00.000Z' } as never);
        await controller.unschedule(auth, taskId);
        await controller.clearRecurring(auth, taskId);
        await controller.transition(auth, taskId, { to: 'in_progress', force: false } as never);
        await controller.addAssignee(auth, taskId, {
            assigneeType: 'agent',
            assigneeId,
        } as never);
        await controller.removeAssignee(auth, taskId, assigneeId);
        await controller.addReviewer(auth, taskId, {
            reviewerType: 'agent',
            reviewerId: assigneeId,
        } as never);
        await controller.addApprover(auth, taskId, {
            approverType: 'agent',
            approverId: assigneeId,
        } as never);
        await controller.addBlocker(auth, taskId, { blockedByTaskId: relatedTaskId });
        await controller.removeBlocker(auth, taskId, relatedTaskId);
        await controller.listAttachments(auth, taskId);
        await controller.addAttachment(auth, taskId, {
            uploadId: attachmentId,
            role: 'initial',
        } as never);
        await controller.removeAttachment(auth, taskId, attachmentId);
        await controller.addRelation(auth, taskId, {
            relatedTaskId,
            kind: 'related',
        } as never);
        await (controller.listChat as any)(auth, taskId);
        await (controller.spend as any)(auth, taskId);
        await controller.postChat(auth, taskId, { body: 'hello' } as never);

        const scopedMethods = [
            'list',
            'create',
            'getOne',
            'update',
            'listSubtasks',
            'remove',
            'setRecurring',
            'scheduleTask',
            'unscheduleTask',
            'clearRecurring',
            'transition',
            'addAssignee',
            'removeAssignee',
            'addReviewer',
            'addApprover',
            'addBlocker',
            'removeBlocker',
            'listAttachments',
            'addAttachment',
            'removeAttachment',
            'addRelation',
        ] as const;
        for (const method of scopedMethods) {
            expect(
                service[method].mock.calls.some(
                    (call: unknown[]) => call[call.length - 1] === everScope,
                ),
            ).toBe(true);
        }
        expect(chat.list).toHaveBeenCalledWith(userId, taskId, expect.any(Object), everScope);
        expect(chat.post).toHaveBeenCalledWith(
            userId,
            expect.objectContaining({ taskId }),
            expect.any(Object),
            everScope,
        );
        expect(agents.findByUserIdScoped).toHaveBeenCalledWith(userId, { limit: 500 }, everScope);
    });
});
