import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TasksService } from '../tasks.service';
import { TaskPriority, TaskStatus, type Task } from '../../entities/task.entity';

/**
 * Tasks upgrades — the Subtasks checklist projection
 * (`TasksService.listSubtasks`) plus the `scheduledAt` path through the
 * generic PATCH (`update`).
 *
 * The projection is what the Task-detail checklist renders, so the
 * assertions are about the FACTS it derives — agent chips, the approval
 * badge under both approver policies, the n/m counters — and about the
 * batching contract that keeps it off an N+1.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: 'user-1',
        slug: 'T-1',
        title: 'Parent',
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
        recurrenceCron: null,
        recurrenceTimezone: 'UTC',
        nextOccurrenceAt: null,
        recurrenceEndsAt: null,
        recurrenceMaxOccurrences: null,
        recurrenceOccurredCount: 0,
        parentRecurringTaskId: null,
        scheduledAt: null,
        scheduleClaimedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    } as Task;
}

function makeService() {
    const repos = {
        tasks: {
            findByIdAndUser: jest.fn(),
            findById: jest.fn(),
            findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            create: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
            wouldCreateCycle: jest.fn().mockResolvedValue(false),
        },
        assignees: { findByTaskIds: jest.fn().mockResolvedValue([]) },
        reviewers: {},
        approvers: { findByTaskIds: jest.fn().mockResolvedValue([]) },
        blocks: {},
        relations: {},
        counter: { nextSlug: jest.fn().mockResolvedValue(1) },
        transitions: {},
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
    );
    return { service, repos };
}

describe('TasksService.listSubtasks', () => {
    it('404s when the parent is not the caller`s (no existence leak)', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(null);

        await expect(service.listSubtasks('user-1', 'foreign')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(repos.tasks.findByUserIdFiltered).not.toHaveBeenCalled();
    });

    it('lists children scoped to the parent and counts done rows', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findByUserIdFiltered.mockResolvedValue({
            rows: [
                makeTask({ id: 'c1', slug: 'T-2', title: 'Write spec', status: TaskStatus.DONE }),
                makeTask({ id: 'c2', slug: 'T-3', title: 'Implement' }),
            ],
            total: 2,
        });

        const out = await service.listSubtasks('user-1', 'task-1');

        expect(repos.tasks.findByUserIdFiltered).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({ parentTaskId: 'task-1' }),
        );
        expect(out.rows.map((row) => row.id)).toEqual(['c1', 'c2']);
        expect(out.total).toBe(2);
        expect(out.doneCount).toBe(1);
    });

    it('batches BOTH side tables into one lookup each (never N+1)', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findByUserIdFiltered.mockResolvedValue({
            rows: [makeTask({ id: 'c1' }), makeTask({ id: 'c2' }), makeTask({ id: 'c3' })],
            total: 3,
        });

        await service.listSubtasks('user-1', 'task-1');

        expect(repos.assignees.findByTaskIds).toHaveBeenCalledTimes(1);
        expect(repos.assignees.findByTaskIds).toHaveBeenCalledWith(['c1', 'c2', 'c3']);
        expect(repos.approvers.findByTaskIds).toHaveBeenCalledTimes(1);
        expect(repos.approvers.findByTaskIds).toHaveBeenCalledWith(['c1', 'c2', 'c3']);
    });

    it('splits assignees into agent chips vs user assignees, per row', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findByUserIdFiltered.mockResolvedValue({
            rows: [makeTask({ id: 'c1' }), makeTask({ id: 'c2' })],
            total: 2,
        });
        repos.assignees.findByTaskIds.mockResolvedValue([
            { taskId: 'c1', assigneeType: 'agent', assigneeId: 'agent-a' },
            { taskId: 'c1', assigneeType: 'user', assigneeId: 'user-9' },
            { taskId: 'c2', assigneeType: 'agent', assigneeId: 'agent-b' },
        ]);

        const out = await service.listSubtasks('user-1', 'task-1');

        expect(out.rows[0].agentAssigneeIds).toEqual(['agent-a']);
        expect(out.rows[0].userAssigneeIds).toEqual(['user-9']);
        expect(out.rows[1].agentAssigneeIds).toEqual(['agent-b']);
        expect(out.rows[1].userAssigneeIds).toEqual([]);
    });

    it('marks a row with approvers as gated and clears it only when ALL signed off (requireAllApprovers)', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findByUserIdFiltered.mockResolvedValue({
            rows: [makeTask({ id: 'c1', requireAllApprovers: true })],
            total: 1,
        });
        repos.approvers.findByTaskIds.mockResolvedValue([
            { taskId: 'c1', approvalState: 'approved' },
            { taskId: 'c1', approvalState: 'pending' },
        ]);

        const out = await service.listSubtasks('user-1', 'task-1');

        expect(out.rows[0].requiresApproval).toBe(true);
        expect(out.rows[0].approverCount).toBe(2);
        expect(out.rows[0].approvedCount).toBe(1);
        expect(out.rows[0].approvalCleared).toBe(false);
    });

    it('clears the gate on the first approval when requireAllApprovers is false', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findByUserIdFiltered.mockResolvedValue({
            rows: [makeTask({ id: 'c1', requireAllApprovers: false })],
            total: 1,
        });
        repos.approvers.findByTaskIds.mockResolvedValue([
            { taskId: 'c1', approvalState: 'approved' },
            { taskId: 'c1', approvalState: 'pending' },
        ]);

        const out = await service.listSubtasks('user-1', 'task-1');

        expect(out.rows[0].approvalCleared).toBe(true);
    });

    it('an ungated row reports requiresApproval=false and a cleared gate', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findByUserIdFiltered.mockResolvedValue({
            rows: [makeTask({ id: 'c1' })],
            total: 1,
        });

        const out = await service.listSubtasks('user-1', 'task-1');

        expect(out.rows[0].requiresApproval).toBe(false);
        expect(out.rows[0].approvalCleared).toBe(true);
        expect(out.rows[0].approverCount).toBe(0);
    });

    it('a side-table failure degrades to a plain checklist instead of failing the page', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        repos.tasks.findByUserIdFiltered.mockResolvedValue({
            rows: [makeTask({ id: 'c1' })],
            total: 1,
        });
        repos.assignees.findByTaskIds.mockRejectedValue(new Error('db down'));
        repos.approvers.findByTaskIds.mockRejectedValue(new Error('db down'));

        const out = await service.listSubtasks('user-1', 'task-1');

        expect(out.rows[0].agentAssigneeIds).toEqual([]);
        expect(out.rows[0].requiresApproval).toBe(false);
    });
});

describe('TasksService.update — scheduledAt', () => {
    const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
    const PAST = new Date(Date.now() - 60 * 60 * 1000);

    it('sets a future one-shot and clears any stale dispatcher claim', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask({ scheduleClaimedAt: new Date() }));
        repos.tasks.findById.mockResolvedValue(makeTask({ scheduledAt: FUTURE }));

        await service.update('user-1', 'task-1', { scheduledAt: FUTURE });

        expect(repos.tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({ scheduledAt: FUTURE, scheduleClaimedAt: null }),
        );
    });

    it('clears the schedule when passed null', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask({ scheduledAt: FUTURE }));
        repos.tasks.findById.mockResolvedValue(makeTask());

        await service.update('user-1', 'task-1', { scheduledAt: null });

        expect(repos.tasks.updateById).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({ scheduledAt: null, scheduleClaimedAt: null }),
        );
    });

    it('rejects a past instant and a recurring template, writing nothing', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask());
        await expect(
            service.update('user-1', 'task-1', { scheduledAt: PAST }),
        ).rejects.toBeInstanceOf(BadRequestException);

        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask({ isRecurring: true }));
        await expect(
            service.update('user-1', 'task-1', { scheduledAt: FUTURE }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(repos.tasks.updateById).not.toHaveBeenCalled();
    });

    it('leaves the schedule untouched when the field is absent', async () => {
        const { service, repos } = makeService();
        repos.tasks.findByIdAndUser.mockResolvedValue(makeTask({ scheduledAt: FUTURE }));
        repos.tasks.findById.mockResolvedValue(makeTask({ scheduledAt: FUTURE }));

        await service.update('user-1', 'task-1', { title: 'Renamed' });

        const patch = repos.tasks.updateById.mock.calls[0][1];
        expect(patch).not.toHaveProperty('scheduledAt');
        expect(patch).not.toHaveProperty('scheduleClaimedAt');
    });
});
