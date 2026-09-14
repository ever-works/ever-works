import { TaskTransitionService } from '../task-transition.service';
import { agentReviewRunScope, isAgentReviewRunScope } from '../task-agent-review';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * Reviewer agent stage (slice AD, EW-811) — the DISPATCH HOOK.
 *
 * `in_review` used to start nothing at all. These pin the three things
 * that make the hook safe:
 *
 *  1. It goes through `dispatchAgentRun` — THE dispatch path — so a
 *     review run meets the admission gate, the credits precheck and the
 *     kill switch like every other run, and this slice adds no
 *     `createQueued` call site of its own.
 *  2. The brief is seeded onto the run row BEFORE the job runtime is told
 *     about it. A review run that starts ahead of its diff is a reviewer
 *     with nothing to read.
 *  3. Nothing about the pre-existing `in_progress` fan-out changes.
 */

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Ship the thing',
        description: null,
        status: TaskStatus.IN_PROGRESS,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: 'w1',
        agentId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: false,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function harness(over: Partial<Record<string, any>> = {}) {
    const order: string[] = [];
    const reviewed = makeTask({ status: TaskStatus.IN_REVIEW });
    const tasks = {
        casUpdateStatus: jest.fn().mockResolvedValue(true),
        findById: jest.fn().mockResolvedValue(reviewed),
    };
    const blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
    const approvers = { allApproved: jest.fn().mockResolvedValue(true) };
    const assignees = { findAgentAssignees: jest.fn().mockResolvedValue([]) };
    const runs = {
        createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
        markDispatchFailed: jest.fn().mockResolvedValue(undefined),
        setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        seedResumeContext: jest.fn(async () => {
            order.push('seed');
        }),
    };
    const dispatcher = {
        enqueue: jest.fn(async () => {
            order.push('enqueue');
            return { runId: 'trd-1' };
        }),
    };
    const dispatchGate = { admit: jest.fn().mockResolvedValue({ admitted: true }) };
    const agents = {
        findByIdAndUser: jest.fn(async (id: string, userId: string) => ({ id, userId })),
    };
    const agentReviews = {
        planReviews: jest.fn(async () => ({
            taskId: 't1',
            headSha: 'abc123',
            decisions: [],
            dispatches: [
                {
                    reviewId: 'rev-1',
                    reviewerAgentId: 'reviewer-1',
                    approverId: 'app-1',
                    headSha: 'abc123',
                    brief: 'CODE REVIEW ASSIGNMENT — the diff goes here.',
                    dedupKey: 't1:reviewer-1:review:abc123',
                },
            ],
        })),
        recordDispatchResult: jest.fn(async () => undefined),
        bindRun: jest.fn(async () => undefined),
    };
    const parts = {
        tasks,
        blocks,
        approvers,
        assignees,
        runs,
        dispatcher,
        dispatchGate,
        agents,
        agentReviews,
        ...over,
    };
    const svc = new TaskTransitionService(
        parts.tasks as any,
        parts.blocks as any,
        parts.approvers as any,
        parts.assignees as any,
        parts.runs as any,
        parts.dispatcher as any,
        undefined,
        undefined,
        parts.dispatchGate as any,
        undefined,
        undefined,
        parts.agents as any,
        // Appended LAST — the positional-constructor rule. Everything
        // before it keeps its slot.
        parts.agentReviews as any,
    );
    return { svc, order, reviewed, ...(parts as any) };
}

