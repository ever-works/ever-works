import { ForbiddenException } from '@nestjs/common';
import {
    TaskTransitionService,
    agentTransitionsNoFanOut,
    withAgentFanOutSuppressed,
} from '../task-transition.service';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';
import { AWAITING_OWNER_LABEL } from '../awaiting-owner';

/**
 * Works-security (2026-10-18) — finding 5: an AGENT's move never starts
 * another agent's work.
 *
 * The agent `transitionTask` tool (canAssignTasks) used to move any of the
 * owner's Tasks — `done → in_progress` included — and the move fanned out to
 * every agent assigned to it. `TaskTransitionService.transition` now adds
 * `suppressAgentFanOut` to every agent-driven move (switch
 * `AGENT_TRANSITIONS_NO_FANOUT`, default on), except a platform caller moving
 * the run's OWN Task to a status that dispatches nothing by itself.
 */

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
        requireAllApprovers: false,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('withAgentFanOutSuppressed (pure)', () => {
    const on = {} as NodeJS.ProcessEnv;

    it('suppresses the fan-out for every agent-driven move', () => {
        for (const to of Object.values(TaskStatus)) {
            expect(withAgentFanOutSuppressed({ actorType: 'agent' }, to, on).suppressAgentFanOut).toBe(true);
        }
    });

    it('keeps a run’s own lifecycle move (non-dispatching status) as it was', () => {
        for (const to of [TaskStatus.IN_REVIEW, TaskStatus.DONE, TaskStatus.BLOCKED]) {
            const opts = { actorType: 'agent' as const, ownRunTask: true };
            expect(withAgentFanOutSuppressed(opts, to, on)).toBe(opts);
        }
    });

    it('suppresses → in_progress even for the run’s own Task', () => {
        expect(
            withAgentFanOutSuppressed({ actorType: 'agent', ownRunTask: true }, TaskStatus.IN_PROGRESS, on)
                .suppressAgentFanOut,
        ).toBe(true);
    });

    it('leaves human / API moves untouched', () => {
        const opts = {};
        expect(withAgentFanOutSuppressed(opts, TaskStatus.IN_PROGRESS, on)).toBe(opts);
        const user = { actorType: 'user' as const };
        expect(withAgentFanOutSuppressed(user, TaskStatus.IN_PROGRESS, on)).toBe(user);
    });

    it('AGENT_TRANSITIONS_NO_FANOUT=false restores the previous behaviour', () => {
        const off = { AGENT_TRANSITIONS_NO_FANOUT: 'false' } as NodeJS.ProcessEnv;
        expect(agentTransitionsNoFanOut(off)).toBe(false);
        expect(agentTransitionsNoFanOut(on)).toBe(true);
        const opts = { actorType: 'agent' as const };
        expect(withAgentFanOutSuppressed(opts, TaskStatus.IN_PROGRESS, off)).toBe(opts);
    });
});

describe('TaskTransitionService — agent moves start no other agent', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let assignees: any;
    let runs: any;
    let dispatcher: any;
    let agents: any;
    const previous = process.env.AGENT_TRANSITIONS_NO_FANOUT;

    beforeEach(() => {
        delete process.env.AGENT_TRANSITIONS_NO_FANOUT;
        tasks = { casUpdateStatus: jest.fn().mockResolvedValue(true), findById: jest.fn() };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
        assignees = {
            findAgentAssignees: jest.fn().mockResolvedValue([{ assigneeType: 'agent', assigneeId: 'agent-b' }]),
        };
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string) => ({ id, userId })),
        };
    });
    afterAll(() => {
        if (previous === undefined) delete process.env.AGENT_TRANSITIONS_NO_FANOUT;
        else process.env.AGENT_TRANSITIONS_NO_FANOUT = previous;
    });

    function makeSvc(): TaskTransitionService {
        return new (TaskTransitionService as any)(
            tasks,
            blocks,
            approvers,
            assignees,
            runs,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            agents,
        ) as TaskTransitionService;
    }

    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it('an agent’s → in_progress moves the Task but dispatches nobody', async () => {
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        const moved = await makeSvc().transition(task, TaskStatus.IN_PROGRESS, { actorType: 'agent' });
        await flush();
        expect(moved.status).toBe(TaskStatus.IN_PROGRESS);
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
        expect(runs.createQueued).not.toHaveBeenCalled();
    });

    it('an agent re-opening a done Task (done → in_progress) dispatches nobody', async () => {
        const task = makeTask({ status: TaskStatus.DONE });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        await makeSvc().transition(task, TaskStatus.IN_PROGRESS, { actorType: 'agent', force: false });
        await flush();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('control: the owner’s own → in_progress still fans out', async () => {
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        await makeSvc().transition(task, TaskStatus.IN_PROGRESS);
        await flush();
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('with the switch off an agent’s move fans out as before', async () => {
        process.env.AGENT_TRANSITIONS_NO_FANOUT = 'false';
        const task = makeTask({ status: TaskStatus.TODO });
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
        await makeSvc().transition(task, TaskStatus.IN_PROGRESS, { actorType: 'agent' });
        await flush();
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('an agent’s → done carries the no-fan-out choice down the unblock cascade; the run’s own finish does not', async () => {
        const svc = makeSvc();
        const cascade = jest
            .spyOn(svc, 'autoUnblockResolvedTasks')
            .mockResolvedValue(undefined as never);
        const task = makeTask({ status: TaskStatus.IN_REVIEW });
        tasks.findById.mockResolvedValue({ ...task, status: TaskStatus.DONE });

        await svc.transition(task, TaskStatus.DONE, { actorType: 'agent' });
        expect(cascade).toHaveBeenLastCalledWith(
            't1',
            expect.objectContaining({ suppressAgentFanOut: true }),
        );

        await svc.transition(task, TaskStatus.DONE, { actorType: 'agent', ownRunTask: true });
        expect(cascade).toHaveBeenLastCalledWith(
            't1',
            expect.objectContaining({ suppressAgentFanOut: false }),
        );
    });

    it('the awaiting-owner hold (#2769) still refuses an agent move outright', async () => {
        const task = makeTask({ status: TaskStatus.TODO, labels: [AWAITING_OWNER_LABEL] });
        await expect(
            makeSvc().transition(task, TaskStatus.IN_PROGRESS, { actorType: 'agent', ownRunTask: true }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });
});
