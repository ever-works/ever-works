import { ForbiddenException } from '@nestjs/common';
import { TaskTransitionService } from '../task-transition.service';
import { TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV } from '../agent-block-lift';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * Works-security (2026-10-18) — an agent-driven move never lifts a block.
 *
 * A blocked Task waits for a person (a person blocked it, or the platform did:
 * a merge conflict, a refused App Work change). The `transitionTask` tool, a
 * run's finisher, the workspace finalize and a fleet run's token all move as
 * `actorType: 'agent'`; none of them may move the Task OUT of `blocked`. A
 * person's move, and the platform's auto-unblock restore, are unaffected.
 */
function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Ship the feature',
        description: null,
        status: TaskStatus.BLOCKED,
        previousStatus: TaskStatus.IN_PROGRESS,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: 'w1',
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: false,
        startedAt: new Date('2026-01-01'),
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('TaskTransitionService — an agent cannot lift a block (works-security)', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    const previousEnv = process.env[TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV];

    beforeEach(() => {
        delete process.env[TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV];
        tasks = {
            casUpdateStatus: jest.fn().mockResolvedValue(true),
            findById: jest.fn(),
        };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
    });

    afterAll(() => {
        if (previousEnv === undefined) delete process.env[TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV];
        else process.env[TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV] = previousEnv;
    });

    function makeSvc() {
        return new TaskTransitionService(tasks, blocks, approvers);
    }

    it.each([TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED])(
        'refuses an AGENT-driven blocked → %s before any write',
        async (to) => {
            await expect(
                makeSvc().transition(makeTask(), to, { actorType: 'agent' }),
            ).rejects.toThrow(ForbiddenException);
            expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
        },
    );

    it('refuses a fleet run token move (agent actor, fan-out suppressed) too', async () => {
        await expect(
            makeSvc().transition(makeTask(), TaskStatus.IN_PROGRESS, {
                actorType: 'agent',
                suppressAgentFanOut: true,
            }),
        ).rejects.toThrow(/cannot lift the block/);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it('lets a PERSON unblock it (no actorType)', async () => {
        tasks.findById.mockResolvedValueOnce({ ...makeTask(), status: TaskStatus.IN_PROGRESS });
        const row = await makeSvc().transition(makeTask(), TaskStatus.IN_PROGRESS);
        expect(row.status).toBe(TaskStatus.IN_PROGRESS);
        expect(tasks.casUpdateStatus).toHaveBeenCalledTimes(1);
    });

    it("leaves the platform's auto-unblock restore alone", async () => {
        tasks.findById.mockResolvedValueOnce({ ...makeTask(), status: TaskStatus.IN_PROGRESS });
        await makeSvc().transition(makeTask(), TaskStatus.IN_PROGRESS, { automaticRestore: true });
        expect(tasks.casUpdateStatus).toHaveBeenCalledTimes(1);
    });

    it('still lets an agent move an UNblocked Task into blocked', async () => {
        const task = makeTask({ status: TaskStatus.IN_PROGRESS, previousStatus: null });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.BLOCKED });
        await makeSvc().transition(task, TaskStatus.BLOCKED, { actorType: 'agent' });
        expect(tasks.casUpdateStatus).toHaveBeenCalledTimes(1);
    });

    it('TASK_AGENT_BLOCK_LIFT_ALLOWED=true restores the old behaviour', async () => {
        process.env[TASK_AGENT_BLOCK_LIFT_ALLOWED_ENV] = 'true';
        tasks.findById.mockResolvedValueOnce({ ...makeTask(), status: TaskStatus.IN_PROGRESS });
        await makeSvc().transition(makeTask(), TaskStatus.IN_PROGRESS, { actorType: 'agent' });
        expect(tasks.casUpdateStatus).toHaveBeenCalledTimes(1);
    });
});
