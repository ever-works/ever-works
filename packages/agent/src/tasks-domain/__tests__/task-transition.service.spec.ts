import { BadRequestException, ConflictException } from '@nestjs/common';
import { TaskTransitionService } from '../task-transition.service';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Write the migration',
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
        createdById: 'u1',
        requireAllApprovers: true,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('TaskTransitionService', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let svc: TaskTransitionService;

    beforeEach(() => {
        tasks = {
            updateById: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn(),
        };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
        svc = new TaskTransitionService(tasks, blocks, approvers);
    });

    describe('canTransition (pure)', () => {
        it('backlog → todo allowed', () => {
            expect(svc.canTransition(TaskStatus.BACKLOG, TaskStatus.TODO)).toBe(true);
        });
        it('backlog → done disallowed', () => {
            expect(svc.canTransition(TaskStatus.BACKLOG, TaskStatus.DONE)).toBe(false);
        });
        it('cancelled is terminal', () => {
            expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.TODO)).toBe(false);
        });
        it('done → in_progress allows reopen', () => {
            expect(svc.canTransition(TaskStatus.DONE, TaskStatus.IN_PROGRESS)).toBe(true);
        });
    });

    describe('transition (with side-effects)', () => {
        it('rejects an illegal jump', async () => {
            await expect(
                svc.transition(makeTask({ status: TaskStatus.BACKLOG }), TaskStatus.DONE),
            ).rejects.toThrow(BadRequestException);
        });

        it('sets startedAt on first → in_progress', async () => {
            const task = makeTask({ status: TaskStatus.TODO, startedAt: null });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
            await svc.transition(task, TaskStatus.IN_PROGRESS);
            const patch = tasks.updateById.mock.calls[0][1];
            expect(patch.status).toBe(TaskStatus.IN_PROGRESS);
            expect(patch.startedAt).toBeInstanceOf(Date);
        });

        it('stashes previousStatus on → blocked', async () => {
            const task = makeTask({ status: TaskStatus.IN_PROGRESS });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.BLOCKED });
            await svc.transition(task, TaskStatus.BLOCKED);
            const patch = tasks.updateById.mock.calls[0][1];
            expect(patch.previousStatus).toBe(TaskStatus.IN_PROGRESS);
        });

        it('clears previousStatus when unblocking', async () => {
            const task = makeTask({
                status: TaskStatus.BLOCKED,
                previousStatus: TaskStatus.IN_PROGRESS,
            });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
            await svc.transition(task, TaskStatus.IN_PROGRESS);
            const patch = tasks.updateById.mock.calls[0][1];
            expect(patch.previousStatus).toBeNull();
        });

        it('refuses → done when an open blocker exists', async () => {
            const task = makeTask({ status: TaskStatus.IN_REVIEW });
            blocks.findByTaskId.mockResolvedValueOnce([{ blockedByTaskId: 'blocker' }]);
            tasks.findById.mockResolvedValueOnce({ id: 'blocker', status: TaskStatus.IN_PROGRESS });
            await expect(svc.transition(task, TaskStatus.DONE)).rejects.toThrow(ConflictException);
        });

        it('refuses → done when not all approvers are approved AND requireAllApprovers=true', async () => {
            const task = makeTask({ status: TaskStatus.IN_REVIEW, requireAllApprovers: true });
            approvers.allApproved.mockResolvedValueOnce(false);
            await expect(svc.transition(task, TaskStatus.DONE)).rejects.toThrow(ConflictException);
        });

        it('force=true overrides approver gate but NOT blocker gate', async () => {
            const task = makeTask({ status: TaskStatus.IN_REVIEW, requireAllApprovers: true });
            approvers.allApproved.mockResolvedValueOnce(false);
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.DONE });
            const result = await svc.transition(task, TaskStatus.DONE, { force: true });
            expect(result.status).toBe(TaskStatus.DONE);

            // Blocker gate still applies even with force=true.
            const task2 = makeTask({ status: TaskStatus.IN_REVIEW });
            blocks.findByTaskId.mockResolvedValueOnce([{ blockedByTaskId: 'blocker' }]);
            tasks.findById.mockResolvedValueOnce({ id: 'blocker', status: TaskStatus.TODO });
            await expect(svc.transition(task2, TaskStatus.DONE, { force: true })).rejects.toThrow(
                ConflictException,
            );
        });

        it('sets completedAt on → done', async () => {
            const task = makeTask({ status: TaskStatus.IN_REVIEW, requireAllApprovers: false });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.DONE });
            await svc.transition(task, TaskStatus.DONE, { force: true });
            const patch = tasks.updateById.mock.calls[0][1];
            expect(patch.completedAt).toBeInstanceOf(Date);
        });
    });
});
