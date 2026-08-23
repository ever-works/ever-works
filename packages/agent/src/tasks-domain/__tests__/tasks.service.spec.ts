import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TasksService } from '../tasks.service';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: 'user-1',
        slug: 'T-1',
        title: 'Ship the task feature',
        description: null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'user-1',
        requireAllApprovers: true,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceRule: null,
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: null,
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        parentRecurringTaskId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    } as Task;
}

function makeService(overrides: Record<string, any> = {}) {
    const repos = {
        tasks: {
            findByIdAndUser: jest.fn(),
            findById: jest.fn(),
            findByUserIdFiltered: jest.fn(),
            create: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
            wouldCreateCycle: jest.fn().mockResolvedValue(false),
        },
        assignees: {
            add: jest.fn().mockResolvedValue({ id: 'assignee-row' }),
            removeForTask: jest.fn(),
        },
        reviewers: {
            add: jest.fn().mockResolvedValue({ id: 'reviewer-row' }),
        },
        approvers: {
            add: jest.fn().mockResolvedValue({ id: 'approver-row' }),
        },
        blocks: {
            removeForTask: jest.fn(),
        },
        relations: {},
        counter: {
            nextSlug: jest.fn().mockResolvedValue(1),
        },
        transitions: {
            recheckUnblockFor: jest.fn().mockResolvedValue(undefined),
        },
        attachments: {
            add: jest.fn(),
            findByTaskId: jest.fn(),
            removeForTask: jest.fn(),
        },
        workUploads: {
            findById: jest.fn(),
        },
        works: {
            findById: jest.fn(),
        },
        missions: {
            findOne: jest.fn(),
        },
        ideas: {
            findByIdForUser: jest.fn(),
        },
        agents: {
            findByIdAndUser: jest.fn(),
        },
        teams: {
            findOne: jest.fn(),
        },
        goals: {
            findOne: jest.fn(),
        },
        agentRuns: {
            findByIds: jest.fn(),
        },
        notifications: {
            emit: jest.fn().mockResolvedValue(undefined),
        },
        users: {
            findById: jest.fn(),
        },
        organizationMembers: {
            findByOrgAndUser: jest.fn(),
        },
        tenants: {
            findById: jest.fn(),
        },
        ...overrides,
    };

    const service = new (TasksService as any)(
        repos.tasks as any,
        repos.assignees as any,
        repos.reviewers as any,
        repos.approvers as any,
        repos.blocks as any,
        repos.relations as any,
        repos.counter as any,
        repos.transitions as any,
        undefined,
        repos.attachments as any,
        repos.agents as any,
        repos.notifications as any,
        repos.workUploads as any,
        repos.works as any,
        repos.missions as any,
        repos.ideas as any,
        repos.teams as any,
        repos.goals as any,
        repos.agentRuns as any,
        repos.users as any,
        repos.organizationMembers as any,
        repos.tenants as any,
    );

    return { service, repos };
}

