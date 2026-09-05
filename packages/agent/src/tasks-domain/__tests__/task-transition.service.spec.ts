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
            // transition() now lands the status change via an atomic CAS
            // (UPDATE … WHERE status=from). `true` = this caller won the race.
            casUpdateStatus: jest.fn().mockResolvedValue(true),
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
            const patch = tasks.casUpdateStatus.mock.calls[0][2];
            expect(patch.status).toBe(TaskStatus.IN_PROGRESS);
            expect(patch.startedAt).toBeInstanceOf(Date);
        });

        it('stashes previousStatus on → blocked', async () => {
            const task = makeTask({ status: TaskStatus.IN_PROGRESS });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.BLOCKED });
            await svc.transition(task, TaskStatus.BLOCKED);
            const patch = tasks.casUpdateStatus.mock.calls[0][2];
            expect(patch.previousStatus).toBe(TaskStatus.IN_PROGRESS);
        });

        it('clears previousStatus when unblocking', async () => {
            const task = makeTask({
                status: TaskStatus.BLOCKED,
                previousStatus: TaskStatus.IN_PROGRESS,
            });
            tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
            await svc.transition(task, TaskStatus.IN_PROGRESS);
            const patch = tasks.casUpdateStatus.mock.calls[0][2];
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
            const patch = tasks.casUpdateStatus.mock.calls[0][2];
            expect(patch.completedAt).toBeInstanceOf(Date);
        });
    });
});

/**
 * Slice AH made two internals public so the task-graph fan-out driver
 * asks the SAME questions the transition path asks. These cases pin that
 * shared behaviour — if the driver and the gate ever disagree about what
 * "open blocker" or "the agents of this Task" means, the fan-out starts
 * work the gate then refuses.
 */
describe('TaskTransitionService — the predicates the fan-out shares', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let assignees: any;
    let svc: TaskTransitionService;

    beforeEach(() => {
        tasks = { casUpdateStatus: jest.fn().mockResolvedValue(true), findById: jest.fn() };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
        assignees = { findAgentAssignees: jest.fn().mockResolvedValue([]) };
        svc = new TaskTransitionService(tasks, blocks, approvers, assignees);
    });

    describe('listOpenBlockerIds', () => {
        it('counts a blocker open until it is DONE or CANCELLED', async () => {
            blocks.findByTaskId.mockResolvedValue([
                { blockedByTaskId: 'b-todo' },
                { blockedByTaskId: 'b-progress' },
                { blockedByTaskId: 'b-done' },
                { blockedByTaskId: 'b-cancelled' },
            ]);
            tasks.findById.mockImplementation(
                async (id: string) =>
                    ({
                        'b-todo': { id, status: TaskStatus.TODO },
                        'b-progress': { id, status: TaskStatus.IN_PROGRESS },
                        'b-done': { id, status: TaskStatus.DONE },
                        'b-cancelled': { id, status: TaskStatus.CANCELLED },
                    })[id],
            );

            expect(await svc.listOpenBlockerIds('t1')).toEqual(['b-todo', 'b-progress']);
        });

        it('treats a vanished blocker as closed and no rows as unblocked', async () => {
            blocks.findByTaskId.mockResolvedValueOnce([{ blockedByTaskId: 'gone' }]);
            tasks.findById.mockResolvedValueOnce(null);
            expect(await svc.listOpenBlockerIds('t1')).toEqual([]);

            blocks.findByTaskId.mockResolvedValueOnce([]);
            expect(await svc.listOpenBlockerIds('t2')).toEqual([]);
        });

        it('is the SAME predicate the blocker gate enforces', async () => {
            const task = makeTask({ status: TaskStatus.TODO });
            blocks.findByTaskId.mockResolvedValue([{ blockedByTaskId: 'b1' }]);
            tasks.findById.mockResolvedValue({ id: 'b1', status: TaskStatus.IN_REVIEW });

            expect(await svc.listOpenBlockerIds(task.id)).toEqual(['b1']);
            await expect(svc.transition(task, TaskStatus.IN_PROGRESS)).rejects.toThrow(
                ConflictException,
            );
        });
    });

    describe('resolveDispatchAgentIds', () => {
        it('prefers agent assignee rows, one entry per agent', async () => {
            assignees.findAgentAssignees.mockResolvedValue([
                { assigneeId: 'a1' },
                { assigneeId: 'a2' },
            ]);
            expect(await svc.resolveDispatchAgentIds(makeTask({ agentId: 'owner' }))).toEqual([
                'a1',
                'a2',
            ]);
        });

        it("falls back to the Task's own agentId when there are no assignee rows", async () => {
            expect(await svc.resolveDispatchAgentIds(makeTask({ agentId: 'owner' }))).toEqual([
                'owner',
            ]);
        });

        it('returns nothing for a Task no agent is bound to', async () => {
            expect(await svc.resolveDispatchAgentIds(makeTask({ agentId: null }))).toEqual([]);
        });

        it('propagates a repository failure rather than reporting "no agent"', async () => {
            assignees.findAgentAssignees.mockRejectedValue(new Error('db down'));
            await expect(svc.resolveDispatchAgentIds(makeTask())).rejects.toThrow('db down');
        });
    });
});