/** The hook is fire-and-forget; let its microtasks settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('entering in_review dispatches the planned reviews', () => {
    it('starts one run per planned review, through dispatchAgentRun', async () => {
        const h = harness();
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();

        expect(h.agentReviews.planReviews).toHaveBeenCalledWith(h.reviewed);
        // THE dispatch path: the gate was consulted and a run row created.
        expect(h.dispatchGate.admit).toHaveBeenCalledTimes(1);
        expect(h.runs.createQueued).toHaveBeenCalledTimes(1);
        expect(h.dispatcher.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({
                agentId: 'reviewer-1',
                taskId: 't1',
                dedupKey: 't1:reviewer-1:review:abc123',
                runId: 'r1',
            }),
        );
        expect(h.agentReviews.recordDispatchResult).toHaveBeenCalledWith('rev-1', {
            runId: 'r1',
            dispatched: true,
            parked: false,
        });
    });

    it('seeds the brief BEFORE the enqueue — never after', async () => {
        const h = harness();
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();

        expect(h.runs.seedResumeContext).toHaveBeenCalledWith('r1', {
            pendingInput: ['CODE REVIEW ASSIGNMENT — the diff goes here.'],
        });
        // Ordering is the whole point: seeding after the enqueue races the
        // worker, and a review run that wins that race reviews nothing.
        expect(h.order).toEqual(['seed', 'enqueue']);
    });

    it('marks the run failed (and never enqueues) when the brief cannot be seeded', async () => {
        const h = harness();
        h.runs.seedResumeContext.mockRejectedValue(new Error('db down'));
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();

        expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
        expect(h.runs.markDispatchFailed).toHaveBeenCalledWith(
            'r1',
            expect.stringContaining('dispatch-failed'),
        );
        expect(h.agentReviews.recordDispatchResult).toHaveBeenCalledWith(
            'rev-1',
            expect.objectContaining({ dispatched: false, parked: false }),
        );
    });

    it('admits the review run with the ONE-tool review scope, snapshotted on its run row', async () => {
        // The finding: a review run used to be an ordinary run — full tool
        // surface, a workspace, finalize pushes — so a reviewer could author
        // commits the authorship evidence then ignored. The scope is what
        // the tool loop, the worker and the fleet dispatcher each read.
        const h = harness();
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();

        const created = h.runs.createQueued.mock.calls[0][0];
        expect(created.delegationScope).toEqual(agentReviewRunScope());
        expect(isAgentReviewRunScope(created.delegationScope)).toBe(true);
        expect(created).toMatchObject({ agentId: 'reviewer-1', taskId: 't1', triggerKind: 'task' });
    });

    it('binds the run to its review BEFORE the seed and the enqueue', async () => {
        // The finding: the run id was stamped on the ledger only AFTER the
        // enqueue, with errors swallowed — until it landed (or forever),
        // the reviewer's own review run counted as authorship and a fast
        // verdict was refused `self-review`.
        const h = harness();
        h.agentReviews.bindRun.mockImplementation(async () => {
            h.order.push('bind');
        });
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();

        expect(h.agentReviews.bindRun).toHaveBeenCalledWith('rev-1', 'r1');
        expect(h.order).toEqual(['bind', 'seed', 'enqueue']);
    });

    it('never enqueues a review run whose binding did not land — the run is rolled back', async () => {
        const h = harness();
        h.agentReviews.bindRun.mockRejectedValue(new Error('agent-review-binding-refused'));
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();

        expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
        expect(h.runs.seedResumeContext).not.toHaveBeenCalled();
        expect(h.runs.markDispatchFailed).toHaveBeenCalledWith(
            'r1',
            expect.stringContaining('agent-review-binding-refused'),
        );
        expect(h.agentReviews.recordDispatchResult).toHaveBeenCalledWith(
            'rev-1',
            expect.objectContaining({ dispatched: false, parked: false }),
        );
    });

    it('refuses a review dispatch that would produce no run row — nothing could carry the scope', async () => {
        const h = harness();
        h.dispatchGate.admit.mockResolvedValue({ admitted: true });
        const svc = new TaskTransitionService(
            h.tasks as any,
            h.blocks as any,
            h.approvers as any,
            h.assignees as any,
            undefined,
            h.dispatcher as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            h.agents as any,
            h.agentReviews as any,
        );
        const result = await svc.dispatchAgentRun(makeTask(), 'reviewer-1', {
            reviewId: 'rev-1',
            seedPendingInput: ['brief'],
            delegationScope: agentReviewRunScope(),
        });
        expect(result).toMatchObject({ dispatched: false, parked: false });
        expect(result.error).toContain('agent-review-binding-unavailable');
        expect(h.dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('does nothing when the plan has no dispatches', async () => {
        const h = harness();
        h.agentReviews.planReviews.mockResolvedValue({
            taskId: 't1',
            reason: 'no-agent-approvers',
            decisions: [],
            dispatches: [],
        });
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();
        expect(h.runs.createQueued).not.toHaveBeenCalled();
    });

    it('never lets a review failure roll back the status change', async () => {
        const h = harness();
        h.agentReviews.planReviews.mockRejectedValue(new Error('boom'));
        await expect(h.svc.transition(makeTask(), TaskStatus.IN_REVIEW)).resolves.toBe(h.reviewed);
        await settle();
    });

    it('is inert when the review service is unbound (the pre-slice behaviour)', async () => {
        const h = harness({ agentReviews: undefined });
        await h.svc.transition(makeTask(), TaskStatus.IN_REVIEW);
        await settle();
        expect(h.runs.createQueued).not.toHaveBeenCalled();
    });
});

describe('requestAgentReviews — a push while the Task sits in in_review', () => {
    it('re-plans and dispatches through the same bound, scoped path', async () => {
        const h = harness();
        await h.svc.requestAgentReviews(makeTask({ status: TaskStatus.IN_REVIEW }));

        expect(h.agentReviews.planReviews).toHaveBeenCalledTimes(1);
        expect(h.agentReviews.bindRun).toHaveBeenCalledWith('rev-1', 'r1');
        expect(h.runs.createQueued.mock.calls[0][0].delegationScope).toEqual(agentReviewRunScope());
        expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('does nothing for a Task that is not in review', async () => {
        const h = harness();
        await h.svc.requestAgentReviews(makeTask({ status: TaskStatus.IN_PROGRESS }));
        expect(h.agentReviews.planReviews).not.toHaveBeenCalled();
    });

    it('never throws into the status poll that calls it', async () => {
        const h = harness();
        h.agentReviews.planReviews.mockRejectedValue(new Error('boom'));
        await expect(
            h.svc.requestAgentReviews(makeTask({ status: TaskStatus.IN_REVIEW })),
        ).resolves.toBeUndefined();
    });
});

describe('the pre-existing paths are untouched', () => {
    it('does not plan reviews on any other transition', async () => {
        const h = harness();
        h.tasks.findById.mockResolvedValue(makeTask({ status: TaskStatus.BLOCKED }));
        await h.svc.transition(makeTask(), TaskStatus.BLOCKED);
        await settle();
        expect(h.agentReviews.planReviews).not.toHaveBeenCalled();
    });

    it('leaves an ordinary in_progress dispatch with NO seeded pending input', async () => {
        const h = harness();
        h.tasks.findById.mockResolvedValue(makeTask({ status: TaskStatus.IN_PROGRESS }));
        h.assignees.findAgentAssignees.mockResolvedValue([{ assigneeId: 'agent-1' }]);
        await h.svc.transition(makeTask({ status: TaskStatus.TODO }), TaskStatus.IN_PROGRESS);
        await settle();

        expect(h.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(h.runs.seedResumeContext).not.toHaveBeenCalled();
        expect(h.agentReviews.planReviews).not.toHaveBeenCalled();
        // …and no review scope, no binding: an implementer keeps its tools.
        expect(h.runs.createQueued.mock.calls[0][0].delegationScope).toBeNull();
        expect(h.agentReviews.bindRun).not.toHaveBeenCalled();
    });
});