describe('TasksService authorization guardrails', () => {
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const yoScope = {
        tenantId: everScope.tenantId,
        organizationId: '33333333-3333-4333-8333-333333333333',
    };

    const taskOwnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const everMemberId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const yoMemberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const actorCases = [
        {
            label: 'assignee',
            invoke: (
                service: TasksService,
                taskId: string,
                actorId: string,
                scope: typeof everScope,
            ) => service.addAssignee(taskOwnerId, taskId, 'user', actorId, scope),
            inserted: (repos: ReturnType<typeof makeService>['repos']) => repos.assignees.add,
        },
        {
            label: 'reviewer',
            invoke: (
                service: TasksService,
                taskId: string,
                actorId: string,
                scope: typeof everScope,
            ) => service.addReviewer(taskOwnerId, taskId, 'user', actorId, scope),
            inserted: (repos: ReturnType<typeof makeService>['repos']) => repos.reviewers.add,
        },
        {
            label: 'approver',
            invoke: (
                service: TasksService,
                taskId: string,
                actorId: string,
                scope: typeof everScope,
            ) => service.addApprover(taskOwnerId, taskId, 'user', actorId, scope),
            inserted: (repos: ReturnType<typeof makeService>['repos']) => repos.approvers.add,
        },
    ] as const;

    it.each(actorCases)(
        'rejects a known same-Tenant Yo user as an Ever Task $label without inserting or notifying',
        async ({ invoke, inserted }) => {
            const task = makeTask({ userId: taskOwnerId, ...everScope });
            const { service, repos } = makeService();
            repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
            repos.users.findById.mockResolvedValueOnce({
                id: yoMemberId,
                tenantId: everScope.tenantId,
                isActive: true,
            });
            // Even a repository bug returning the known Yo roster row must
            // not weaken the exact Organization comparison in the service.
            repos.organizationMembers.findByOrgAndUser.mockResolvedValueOnce({
                userId: yoMemberId,
                tenantId: yoScope.tenantId,
                organizationId: yoScope.organizationId,
            });
            repos.tenants.findById.mockResolvedValueOnce({
                id: everScope.tenantId,
                ownerUserId: taskOwnerId,
            });

            await expect(invoke(service, task.id, yoMemberId, everScope)).rejects.toThrow(
                BadRequestException,
            );
            expect(inserted(repos)).not.toHaveBeenCalled();
            expect(repos.notifications.emit).not.toHaveBeenCalled();
        },
    );

    it.each(actorCases)(
        'rejects a revoked Ever user as a Task $label with the same opaque failure',
        async ({ invoke, inserted }) => {
            const task = makeTask({ userId: taskOwnerId, ...everScope });
            const { service, repos } = makeService();
            repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
            repos.users.findById.mockResolvedValueOnce({
                id: everMemberId,
                tenantId: everScope.tenantId,
                isActive: true,
            });
            repos.organizationMembers.findByOrgAndUser.mockResolvedValueOnce(null);
            repos.tenants.findById.mockResolvedValueOnce({
                id: everScope.tenantId,
                ownerUserId: taskOwnerId,
            });

            await expect(invoke(service, task.id, everMemberId, everScope)).rejects.toThrow(
                BadRequestException,
            );
            expect(inserted(repos)).not.toHaveBeenCalled();
            expect(repos.notifications.emit).not.toHaveBeenCalled();
        },
    );

    it.each(actorCases)(
        'accepts an active exact-roster Ever user as a Task $label',
        async ({ invoke, inserted }) => {
            const task = makeTask({ userId: taskOwnerId, ...everScope });
            const { service, repos } = makeService();
            repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
            repos.users.findById.mockResolvedValueOnce({
                id: everMemberId,
                tenantId: everScope.tenantId,
                isActive: true,
            });
            repos.organizationMembers.findByOrgAndUser.mockResolvedValueOnce({
                userId: everMemberId,
                organizationId: everScope.organizationId,
                tenantId: everScope.tenantId,
            });

            await expect(invoke(service, task.id, everMemberId, everScope)).resolves.toBeDefined();
            expect(inserted(repos)).toHaveBeenCalled();
        },
    );

    it('allows the tenant owner without a roster row on an Ever Task', async () => {
        const task = makeTask({ userId: taskOwnerId, ...everScope });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
        repos.users.findById.mockResolvedValueOnce({
            id: taskOwnerId,
            tenantId: everScope.tenantId,
            isActive: true,
        });
        repos.organizationMembers.findByOrgAndUser.mockResolvedValueOnce(null);
        repos.tenants.findById.mockResolvedValueOnce({
            id: everScope.tenantId,
            ownerUserId: taskOwnerId,
        });

        await expect(
            service.addAssignee(taskOwnerId, task.id, 'user', taskOwnerId, everScope),
        ).resolves.toBeDefined();
    });

    it('keeps personal Task user actors limited to the personal owner', async () => {
        const personalScope = { tenantId: everScope.tenantId, organizationId: null };
        const task = makeTask({ userId: taskOwnerId, ...personalScope });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(task);
        repos.users.findById
            .mockResolvedValueOnce({
                id: taskOwnerId,
                tenantId: everScope.tenantId,
                isActive: true,
            })
            .mockResolvedValueOnce({
                id: everMemberId,
                tenantId: everScope.tenantId,
                isActive: true,
            });

        await expect(
            service.addReviewer(taskOwnerId, task.id, 'user', taskOwnerId, personalScope),
        ).resolves.toBeDefined();
        await expect(
            service.addReviewer(taskOwnerId, task.id, 'user', everMemberId, personalScope),
        ).rejects.toThrow(BadRequestException);
        expect(repos.reviewers.add).toHaveBeenCalledTimes(1);
    });

    it('scopes the includeRun batch lookup instead of trusting a Task latestRunId pointer', async () => {
        const knownRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
        const task = makeTask({ latestRunId: knownRunId, ...everScope });
        const { service, repos } = makeService();
        repos.tasks.findByUserIdFiltered.mockResolvedValueOnce({ rows: [task], total: 1 });
        repos.agentRuns.findByIds.mockResolvedValueOnce([]);

        await service.list('user-1', {}, { includeRun: true }, everScope);

        expect(repos.agentRuns.findByIds).toHaveBeenCalledWith([knownRunId], 'user-1', everScope);
    });

    it('404s a same-user Task UUID from another active Organization', async () => {
        const hidden = makeTask({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            tenantId: yoScope.tenantId,
            organizationId: yoScope.organizationId,
        });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(hidden);

        await expect(
            (service.getOne as any)('user-1', hidden.id, everScope),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(repos.tasks.findByIdAndUser).toHaveBeenCalledWith(hidden.id, 'user-1', everScope);
    });

    it('404s when the Task row matches but its Work belongs to Yo', async () => {
        const hiddenWorkTask = makeTask({
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            workId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            ...everScope,
        });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(hiddenWorkTask);
        repos.works.findById.mockResolvedValueOnce({
            id: hiddenWorkTask.workId,
            userId: 'user-1',
            ...yoScope,
        });

        await expect(
            (service.getOne as any)('user-1', hiddenWorkTask.id, everScope),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('keeps legacy personal Task and Work rows reachable in personal scope', async () => {
        const legacy = makeTask({
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            workId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
            tenantId: null,
            organizationId: null,
        });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(legacy);
        repos.works.findById.mockResolvedValueOnce({
            id: legacy.workId,
            userId: 'user-1',
            tenantId: null,
            organizationId: null,
        });

        await expect(
            (service.getOne as any)('user-1', legacy.id, {
                tenantId: everScope.tenantId,
                organizationId: null,
            }),
        ).resolves.toBe(legacy);
    });

    it('rejects Work-scoped task creation when the Work is not owned by the user', async () => {
        const { service, repos } = makeService();
        repos.works.findById.mockResolvedValueOnce({ id: 'work-1', userId: 'other-user' });

        await expect(
            service.create('user-1', {
                title: 'Scoped task',
                workId: 'work-1',
                createdByType: 'user',
                createdById: 'user-1',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(repos.tasks.create).not.toHaveBeenCalled();
    });

    it('allows Work-scoped task creation when the Work is owned by the user', async () => {
        const created = makeTask({ id: 'task-created', workId: 'work-1', slug: 'T-1' });
        const { service, repos } = makeService();
        repos.works.findById.mockResolvedValueOnce({ id: 'work-1', userId: 'user-1' });
        repos.tasks.create.mockResolvedValueOnce(created);

        await expect(
            service.create('user-1', {
                title: 'Scoped task',
                workId: 'work-1',
                createdByType: 'user',
                createdById: 'user-1',
            }),
        ).resolves.toEqual(created);
        expect(repos.tasks.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
        );
    });

    it('stamps an explicit Goal background scope and validates its Agent in that same scope', async () => {
        const created = makeTask({ id: 'task-created', goalId: 'goal-ever', ...everScope });
        const { service, repos } = makeService();
        repos.goals.findOne.mockResolvedValueOnce({
            id: 'goal-ever',
            userId: 'user-1',
            ...everScope,
        });
        repos.agents.findByIdAndUser.mockResolvedValueOnce({
            id: 'agent-ever',
            userId: 'user-1',
            ...everScope,
        });
        repos.tasks.create.mockResolvedValueOnce(created);

        await expect(
            service.create(
                'user-1',
                {
                    title: 'Goal iteration',
                    goalId: 'goal-ever',
                    agentId: 'agent-ever',
                    createdByType: 'user',
                    createdById: 'user-1',
                },
                everScope,
            ),
        ).resolves.toEqual(created);

        expect(repos.agents.findByIdAndUser).toHaveBeenCalledWith(
            'agent-ever',
            'user-1',
            everScope,
        );
        expect(repos.goals.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                where: [{ id: 'goal-ever', userId: 'user-1', ...everScope }],
            }),
        );
        expect(repos.tasks.create).toHaveBeenCalledWith(expect.objectContaining(everScope));
    });

    it('rejects Mission-scoped task creation when the Mission is not owned by the user', async () => {
        const { service, repos } = makeService();
        repos.missions.findOne.mockResolvedValueOnce(null);

        await expect(
            service.create('user-1', {
                title: 'Mission task',
                missionId: 'mission-1',
                createdByType: 'user',
                createdById: 'user-1',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(repos.tasks.create).not.toHaveBeenCalled();
    });

    it('rejects Idea-scoped task creation when the Idea is not owned by the user', async () => {
        const { service, repos } = makeService();
        repos.ideas.findByIdForUser.mockResolvedValueOnce(null);

        await expect(
            service.create('user-1', {
                title: 'Idea task',
                ideaId: 'idea-1',
                createdByType: 'user',
                createdById: 'user-1',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(repos.tasks.create).not.toHaveBeenCalled();
    });

    it('rejects child task creation when parent scope differs from child scope', async () => {
        const parent = makeTask({ id: 'parent-1', workId: 'work-2' });
        const { service, repos } = makeService();
        repos.works.findById.mockResolvedValueOnce({ id: 'work-1', userId: 'user-1' });
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(parent);

        await expect(
            service.create('user-1', {
                title: 'Child task',
                workId: 'work-1',
                parentTaskId: parent.id,
                createdByType: 'user',
                createdById: 'user-1',
            }),
        ).rejects.toThrow(BadRequestException);
        expect(repos.tasks.create).not.toHaveBeenCalled();
    });

    it('rejects parentTaskId updates when the parent scope differs from the task scope', async () => {
        const task = makeTask({ workId: 'work-1' });
        const parent = makeTask({ id: 'parent-1', workId: 'work-2' });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task).mockResolvedValueOnce(parent);

        await expect(
            service.update('user-1', task.id, { parentTaskId: parent.id }),
        ).rejects.toThrow(BadRequestException);
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('rejects parentTaskId updates when the parent is not owned by the user', async () => {
        const task = makeTask();
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task).mockResolvedValueOnce(null);

        await expect(
            service.update('user-1', task.id, { parentTaskId: 'other-user-task' }),
        ).rejects.toThrow(BadRequestException);
        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('updates parentTaskId only after the proposed parent is owned by the user', async () => {
        const task = makeTask();
        const parent = makeTask({ id: 'parent-1' });
        const refreshed = makeTask({ parentTaskId: parent.id });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser
            .mockResolvedValueOnce(task)
            .mockResolvedValueOnce(parent)
            .mockResolvedValueOnce(refreshed);

        await service.update('user-1', task.id, { parentTaskId: parent.id });

        expect(repos.tasks.wouldCreateCycle).toHaveBeenCalledWith(
            task.id,
            parent.id,
            'user-1',
            undefined,
        );
        expect(repos.tasks.updateById).toHaveBeenCalledWith(task.id, { parentTaskId: parent.id });
    });

    it('does not remove an assignee row unless it belongs to the task', async () => {
        const task = makeTask();
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
        repos.assignees.removeForTask.mockResolvedValueOnce(false);

        await expect(service.removeAssignee('user-1', task.id, 'assignee-row')).rejects.toThrow(
            NotFoundException,
        );
    });

    it('does not remove a blocker row unless it belongs to the task', async () => {
        const task = makeTask();
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
        repos.blocks.removeForTask.mockResolvedValueOnce(false);

        await expect(service.removeBlocker('user-1', task.id, 'block-row')).rejects.toThrow(
            NotFoundException,
        );
        expect(repos.transitions.recheckUnblockFor).not.toHaveBeenCalled();
    });

    it('does not remove an attachment row unless it belongs to the task', async () => {
        const task = makeTask({ workId: 'work-1' });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
        repos.attachments.removeForTask.mockResolvedValueOnce(false);

        await expect(service.removeAttachment('user-1', task.id, 'attachment-row')).rejects.toThrow(
            NotFoundException,
        );
    });

    it('requires Work scope before attaching a KB upload', async () => {
        const task = makeTask();
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);

        await expect(service.addAttachment('user-1', task.id, 'upload-1')).rejects.toThrow(
            BadRequestException,
        );
        expect(repos.workUploads.findById).not.toHaveBeenCalled();
    });

    it('rejects uploads that are not in the task Work', async () => {
        const task = makeTask({ workId: 'work-1' });
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
        repos.workUploads.findById.mockResolvedValueOnce(null);

        await expect(service.addAttachment('user-1', task.id, 'upload-1')).rejects.toThrow(
            BadRequestException,
        );
        expect(repos.attachments.add).not.toHaveBeenCalled();
    });

    it('attaches uploads only after they are found in the task Work', async () => {
        const task = makeTask({ workId: 'work-1' });
        const attachment = { id: 'attachment-1', taskId: task.id, uploadId: 'upload-1' };
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task);
        repos.workUploads.findById.mockResolvedValueOnce({ id: 'upload-1', workId: 'work-1' });
        repos.attachments.add.mockResolvedValueOnce(attachment);

        await expect(service.addAttachment('user-1', task.id, 'upload-1')).resolves.toEqual(
            attachment,
        );
        expect(repos.workUploads.findById).toHaveBeenCalledWith('work-1', 'upload-1');
    });
});
