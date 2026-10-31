import { BadRequestException, ConflictException } from '@nestjs/common';
import { TaskTransitionService } from '../task-transition.service';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';
import { FLEET_SESSION_SCHEDULE_LABEL } from '../task-session-schedule.port';

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
        // EW-P1-6 — cancelled is no longer terminal: it re-opens into the
        // backlog or todo, and nowhere else.
        it('cancelled re-opens into backlog or todo only', () => {
            expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.TODO)).toBe(true);
            expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.BACKLOG)).toBe(true);
            expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.IN_PROGRESS)).toBe(false);
            expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.DONE)).toBe(false);
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

        describe("the binding 'awaiting-owner' label (untrusted email)", () => {
            it('refuses ANY agent-driven move of a Task carrying it', async () => {
                const task = makeTask({
                    status: TaskStatus.BACKLOG,
                    labels: ['inbound-email', 'awaiting-owner'],
                });
                await expect(
                    svc.transition(task, TaskStatus.IN_PROGRESS, { actorType: 'agent' }),
                ).rejects.toThrow(/waiting for its owner/);
                expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
            });

            it('a person starting it (todo / in_progress) clears the label in the same write', async () => {
                const task = makeTask({
                    status: TaskStatus.BACKLOG,
                    labels: ['inbound-email', 'awaiting-owner'],
                });
                tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.TODO });
                await svc.transition(task, TaskStatus.TODO);
                const patch = tasks.casUpdateStatus.mock.calls[0][2];
                expect(patch.labels).toEqual(['inbound-email']);
            });

            // Review of #2769 (after the develop merge): only a PERSON's own
            // move starts it. A machine's move into todo / in_progress keeps
            // the label and starts no agent run.
            it.each([
                ['a sync (mirror) walk hop', { suppressAgentDispatch: true }],
                ['a fan-out-suppressed move', { suppressAgentFanOut: true }],
                ['the auto-unblock restore', { automaticRestore: true }],
            ])('%s into in_progress keeps the label', async (_label, opts) => {
                const task = makeTask({
                    status: TaskStatus.TODO,
                    labels: ['inbound-email', 'awaiting-owner'],
                });
                tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_PROGRESS });
                await svc.transition(task, TaskStatus.IN_PROGRESS, opts);
                expect(tasks.casUpdateStatus.mock.calls[0][2].labels).toBeUndefined();
            });

            it('a person moving it elsewhere (cancelled) keeps the label', async () => {
                const task = makeTask({
                    status: TaskStatus.BACKLOG,
                    labels: ['awaiting-owner'],
                });
                tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.CANCELLED });
                await svc.transition(task, TaskStatus.CANCELLED);
                expect(tasks.casUpdateStatus.mock.calls[0][2].labels).toBeUndefined();
            });
        });

        it('force=true from an AGENT-driven move does NOT skip the approver gate', async () => {
            const task = makeTask({ status: TaskStatus.IN_REVIEW, requireAllApprovers: true });
            approvers.allApproved.mockResolvedValueOnce(false);
            await expect(
                svc.transition(task, TaskStatus.DONE, { force: true, actorType: 'agent' }),
            ).rejects.toThrow(ConflictException);
            expect(approvers.allApproved).toHaveBeenCalled();
            expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
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

/**
 * APW-08 T11 (FR-9, ACC-08-07 second half) — an Agent without commit permission cannot be
 * started on an App Work Task: the dispatch is refused with the FR-9 copy, before any run row
 * exists, and nothing is enqueued. Every other case dispatches exactly as before.
 */
describe('TaskTransitionService.dispatchAgentRun — FR-9 commit permission on an App Work (APW-08 T11)', () => {
    const KINDS: Record<string, string> = { 'w-app': 'app', 'w-site': 'directory' };
    const FR9 = "This agent can't commit, and changes to an app always go through a branch.";
    let runs: {
        createQueued: jest.Mock;
        markDispatchFailed: jest.Mock;
        setTriggerRunId: jest.Mock;
    };
    let dispatcher: { enqueue: jest.Mock };
    let works: { findById: jest.Mock };

    function makeSvc(
        permissions: Record<string, boolean> | undefined,
        extras: { agentReviews?: unknown; sessionSchedules?: unknown } = {},
    ): TaskTransitionService {
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        works = {
            findById: jest.fn(async (id: string) => (KINDS[id] ? { id, kind: KINDS[id] } : null)),
        };
        const agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string) => ({
                id,
                userId,
                ...(permissions ? { permissions } : {}),
            })),
        };
        return new (TaskTransitionService as unknown as new (
            ...args: unknown[]
        ) => TaskTransitionService)(
            { casUpdateStatus: jest.fn(), findById: jest.fn() },
            { findByTaskId: jest.fn().mockResolvedValue([]) },
            { allApproved: jest.fn().mockResolvedValue(true) },
            { findAgentAssignees: jest.fn().mockResolvedValue([]) },
            runs,
            dispatcher,
            undefined, // notifications
            undefined, // runDenorm
            undefined, // dispatchGate
            works,
            undefined, // terminalSessions
            agents,
            extras.agentReviews,
            undefined, // domainEvents
            extras.sessionSchedules,
        );
    }

    it('refuses an App Work Task whose Agent may not commit, with the FR-9 copy, and dispatches nothing', async () => {
        const result = await makeSvc({ canCommitToRepo: false }).dispatchAgentRun(
            makeTask({ workId: 'w-app' }),
            'agent-a',
        );

        expect(result).toMatchObject({ runId: null, dispatched: false, parked: false });
        expect(result.error).toBe(`no_commit_permission: ${FR9}`);
        expect(runs.createQueued).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('dispatches an App Work Task whose Agent may commit — with no Work read at all', async () => {
        const result = await makeSvc({ canCommitToRepo: true }).dispatchAgentRun(
            makeTask({ workId: 'w-app' }),
            'agent-a',
        );

        expect(result).toMatchObject({ dispatched: true });
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(works.findById).not.toHaveBeenCalled();
    });

    it('an Agent with no stored permissions is read the way the worker reads it (may commit)', async () => {
        await expect(
            makeSvc(undefined).dispatchAgentRun(makeTask({ workId: 'w-app' }), 'agent-a'),
        ).resolves.toMatchObject({ dispatched: true });
    });

    it('every other kind, and a Work-less Task, dispatch exactly as before with the same Agent', async () => {
        const svc = makeSvc({ canCommitToRepo: false });
        await expect(
            svc.dispatchAgentRun(makeTask({ workId: 'w-site' }), 'agent-a'),
        ).resolves.toMatchObject({ dispatched: true });
        await expect(
            svc.dispatchAgentRun(makeTask({ workId: null }), 'agent-a'),
        ).resolves.toMatchObject({ dispatched: true });
        // An unknown Work cannot be classified as an App Work: as before, it dispatches.
        await expect(
            svc.dispatchAgentRun(makeTask({ workId: 'w-gone' }), 'agent-a'),
        ).resolves.toMatchObject({ dispatched: true });
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(3);
    });

    it('a review run is not a change: it passes on an App Work with an Agent that may not commit', async () => {
        // A review run needs its review service to bind the run (review of #3036: without it the
        // dispatch failed for another reason and this case proved nothing).
        const agentReviews = { bindRun: jest.fn().mockResolvedValue(undefined) };
        const svc = makeSvc({ canCommitToRepo: false }, { agentReviews });
        const result = await svc.dispatchAgentRun(makeTask({ workId: 'w-app' }), 'agent-a', {
            reviewId: 'review-1',
        });

        expect(result).toMatchObject({ dispatched: true });
        expect(result.error ?? '').not.toContain('no_commit_permission');
        expect(agentReviews.bindRun).toHaveBeenCalledWith('review-1', 'r1');
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    });

    it('an Agent-session schedule on an App Work is refused the same way, before the session starts (review of #3036)', async () => {
        const sessionSchedules = { dispatch: jest.fn().mockResolvedValue({ dispatched: true }) };
        const svc = makeSvc({ canCommitToRepo: false }, { sessionSchedules });
        const result = await svc.dispatchAgentRun(
            makeTask({ workId: 'w-app', labels: [FLEET_SESSION_SCHEDULE_LABEL] }),
            'agent-a',
        );

        expect(result).toMatchObject({ dispatched: false, runId: null });
        expect(result.error).toContain(FR9);
        expect(sessionSchedules.dispatch).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    });

    // APW-08 T35 (FR-53, APW08-G15) — the run's own spend cap is stored on the run row at dispatch.
    it('stores a per-run budget cap on the run row; a non-positive or fractional one is no cap', async () => {
        const svc = makeSvc({ canCommitToRepo: true });
        await svc.dispatchAgentRun(makeTask({ workId: 'w-site' }), 'agent-a', {
            maxBudgetCents: 1500,
        });
        expect(runs.createQueued.mock.calls[0][0]).toMatchObject({ budgetCapCents: 1500 });
        for (const maxBudgetCents of [0, -5, 12.5]) {
            await svc.dispatchAgentRun(makeTask({ workId: 'w-site' }), 'agent-a', {
                maxBudgetCents,
            });
        }
        await svc.dispatchAgentRun(makeTask({ workId: 'w-site' }), 'agent-a');
        for (const [args] of runs.createQueued.mock.calls.slice(1)) {
            expect(args).not.toHaveProperty('budgetCapCents');
        }
    });

    it('an Agent-session schedule whose Agent may commit (or on another kind) still starts its session', async () => {
        const sessionSchedules = { dispatch: jest.fn().mockResolvedValue({ dispatched: true }) };
        await makeSvc({ canCommitToRepo: true }, { sessionSchedules }).dispatchAgentRun(
            makeTask({ workId: 'w-app', labels: [FLEET_SESSION_SCHEDULE_LABEL] }),
            'agent-a',
        );
        await makeSvc({ canCommitToRepo: false }, { sessionSchedules }).dispatchAgentRun(
            makeTask({ workId: 'w-site', labels: [FLEET_SESSION_SCHEDULE_LABEL] }),
            'agent-a',
        );
        expect(sessionSchedules.dispatch).toHaveBeenCalledTimes(2);
    });
});
