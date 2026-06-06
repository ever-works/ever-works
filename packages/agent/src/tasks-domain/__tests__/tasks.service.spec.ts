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
            create: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
            wouldCreateCycle: jest.fn().mockResolvedValue(false),
        },
        assignees: {
            removeForTask: jest.fn(),
        },
        reviewers: {},
        approvers: {},
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
        ...overrides,
    };

    const service = new TasksService(
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
        undefined,
        undefined,
        repos.workUploads as any,
        repos.works as any,
        repos.missions as any,
        repos.ideas as any,
    );

    return { service, repos };
}

describe('TasksService authorization guardrails', () => {
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
        repos.tasks.findByIdAndUser.mockResolvedValueOnce(task).mockResolvedValueOnce(parent);
        repos.tasks.findById.mockResolvedValueOnce(refreshed);

        await service.update('user-1', task.id, { parentTaskId: parent.id });

        expect(repos.tasks.wouldCreateCycle).toHaveBeenCalledWith(task.id, parent.id);
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
