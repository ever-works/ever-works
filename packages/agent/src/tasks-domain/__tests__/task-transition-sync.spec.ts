import { BadRequestException, ConflictException } from '@nestjs/common';
import { TASK_BOARD_TRANSITIONS } from '@ever-works/contracts';
import { TaskTransitionService, TASK_STATUS_TRANSITIONS } from '../task-transition.service';
import {
    shortestTransitionPath,
    TaskTransitionBlockedException,
    TaskTransitionConflictException,
} from '../task-transition-path';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * EW-P1-6 — sync transitions and re-open.
 *
 *   - `cancelled → backlog | todo` is legal for every caller;
 *   - `shortestTransitionPath` finds the shortest legal walk between any two
 *     statuses, deterministically;
 *   - `transitionSync` walks it one gated hop at a time, refuses up front with
 *     `409 transition_blocked` (blockers, pending approvers, attempted path)
 *     and starts no agent work.
 */

const ALL = Object.values(TaskStatus) as TaskStatus[];

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Mirror me',
        description: null,
        status: TaskStatus.BACKLOG,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: null,
        parentTaskId: null,
        createdByType: 'integration',
        createdById: 'key-1',
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

describe('cancelled re-opens (EW-P1-6)', () => {
    const svc = new TaskTransitionService({} as never, {} as never, {} as never);

    it('cancelled → backlog and → todo are legal; nothing else leaves cancelled', () => {
        expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.BACKLOG)).toBe(true);
        expect(svc.canTransition(TaskStatus.CANCELLED, TaskStatus.TODO)).toBe(true);
        for (const to of [
            TaskStatus.IN_PROGRESS,
            TaskStatus.IN_REVIEW,
            TaskStatus.DONE,
            TaskStatus.BLOCKED,
        ]) {
            expect(svc.canTransition(TaskStatus.CANCELLED, to)).toBe(false);
        }
    });

    it('the web board mirror equals the server lattice, re-open included', () => {
        for (const from of ALL) {
            expect([...TASK_BOARD_TRANSITIONS[from]].sort()).toEqual(
                [...TASK_STATUS_TRANSITIONS[from]].sort(),
            );
        }
    });
});

describe('shortestTransitionPath', () => {
    it('is empty for the same status and a single hop for a legal edge', () => {
        expect(
            shortestTransitionPath(TaskStatus.TODO, TaskStatus.TODO, TASK_STATUS_TRANSITIONS),
        ).toEqual([]);
        expect(
            shortestTransitionPath(
                TaskStatus.TODO,
                TaskStatus.IN_PROGRESS,
                TASK_STATUS_TRANSITIONS,
            ),
        ).toEqual([TaskStatus.IN_PROGRESS]);
    });

    it('walks backlog → done through todo and in_progress', () => {
        expect(
            shortestTransitionPath(TaskStatus.BACKLOG, TaskStatus.DONE, TASK_STATUS_TRANSITIONS),
        ).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE]);
    });

    it('re-opens through cancelled when that is the only way back (done → backlog)', () => {
        expect(
            shortestTransitionPath(TaskStatus.DONE, TaskStatus.BACKLOG, TASK_STATUS_TRANSITIONS),
        ).toEqual([TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED, TaskStatus.BACKLOG]);
        expect(
            shortestTransitionPath(TaskStatus.CANCELLED, TaskStatus.DONE, TASK_STATUS_TRANSITIONS),
        ).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE]);
    });

    it('reaches every status from every status, every hop legal, and is minimal (BFS distance)', () => {
        const distance = (from: TaskStatus, to: TaskStatus): number => {
            const seen = new Map<TaskStatus, number>([[from, 0]]);
            const queue = [from];
            while (queue.length) {
                const cur = queue.shift()!;
                for (const next of TASK_STATUS_TRANSITIONS[cur]) {
                    if (!seen.has(next)) {
                        seen.set(next, seen.get(cur)! + 1);
                        queue.push(next);
                    }
                }
            }
            return seen.get(to) ?? -1;
        };
        for (const from of ALL) {
            for (const to of ALL) {
                const path = shortestTransitionPath(from, to, TASK_STATUS_TRANSITIONS);
                expect(path).not.toBeNull();
                expect(path!.length).toBe(distance(from, to));
                let cursor = from;
                for (const hop of path!) {
                    expect(TASK_STATUS_TRANSITIONS[cursor]).toContain(hop);
                    cursor = hop;
                }
                expect(cursor).toBe(to);
            }
        }
    });

    it('answers null when the target is unreachable', () => {
        const closed = { ...TASK_STATUS_TRANSITIONS, [TaskStatus.CANCELLED]: [] } as Record<
            TaskStatus,
            readonly TaskStatus[]
        >;
        expect(shortestTransitionPath(TaskStatus.CANCELLED, TaskStatus.TODO, closed)).toBeNull();
    });
});

describe('TaskTransitionService.transitionSync', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let assignees: any;
    let dispatcher: any;
    let svc: TaskTransitionService;
    let row: Task;

    beforeEach(() => {
        row = makeTask();
        tasks = {
            casUpdateStatus: jest.fn(
                async (_id: string, from: TaskStatus, patch: Partial<Task>) => {
                    if (row.status !== from) return false;
                    row = { ...row, ...patch } as Task;
                    return true;
                },
            ),
            findById: jest.fn(async (id: string) => (id === row.id ? { ...row } : null)),
        };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = {
            allApproved: jest.fn().mockResolvedValue(true),
            findByTaskId: jest.fn().mockResolvedValue([]),
        };
        assignees = { findByTaskId: jest.fn().mockResolvedValue([]) };
        dispatcher = { dispatch: jest.fn() };
        svc = new TaskTransitionService(tasks, blocks, approvers, assignees, undefined, dispatcher);
    });

    it('walks backlog → done hop by hop and reports the path', async () => {
        const result = await svc.transitionSync(row, TaskStatus.DONE);
        expect(result.from).toBe(TaskStatus.BACKLOG);
        expect(result.path).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE]);
        expect(result.task.status).toBe(TaskStatus.DONE);
        expect(
            tasks.casUpdateStatus.mock.calls.map((call: unknown[]) => [
                call[1],
                (call[2] as Task).status,
            ]),
        ).toEqual([
            [TaskStatus.BACKLOG, TaskStatus.TODO],
            [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
            [TaskStatus.IN_PROGRESS, TaskStatus.DONE],
        ]);
        expect(result.task.startedAt).toBeInstanceOf(Date);
        expect(result.task.completedAt).toBeInstanceOf(Date);
    });

    it('starts no agent work on the way (D9): no assignee lookup for a fan-out', async () => {
        await svc.transitionSync(row, TaskStatus.IN_PROGRESS);
        await new Promise((resolve) => setImmediate(resolve));
        expect(assignees.findByTaskId).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('is a no-op when the Task is already there', async () => {
        const result = await svc.transitionSync(row, TaskStatus.BACKLOG);
        expect(result.path).toEqual([]);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it('re-opens a cancelled Task', async () => {
        row = makeTask({ status: TaskStatus.CANCELLED });
        const result = await svc.transitionSync(row, TaskStatus.TODO);
        expect(result.path).toEqual([TaskStatus.TODO]);
        expect(result.task.status).toBe(TaskStatus.TODO);
    });

    it('refuses up front with 409 transition_blocked when a blocker is open, and moves nothing', async () => {
        blocks.findByTaskId.mockResolvedValue([{ blockedByTaskId: 'b1' }]);
        const blocker = makeTask({
            id: 'b1',
            slug: 'T-9',
            title: 'Old spike',
            status: TaskStatus.TODO,
        });
        tasks.findById.mockImplementation(async (id: string) =>
            id === 'b1' ? blocker : id === row.id ? { ...row } : null,
        );

        const err = (await svc
            .transitionSync(row, TaskStatus.DONE)
            .catch((e) => e)) as TaskTransitionBlockedException;
        expect(err).toBeInstanceOf(TaskTransitionBlockedException);
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getStatus()).toBe(409);
        expect(err.getResponse()).toEqual({
            error: {
                code: 'transition_blocked',
                message: expect.stringContaining('open blocker'),
                details: {
                    from: TaskStatus.BACKLOG,
                    to: TaskStatus.DONE,
                    blockers: [
                        { taskId: 'b1', slug: 'T-9', title: 'Old spike', status: TaskStatus.TODO },
                    ],
                    pendingApprovers: [],
                    path: [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
                },
            },
        });
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it('refuses up front when approvers have not approved, listing them', async () => {
        row = makeTask({ status: TaskStatus.IN_REVIEW });
        approvers.allApproved.mockResolvedValue(false);
        approvers.findByTaskId.mockResolvedValue([
            { approverType: 'user', approverId: 'u-2', approvalState: 'pending' },
            { approverType: 'agent', approverId: 'a-1', approvalState: 'rejected' },
            { approverType: 'user', approverId: 'u-3', approvalState: 'approved' },
        ]);
        const err = (await svc
            .transitionSync(row, TaskStatus.DONE)
            .catch((e) => e)) as TaskTransitionBlockedException;
        expect(err).toBeInstanceOf(TaskTransitionBlockedException);
        expect(err.details.pendingApprovers).toEqual([
            { type: 'user', id: 'u-2', state: 'pending' },
            { type: 'agent', id: 'a-1', state: 'rejected' },
        ]);
        expect(err.details.path).toEqual([TaskStatus.DONE]);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it('force skips the approver gate but never the blocker gate', async () => {
        row = makeTask({ status: TaskStatus.IN_REVIEW });
        approvers.allApproved.mockResolvedValue(false);
        await expect(
            svc.transitionSync(row, TaskStatus.DONE, { force: true }),
        ).resolves.toMatchObject({
            path: [TaskStatus.DONE],
        });

        row = makeTask({ status: TaskStatus.IN_REVIEW });
        blocks.findByTaskId.mockResolvedValue([{ blockedByTaskId: 'b1' }]);
        tasks.findById.mockImplementation(async (id: string) =>
            id === 'b1' ? makeTask({ id: 'b1', status: TaskStatus.TODO }) : { ...row },
        );
        await expect(
            svc.transitionSync(row, TaskStatus.DONE, { force: true }),
        ).rejects.toBeInstanceOf(TaskTransitionBlockedException);
    });

    it('a gate that closes mid-walk still answers 409 with the path walked so far', async () => {
        // Pre-flight passes, then the blocker appears before the in_progress hop.
        let calls = 0;
        blocks.findByTaskId.mockImplementation(async () => {
            calls += 1;
            return calls >= 2 ? [{ blockedByTaskId: 'b1' }] : [];
        });
        tasks.findById.mockImplementation(async (id: string) =>
            id === 'b1' ? makeTask({ id: 'b1', status: TaskStatus.TODO }) : { ...row },
        );
        const err = (await svc
            .transitionSync(row, TaskStatus.IN_PROGRESS)
            .catch((e) => e)) as TaskTransitionBlockedException;
        expect(err).toBeInstanceOf(TaskTransitionBlockedException);
        expect(err.details.path).toEqual([TaskStatus.TODO, TaskStatus.IN_PROGRESS]);
        expect(row.status).toBe(TaskStatus.TODO);
    });

    it('reports every landed hop through onHop, in order, before the next hop', async () => {
        const hops: Array<[TaskStatus, TaskStatus]> = [];
        await svc.transitionSync(row, TaskStatus.DONE, {}, async (hop) => {
            hops.push([hop.from, hop.to]);
        });
        expect(hops).toEqual([
            [TaskStatus.BACKLOG, TaskStatus.TODO],
            [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
            [TaskStatus.IN_PROGRESS, TaskStatus.DONE],
        ]);
    });

    it('a sync entry into in_review records the current review key as not owed (no reviewer run later)', async () => {
        const agentReviews = {
            probeAgentReviewPlan: jest.fn().mockResolvedValue({
                enabled: true,
                headSha: 'abc',
                planKey: 'abc:fp',
                needsReview: 1,
                unclaimed: 1,
            }),
        };
        const reviewSvc = new TaskTransitionService(
            tasks,
            blocks,
            approvers,
            assignees,
            undefined,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            agentReviews as never,
        );
        row = makeTask({ status: TaskStatus.IN_PROGRESS });
        await reviewSvc.transitionSync(row, TaskStatus.IN_REVIEW);
        const patch = tasks.casUpdateStatus.mock.calls[0][2];
        expect(patch).toMatchObject({
            status: TaskStatus.IN_REVIEW,
            agentReviewPlanKey: 'abc:fp',
            agentReviewPlanState: 'refused',
            agentReviewPlanReason: 'sync-entry',
        });

        // An ordinary (non-sync) entry still clears the memory so the review is owed.
        tasks.casUpdateStatus.mockClear();
        row = makeTask({ status: TaskStatus.IN_PROGRESS });
        await reviewSvc.transition(row, TaskStatus.IN_REVIEW);
        const plain = tasks.casUpdateStatus.mock.calls[0][2];
        expect(plain.agentReviewPlanKey).toBeNull();
        expect(plain.agentReviewPlanState).toBeNull();
    });

    // Works-security lane 3a — a FLEET-RUN token's move sets only
    // `suppressAgentFanOut`: its `→ in_progress` starts no other Agent's run,
    // but the reviewer stage on `→ in_review` still happens.
    it('suppressAgentFanOut: no in_progress fan-out, but in_review still plans the reviewer', async () => {
        const fanOut = jest
            .spyOn(
                svc as unknown as { fanOutAgentExecutions: () => Promise<void> },
                'fanOutAgentExecutions',
            )
            .mockResolvedValue(undefined);
        row = makeTask({ status: TaskStatus.TODO });
        await svc.transition(row, TaskStatus.IN_PROGRESS, { suppressAgentFanOut: true });
        expect(fanOut).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();

        // Without the flag the same move fans out to the Task's agents.
        row = makeTask({ status: TaskStatus.TODO });
        await svc.transition(row, TaskStatus.IN_PROGRESS);
        expect(fanOut).toHaveBeenCalledTimes(1);

        const agentReviews = { probeAgentReviewPlan: jest.fn() };
        const reviewSvc = new TaskTransitionService(
            tasks,
            blocks,
            approvers,
            assignees,
            undefined,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            agentReviews as never,
        );
        const plan = jest
            .spyOn(
                reviewSvc as unknown as { planAgentReviewsDurably: () => Promise<void> },
                'planAgentReviewsDurably',
            )
            .mockResolvedValue(undefined);
        tasks.casUpdateStatus.mockClear();
        row = makeTask({ status: TaskStatus.IN_PROGRESS });
        await reviewSvc.transition(row, TaskStatus.IN_REVIEW, { suppressAgentFanOut: true });
        const patch = tasks.casUpdateStatus.mock.calls[0][2];
        // The review is OWED (memory cleared), never recorded as refused…
        expect(patch.agentReviewPlanKey).toBeNull();
        expect(patch.agentReviewPlanState).toBeNull();
        expect(agentReviews.probeAgentReviewPlan).not.toHaveBeenCalled();
        // …and the reviewer stage is planned right away.
        expect(plan).toHaveBeenCalledWith(
            expect.objectContaining({ status: TaskStatus.IN_REVIEW }),
            'entry',
        );
    });

    // Prompt-injection hardening (#2769) — a Task waiting for its owner (the
    // binding `awaiting-owner` label) starts no agent run on a machine's move
    // into in_progress (the auto-unblock restore, a mirror walk); a person's
    // own move starts it, clears the label and fans out as usual.
    it("awaiting-owner: a machine's in_progress move fans out nothing, a person's does", async () => {
        const fanOut = jest
            .spyOn(
                svc as unknown as { fanOutAgentExecutions: () => Promise<void> },
                'fanOutAgentExecutions',
            )
            .mockResolvedValue(undefined);
        const labels = ['inbound-email', 'awaiting-owner'];

        row = makeTask({ status: TaskStatus.TODO, labels });
        await svc.transition(row, TaskStatus.IN_PROGRESS, { automaticRestore: true });
        expect(fanOut).not.toHaveBeenCalled();
        expect(tasks.casUpdateStatus.mock.calls.at(-1)[2].labels).toBeUndefined();

        row = makeTask({ status: TaskStatus.TODO, labels });
        await svc.transition(row, TaskStatus.IN_PROGRESS);
        expect(fanOut).toHaveBeenCalledTimes(1);
        expect(tasks.casUpdateStatus.mock.calls.at(-1)[2].labels).toEqual(['inbound-email']);
    });

    // Works-security lane 3a (review round 2) — a fleet run's `suppressAgentFanOut`
    // survives a sync walk (no `suppressAgentDispatch` per hop, so the reviewer
    // is not recorded as refused) and the done/cancel cascade.
    // Verifier on #2769: the restore the auto-unblock cascade makes is the
    // PLATFORM's move — through the real cascade, an awaiting-owner Task keeps
    // its label and starts no agent run when its blocker resolves.
    it('awaiting-owner: the auto-unblock restore keeps the label and fans out nothing', async () => {
        const fanOut = jest
            .spyOn(
                svc as unknown as { fanOutAgentExecutions: () => Promise<void> },
                'fanOutAgentExecutions',
            )
            .mockResolvedValue(undefined);
        row = makeTask({
            status: TaskStatus.BLOCKED,
            previousStatus: TaskStatus.IN_PROGRESS,
            labels: ['inbound-email', 'awaiting-owner'],
        });
        blocks.findTasksBlockedBy = jest.fn().mockResolvedValue([row.id]);

        const result = await svc.autoUnblockResolvedTasks('blocker-1');

        expect(result.unblocked).toEqual([row.id]);
        expect(row.status).toBe(TaskStatus.IN_PROGRESS);
        expect(row.labels).toEqual(['inbound-email', 'awaiting-owner']);
        expect(tasks.casUpdateStatus.mock.calls.at(-1)[2].labels).toBeUndefined();
        expect(fanOut).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('suppressAgentFanOut survives a sync walk instead of becoming suppressAgentDispatch', async () => {
        const hop = jest.spyOn(svc, 'transition');
        row = makeTask({ status: TaskStatus.IN_PROGRESS });
        await svc.transitionSync(row, TaskStatus.IN_REVIEW, { suppressAgentFanOut: true });
        expect(hop).toHaveBeenCalledWith(
            expect.anything(),
            TaskStatus.IN_REVIEW,
            expect.objectContaining({ suppressAgentFanOut: true }),
        );
        expect(hop.mock.calls[0][2]).not.toHaveProperty('suppressAgentDispatch');
        // An ordinary sync walk (an integration) still suppresses all dispatch.
        hop.mockClear();
        row = makeTask({ status: TaskStatus.IN_PROGRESS });
        await svc.transitionSync(row, TaskStatus.IN_REVIEW);
        expect(hop.mock.calls[0][2]).toMatchObject({ suppressAgentDispatch: true });
    });

    it('carries suppressAgentFanOut through the done cascade into the dependent restore', async () => {
        const cascade = jest
            .spyOn(svc, 'autoUnblockResolvedTasks')
            .mockResolvedValue({ unblocked: [] });
        row = makeTask({ status: TaskStatus.IN_REVIEW });
        await svc.transition(row, TaskStatus.DONE, { suppressAgentFanOut: true });
        expect(cascade).toHaveBeenCalledWith(row.id, {
            suppressAgentDispatch: false,
            suppressAgentFanOut: true,
        });
        cascade.mockRestore();

        // The restore itself: a blocked dependent back to in_progress, no fan-out.
        const fanOut = jest
            .spyOn(
                svc as unknown as { fanOutAgentExecutions: () => Promise<void> },
                'fanOutAgentExecutions',
            )
            .mockResolvedValue(undefined);
        const dependent = makeTask({
            id: 'b1',
            status: TaskStatus.BLOCKED,
            previousStatus: TaskStatus.IN_PROGRESS,
        });
        row = dependent;
        blocks.findTasksBlockedBy = jest.fn().mockResolvedValue(['b1']);
        const result = await svc.autoUnblockResolvedTasks('a1', { suppressAgentFanOut: true });
        expect(result.unblocked).toEqual(['b1']);
        expect(row.status).toBe(TaskStatus.IN_PROGRESS);
        expect(fanOut).not.toHaveBeenCalled();
    });

    it('a lost race mid-walk answers 409 conflict with the path walked and the status found', async () => {
        // The first hop lands; before the second, someone else moves the Task.
        const realCas = tasks.casUpdateStatus.getMockImplementation();
        tasks.casUpdateStatus.mockImplementationOnce(realCas).mockImplementationOnce(async () => {
            row = { ...row, status: TaskStatus.CANCELLED } as Task;
            return false;
        });
        const err = (await svc
            .transitionSync(row, TaskStatus.IN_PROGRESS)
            .catch((e) => e)) as TaskTransitionConflictException;
        expect(err).toBeInstanceOf(TaskTransitionConflictException);
        expect(err.getStatus()).toBe(409);
        expect(err.getResponse()).toEqual({
            error: {
                code: 'conflict',
                message: expect.stringContaining('re-read'),
                details: {
                    from: TaskStatus.BACKLOG,
                    to: TaskStatus.IN_PROGRESS,
                    path: [TaskStatus.TODO, TaskStatus.IN_PROGRESS],
                    currentStatus: TaskStatus.CANCELLED,
                },
            },
        });
    });

    it('never walks on from a status another writer set between the CAS and the re-read (409 conflict)', async () => {
        // The first hop's CAS lands (backlog → todo); before transition() re-reads
        // the row, someone moves it to blocked. The walk must stop, not continue
        // blocked → in_progress → done over the other writer's choice.
        const realCas = tasks.casUpdateStatus.getMockImplementation();
        tasks.casUpdateStatus.mockImplementationOnce(async (...args: unknown[]) => {
            const won = await realCas(...args);
            row = { ...row, status: TaskStatus.BLOCKED } as Task;
            return won;
        });
        const err = (await svc
            .transitionSync(row, TaskStatus.DONE)
            .catch((e) => e)) as TaskTransitionConflictException;
        expect(err).toBeInstanceOf(TaskTransitionConflictException);
        expect(err.details).toEqual({
            from: TaskStatus.BACKLOG,
            to: TaskStatus.DONE,
            path: [TaskStatus.TODO],
            currentStatus: TaskStatus.BLOCKED,
        });
        expect(tasks.casUpdateStatus).toHaveBeenCalledTimes(1);
        expect(row.status).toBe(TaskStatus.BLOCKED);
    });

    it('answers 409 conflict, not success, when the Task moves right after the final hop', async () => {
        const realCas = tasks.casUpdateStatus.getMockImplementation();
        tasks.casUpdateStatus.mockImplementationOnce(async (...args: unknown[]) => {
            const won = await realCas(...args);
            row = { ...row, status: TaskStatus.CANCELLED } as Task;
            return won;
        });
        const err = (await svc
            .transitionSync(row, TaskStatus.TODO)
            .catch((e) => e)) as TaskTransitionConflictException;
        expect(err).toBeInstanceOf(TaskTransitionConflictException);
        expect(err.details).toEqual({
            from: TaskStatus.BACKLOG,
            to: TaskStatus.TODO,
            path: [TaskStatus.TODO],
            currentStatus: TaskStatus.CANCELLED,
        });
    });

    it('a refused hop whose Task did not move stays the ordinary 400', async () => {
        tasks.casUpdateStatus.mockResolvedValueOnce(false);
        await expect(svc.transitionSync(row, TaskStatus.TODO)).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    // Review of EW-P1-6 (Greptile P1): the no-dispatch choice rides the
    // auto-unblock cascade, so a dependent restored to `in_progress` because a
    // MIRRORED blocker resolved starts no agent run either.
    it('carries no-dispatch through the auto-unblock cascade of a sync move', async () => {
        const rows = new Map<string, Task>([
            ['t1', makeTask({ id: 't1', status: TaskStatus.IN_PROGRESS })],
            [
                'dep',
                makeTask({
                    id: 'dep',
                    status: TaskStatus.BLOCKED,
                    previousStatus: TaskStatus.IN_PROGRESS,
                    agentId: 'agent-1',
                } as Partial<Task>),
            ],
        ]);
        tasks.casUpdateStatus.mockImplementation(
            async (id: string, from: TaskStatus, patch: Partial<Task>) => {
                const cur = rows.get(id);
                if (!cur || cur.status !== from) return false;
                rows.set(id, { ...cur, ...patch } as Task);
                return true;
            },
        );
        tasks.findById.mockImplementation(async (id: string) =>
            rows.has(id) ? { ...rows.get(id)! } : null,
        );
        blocks.findTasksBlockedBy = jest.fn().mockResolvedValue(['dep']);
        // `dep`'s only blocker is `t1`, which is done by the time it is rechecked.
        blocks.findByTaskId.mockImplementation(async (id: string) =>
            id === 'dep' ? [{ blockedByTaskId: 't1' }] : [],
        );
        approvers.allApproved.mockResolvedValue(true);

        await svc.transitionSync(rows.get('t1')!, TaskStatus.DONE);
        for (let i = 0; i < 20 && rows.get('dep')!.status !== TaskStatus.IN_PROGRESS; i += 1) {
            await new Promise((resolve) => setImmediate(resolve));
        }

        expect(rows.get('dep')!.status).toBe(TaskStatus.IN_PROGRESS);
        await new Promise((resolve) => setImmediate(resolve));
        expect(assignees.findByTaskId).not.toHaveBeenCalled();
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    // EW-P1-6 + EW-P1-1 — every hop of a sync walk records its own
    // `task.transitioned`, inside that hop's transaction.
    it('records one task.transitioned per hop through the domain-event publisher', async () => {
        const manager = { tag: 'tx' };
        const publisher = {
            transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),
            changed: jest.fn().mockResolvedValue(2),
        };
        const recorded = new TaskTransitionService(
            tasks,
            blocks,
            approvers,
            assignees,
            undefined,
            dispatcher,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            publisher as never,
        );
        await recorded.transitionSync(row, TaskStatus.DONE);

        const hops = publisher.changed.mock.calls.map((call: unknown[]) => [
            call[3],
            (call[4] as { previous: { status: string } }).previous.status,
            (call[4] as { changedFields: string[] }).changedFields[0],
        ]);
        expect(hops).toEqual([
            ['task.transitioned', TaskStatus.BACKLOG, 'status'],
            ['task.transitioned', TaskStatus.TODO, 'status'],
            ['task.transitioned', TaskStatus.IN_PROGRESS, 'status'],
        ]);
        expect(publisher.changed.mock.calls.every((call: unknown[]) => call[0] === manager)).toBe(
            true,
        );
        expect(
            tasks.casUpdateStatus.mock.calls.every((call: unknown[]) => call[3] === manager),
        ).toBe(true);
    });
});
