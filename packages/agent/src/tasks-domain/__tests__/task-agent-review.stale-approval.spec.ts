import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/database.config';
import { TaskAgentReview } from '../../entities/task-agent-review.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskAgentReviewRepository } from '../../database/repositories/task-agent-review.repository';
import { TaskApproverRepository } from '../../database/repositories/task-side.repositories';
import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { TaskTransitionService } from '../task-transition.service';
import { TaskPrStatusService } from '../task-pr-status.service';

/**
 * Reviewer agent stage — AN AGENT APPROVAL IS ABOUT ONE COMMIT
 * (Greptile P1-A on PR #2419).
 *
 * The finding: an agent approved pull request head A; the pull request
 * moved to head B while the Task stayed `in_review`. The planner only
 * considered PENDING agent approvers, so the agent was never asked about B,
 * and the `in_review → done` gate (`TaskApproverRepository.allApproved`)
 * checked `approvalState` alone, so the approval for A let the Task reach
 * `done` with B unreviewed.
 *
 * Pinned on a REAL better-sqlite3 schema with the REAL approver and review
 * repositories and the REAL transition, review and PR-status services;
 * only the git provider, the job runtime and the run table are doubles.
 *
 *  1. The gate — every path to `done` goes through
 *     `TaskTransitionService.transition`, the only caller of `allApproved`:
 *     a user/API transition, the run finisher, the agent `transitionTask`
 *     tool and the workspace finalize step all reach it through
 *     `TasksService.transition` or directly, and the merge completion
 *     (`TaskPrStatusService.completeOnMerge`) is driven for real below.
 *  2. The re-review — the head move resets the stale decision to `pending`
 *     and buys a review of B, and only B's verdict opens the gate again.
 */

const TASK_ID = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c90';
const REVIEWER = '8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e12';
const IMPLEMENTER = '0e1f2a3b-4c5d-4e6f-8a7b-8c9d0e1f2a34';
const HUMAN = '4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e76';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

/* eslint-disable @typescript-eslint/no-explicit-any */

async function openSchema(): Promise<DataSource> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        synchronize: true,
    });
    await dataSource.initialize();
    await dataSource.query('PRAGMA foreign_keys = OFF');
    return dataSource;
}

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: TASK_ID,
        slug: 'T-9',
        title: 'Guard the gate',
        userId: 'user-1',
        status: TaskStatus.IN_REVIEW,
        previousStatus: null,
        requireAllApprovers: true,
        workId: 'work-1',
        prNumber: 42,
        prUrl: 'https://example.invalid/pr/42',
        prState: 'open',
        prHeadSha: HEAD_A,
        ciHeadSha: HEAD_A,
        agentId: null,
        startedAt: new Date('2026-09-01'),
        recurrenceOccurredCount: 0,
        tenantId: null,
        organizationId: null,
        ...over,
    } as unknown as Task;
}

/** An in-memory `tasks` store with the CAS the transition uses. */
function taskStore(initial: Task) {
    const state = { task: initial };
    return {
        state,
        casUpdateStatus: jest.fn(async (_id: string, from: TaskStatus, patch: Partial<Task>) => {
            if (state.task.status !== from) return false;
            state.task = { ...state.task, ...patch } as Task;
            return true;
        }),
        findById: jest.fn(async () => ({ ...state.task }) as Task),
        findDuePrStatusSync: jest.fn(async () => [{ ...state.task } as Task]),
        updatePrStatusCache: jest.fn(async (_id: string, patch: Partial<Task>) => {
            state.task = { ...state.task, ...patch } as Task;
        }),
        recordCiHead: jest.fn(async (input: { headSha: string }) => {
            state.task = { ...state.task, ciHeadSha: input.headSha } as Task;
            return true;
        }),
        updateById: jest.fn(async (_id: string, patch: Partial<Task>) => {
            state.task = { ...state.task, ...patch } as Task;
        }),
    };
}

/**
 * The transition service the gate runs in, with the provider's view of the
 * pull request head behind `readLivePullRequestHead`.
 *
 * EXTENDED CONTRACT (review of the P1-A fix): the gate used to take the head
 * from the Task row alone, so these fixtures needed no provider. That was
 * wrong — the cached head lags a push to an open pull request until the next
 * poll, and an approval of the old commit opened the gate inside that window
 * — so the gate now reads the head live and requires the Task's record to
 * agree. By default the provider here agrees with whatever the Task row
 * records (the steady state every existing case below describes); pass
 * `liveHead` to model a push the poll has not seen, or a provider that cannot
 * answer.
 */
function transitionsFor(
    tasks: ReturnType<typeof taskStore>,
    approvers: TaskApproverRepository,
    liveHead?: () => Promise<string | null>,
) {
    const reader = {
        readLivePullRequestHead: jest.fn(
            liveHead ?? (async () => (tasks.state.task.prHeadSha as string | null) ?? null),
        ),
    };
    const service = new TaskTransitionService(
        tasks as any,
        { findByTaskId: jest.fn(async () => []) } as any,
        approvers,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        reader as any,
    );
    return Object.assign(service, { liveHeadReader: reader });
}

/** A decided agent approval, written the way the verdict path stamps one. */
async function agentApprovedAt(approvers: TaskApproverRepository, head: string | null) {
    const row = await approvers.add(TASK_ID, 'agent', REVIEWER);
    await approvers.setState(row.id, 'approved', TASK_ID, {
        decidedVia: head ? 'agent-review' : null,
        decidedByRunId: null,
        decidedHeadSha: head,
    });
    return row;
}

describe('the → done gate binds an agent approval to the CURRENT head — real schema (Greptile P1-A)', () => {
    let dataSource: DataSource;
    let approvers: TaskApproverRepository;

    beforeEach(async () => {
        dataSource = await openSchema();
        approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('REFUSES done when the only agent approval is for a head the pull request has left', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        const tasks = taskStore(makeTask({ prHeadSha: HEAD_B, ciHeadSha: HEAD_B }));
        await expect(
            transitionsFor(tasks, approvers).transition(tasks.state.task, TaskStatus.DONE),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
        expect(tasks.state.task.status).toBe(TaskStatus.IN_REVIEW);
    });

    it('control: the same approval opens the gate while the pull request is still at that head', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        const tasks = taskStore(makeTask());
        const done = await transitionsFor(tasks, approvers).transition(
            tasks.state.task,
            TaskStatus.DONE,
        );
        expect(done.status).toBe(TaskStatus.DONE);
    });

    it('fails CLOSED when the current head is unknown or the two head records disagree', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        for (const heads of [
            { prHeadSha: null, ciHeadSha: null },
            { prHeadSha: null, ciHeadSha: HEAD_A },
            // A check delivery has seen a push the poll has not.
            { prHeadSha: HEAD_A, ciHeadSha: HEAD_B },
            { prHeadSha: 'not-a-sha', ciHeadSha: HEAD_A },
        ]) {
            const tasks = taskStore(makeTask(heads as Partial<Task>));
            await expect(
                transitionsFor(tasks, approvers).transition(tasks.state.task, TaskStatus.DONE),
            ).rejects.toBeInstanceOf(ConflictException);
        }
    });

    it('does not count an agent approval that names no commit at all', async () => {
        await agentApprovedAt(approvers, null);
        const tasks = taskStore(makeTask());
        await expect(
            transitionsFor(tasks, approvers).transition(tasks.state.task, TaskStatus.DONE),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('REFUSES done inside the push window — the Task row still names A, the pull request is already at B', async () => {
        // Review of the P1-A fix, both adversarial reviewers: a push to an
        // open pull request writes no head (`recordRemotePush` leaves it to
        // the provider), so until the next poll `prHeadSha` and `ciHeadSha`
        // both still say A. The slice AC fix loop's run pushes B and calls
        // `transitionTask('done')` in exactly that window; a human can click
        // done in it too. The gate bound the approval for A to the CACHED A
        // and let the Task through with B unreviewed.
        await agentApprovedAt(approvers, HEAD_A);
        const tasks = taskStore(makeTask({ prHeadSha: HEAD_A, ciHeadSha: HEAD_A }));
        const transitions = transitionsFor(tasks, approvers, async () => HEAD_B);
        await expect(
            transitions.transition(tasks.state.task, TaskStatus.DONE),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(transitions.liveHeadReader.readLivePullRequestHead).toHaveBeenCalledTimes(1);
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
        expect(tasks.state.task.status).toBe(TaskStatus.IN_REVIEW);
    });

    it('fails CLOSED when the live head cannot be read — a provider that does not answer, or throws', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        for (const liveHead of [
            async () => null,
            async () => 'not-a-sha',
            async () => {
                throw new Error('provider down');
            },
        ]) {
            const tasks = taskStore(makeTask());
            await expect(
                transitionsFor(tasks, approvers, liveHead).transition(
                    tasks.state.task,
                    TaskStatus.DONE,
                ),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(tasks.state.task.status).toBe(TaskStatus.IN_REVIEW);
        }
        // …and with no service able to read the provider at all.
        const tasks = taskStore(makeTask());
        const unwired = new TaskTransitionService(
            tasks as any,
            { findByTaskId: jest.fn(async () => []) } as any,
            approvers,
        );
        await expect(unwired.transition(tasks.state.task, TaskStatus.DONE)).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('does not let a lagging provider read vouch for a head the platform has already seen move on', async () => {
        // The poll (or a check delivery) recorded B; the provider replica
        // this read hit still says A. The approval for A must not count.
        await agentApprovedAt(approvers, HEAD_A);
        const tasks = taskStore(makeTask({ prHeadSha: HEAD_B, ciHeadSha: HEAD_B }));
        await expect(
            transitionsFor(tasks, approvers, async () => HEAD_A).transition(
                tasks.state.task,
                TaskStatus.DONE,
            ),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('costs NO provider read for a Task gated by people alone, or one refused anyway', async () => {
        const human = await approvers.add(TASK_ID, 'user', HUMAN);
        await approvers.setState(human.id, 'approved', TASK_ID);
        const tasks = taskStore(makeTask());
        const transitions = transitionsFor(tasks, approvers);
        expect((await transitions.transition(tasks.state.task, TaskStatus.DONE)).status).toBe(
            TaskStatus.DONE,
        );
        expect(transitions.liveHeadReader.readLivePullRequestHead).not.toHaveBeenCalled();

        // A pending agent approver: refused before any head matters.
        await approvers.add(TASK_ID, 'agent', REVIEWER);
        const pendingTasks = taskStore(makeTask());
        const refusing = transitionsFor(pendingTasks, approvers);
        await expect(
            refusing.transition(pendingTasks.state.task, TaskStatus.DONE),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(refusing.liveHeadReader.readLivePullRequestHead).not.toHaveBeenCalled();
    });

    it('leaves a USER approver exactly as it was — approved counts, with or without a known head', async () => {
        const human = await approvers.add(TASK_ID, 'user', HUMAN);
        await approvers.setState(human.id, 'approved', TASK_ID);
        for (const heads of [{}, { prHeadSha: null, ciHeadSha: null }]) {
            const tasks = taskStore(makeTask(heads as Partial<Task>));
            const done = await transitionsFor(tasks, approvers).transition(
                tasks.state.task,
                TaskStatus.DONE,
            );
            expect(done.status).toBe(TaskStatus.DONE);
        }
        // …and a pending human still holds the gate shut, as before.
        await approvers.setState(human.id, 'pending', TASK_ID);
        const tasks = taskStore(makeTask());
        await expect(
            transitionsFor(tasks, approvers).transition(tasks.state.task, TaskStatus.DONE),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('`force` still overrides the approver gate, unchanged', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        const tasks = taskStore(makeTask({ prHeadSha: HEAD_B, ciHeadSha: HEAD_B }));
        const done = await transitionsFor(tasks, approvers).transition(
            tasks.state.task,
            TaskStatus.DONE,
            { force: true },
        );
        expect(done.status).toBe(TaskStatus.DONE);
    });

    it('the MERGE completion path is gated the same way — a PR merged at B does not complete on an approval for A', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        for (const [mergedHead, expected] of [
            [HEAD_B, TaskStatus.IN_REVIEW],
            [HEAD_A, TaskStatus.DONE],
        ] as const) {
            const tasks = taskStore(makeTask());
            const transitions = transitionsFor(tasks, approvers);
            const prStatus = new TaskPrStatusService(
                tasks as any,
                {
                    findById: jest.fn(async () => ({
                        id: 'work-1',
                        gitProvider: 'github',
                        getRepoOwner: () => 'ever-works',
                        getDataRepo: () => 'ever-works',
                    })),
                } as any,
                {
                    getPullRequestStatus: jest.fn(async () => ({
                        number: 42,
                        state: 'merged',
                        merged: true,
                        headSha: mergedHead,
                        ciState: 'passing',
                        checks: [],
                    })),
                } as any,
                transitions,
            );
            const summary = await prStatus.syncDuePrStatuses();
            expect(summary.merged).toBe(1);
            expect(tasks.state.task.status).toBe(expected);
        }
    });

    it('the MERGE completion is bound to the merged head even when the CI-head compare-and-set lost in the same poll', async () => {
        // Review of the P1-A fix: `refreshTask` updates the in-memory
        // `ciHeadSha` only when its compare-and-set lands. A check delivery
        // that wrote the head first makes it lose, leaving `prHeadSha` = B
        // (from the provider) and `ciHeadSha` = A (stale) on the Task handed to
        // `completeOnMerge`. The gate read that disagreement as "head unknown"
        // and refused — and a merged pull request is never polled again, so
        // the Task stayed in review for good.
        await agentApprovedAt(approvers, HEAD_B);
        const tasks = taskStore(makeTask({ prHeadSha: HEAD_A, ciHeadSha: HEAD_A }));
        tasks.recordCiHead.mockImplementation(async () => false);
        const transitions = transitionsFor(tasks, approvers, async () => {
            throw new Error('the merge path must not need a second provider read');
        });
        const prStatus = new TaskPrStatusService(
            tasks as any,
            {
                findById: jest.fn(async () => ({
                    id: 'work-1',
                    gitProvider: 'github',
                    getRepoOwner: () => 'ever-works',
                    getDataRepo: () => 'ever-works',
                })),
            } as any,
            {
                getPullRequestStatus: jest.fn(async () => ({
                    number: 42,
                    state: 'merged',
                    merged: true,
                    headSha: HEAD_B,
                    ciState: 'passing',
                    checks: [],
                })),
            } as any,
            transitions,
        );
        const summary = await prStatus.syncDuePrStatuses();
        expect(summary).toMatchObject({ merged: 1, completed: 1 });
        expect(tasks.state.task.status).toBe(TaskStatus.DONE);
        expect(transitions.liveHeadReader.readLivePullRequestHead).not.toHaveBeenCalled();
    });
});

describe('the → done gate reads the head LIVE through the real review service (review of the P1-A fix)', () => {
    let dataSource: DataSource;
    let approvers: TaskApproverRepository;

    beforeEach(async () => {
        dataSource = await openSchema();
        approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    function wired(tasks: ReturnType<typeof taskStore>, getPullRequestStatus: jest.Mock) {
        const reviewService = new TaskAgentReviewService(
            tasks as any,
            new TaskAgentReviewRepository(dataSource.getRepository(TaskAgentReview)),
            approvers,
            {
                findById: jest.fn(async () => ({
                    id: 'work-1',
                    gitProvider: 'github',
                    getRepoOwner: () => 'ever-works',
                    getDataRepo: () => 'ever-works',
                })),
            } as any,
            undefined,
            undefined,
            undefined,
            { getPullRequestStatus, getCompareDiff: jest.fn() } as any,
        );
        return new TaskTransitionService(
            tasks as any,
            { findByTaskId: jest.fn(async () => []) } as any,
            approvers,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            reviewService,
        );
    }

    const prAt = (headSha: string | null) =>
        jest.fn(async () => ({
            number: 42,
            state: 'open',
            merged: false,
            headSha,
            ciState: 'passing',
            checks: [],
        }));

    it('the finisher’s done inside the push window is refused: cache A, provider B, approval for A', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        const tasks = taskStore(makeTask({ prHeadSha: HEAD_A, ciHeadSha: HEAD_A }));
        const getPullRequestStatus = prAt(HEAD_B);
        await expect(
            wired(tasks, getPullRequestStatus).transition(tasks.state.task, TaskStatus.DONE, {
                actorType: 'agent',
            }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(getPullRequestStatus).toHaveBeenCalledWith('ever-works', 'ever-works', 42, {
            userId: 'user-1',
            providerId: 'github',
            workId: 'work-1',
        });
        expect(tasks.state.task.status).toBe(TaskStatus.IN_REVIEW);
    });

    it('control: provider and Task both at A — the approval for A opens the gate', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        const tasks = taskStore(makeTask());
        const done = await wired(tasks, prAt(HEAD_A)).transition(tasks.state.task, TaskStatus.DONE);
        expect(done.status).toBe(TaskStatus.DONE);
    });

    it('a provider that throws or reports no head refuses — never a fallback to the cache', async () => {
        await agentApprovedAt(approvers, HEAD_A);
        for (const getPullRequestStatus of [
            jest.fn(async () => {
                throw new Error('rate limited');
            }),
            prAt(null),
            jest.fn(async () => null),
        ]) {
            const tasks = taskStore(makeTask());
            await expect(
                wired(tasks, getPullRequestStatus).transition(tasks.state.task, TaskStatus.DONE),
            ).rejects.toBeInstanceOf(ConflictException);
        }
    });
});

describe('a head move while in review gets the new head reviewed — real schema (Greptile P1-A)', () => {
    let dataSource: DataSource;

    beforeEach(async () => {
        dataSource = await openSchema();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('resets the approval for A to pending, reviews B, and only B’s verdict opens the gate', async () => {
        const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
        const reviews = new TaskAgentReviewRepository(dataSource.getRepository(TaskAgentReview));
        const approverRow = await agentApprovedAt(approvers, HEAD_A);

        // The pull request is now at B, and the poll has recorded it.
        const liveHead = HEAD_B;
        const tasks = taskStore(makeTask({ prHeadSha: HEAD_B, ciHeadSha: HEAD_B }));

        const runRows: Array<{
            id: string;
            agentId: string;
            taskId: string;
            delegationScope: unknown;
        }> = [{ id: 'run-impl', agentId: IMPLEMENTER, taskId: TASK_ID, delegationScope: null }];
        const runs = {
            createQueued: jest.fn(async (input: any) => {
                const row = {
                    id: `00000000-0000-4000-8000-${String(runRows.length).padStart(12, '0')}`,
                    agentId: input.agentId,
                    taskId: input.taskId,
                    delegationScope: input.delegationScope ?? null,
                };
                runRows.push(row);
                return row;
            }),
            seedResumeContext: jest.fn(async () => undefined),
            setTriggerRunId: jest.fn(async () => undefined),
            markDispatchFailed: jest.fn(async () => undefined),
            findById: jest.fn(async (id: string) => runRows.find((row) => row.id === id) ?? null),
            findByIds: jest.fn(async (ids: string[]) =>
                runRows.filter((row) => ids.includes(row.id)),
            ),
            findAuthorAgentIdsForTask: jest.fn(async (_taskId: string, exclude: string[] = []) => [
                ...new Set(
                    runRows.filter((row) => !exclude.includes(row.id)).map((row) => row.agentId),
                ),
            ]),
        };
        const reviewService = new TaskAgentReviewService(
            tasks as any,
            reviews,
            approvers,
            {
                findById: jest.fn(async () => ({
                    id: 'work-1',
                    gitProvider: 'github',
                    getRepoOwner: () => 'ever-works',
                    getDataRepo: () => 'ever-works',
                })),
            } as any,
            { findAgentAssignees: jest.fn(async () => []) } as any,
            runs as any,
            {
                findById: jest.fn(async (id: string) => ({ id, userId: 'user-1', slug: id })),
            } as any,
            {
                getPullRequestStatus: jest.fn(async () => ({
                    number: 42,
                    state: 'open',
                    merged: false,
                    headSha: liveHead,
                    baseRef: 'main',
                    ciState: 'passing',
                    checks: [],
                    checksComplete: true,
                })),
                getCompareDiff: jest.fn(async () => ({
                    files: [
                        {
                            path: 'src/b.ts',
                            status: 'modified',
                            additions: 1,
                            deletions: 1,
                            patch: '@@ -1 +1 @@\n-a\n+b\n',
                        },
                    ],
                    truncated: false,
                    totalFiles: 1,
                    totalAdditions: 1,
                    totalDeletions: 1,
                    patchBytes: 20,
                })),
            } as any,
        );
        const dispatcher = {
            enqueue: jest.fn(async (payload: { runId?: string }) => ({
                runId: `trigger-${payload.runId}`,
            })),
        };
        const transitions = new TaskTransitionService(
            tasks as any,
            { findByTaskId: jest.fn(async () => []) } as any,
            approvers,
            { findAgentAssignees: jest.fn(async () => []) } as any,
            runs as any,
            dispatcher as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                findByIdAndUser: jest.fn(async (id: string, userId: string) => ({ id, userId })),
            } as any,
            reviewService,
        );

        // Before anything re-plans: the approval for A does NOT pass at B.
        await expect(
            transitions.transition(tasks.state.task, TaskStatus.DONE),
        ).rejects.toBeInstanceOf(ConflictException);

        // The PR-status poll's head-change hook.
        await transitions.requestAgentReviews(tasks.state.task);

        // The stale decision went back to pending — provenance cleared…
        expect(
            await dataSource
                .getRepository(TaskApprover)
                .findOneOrFail({ where: { id: approverRow.id } }),
        ).toMatchObject({
            approvalState: 'pending',
            decidedVia: null,
            decidedHeadSha: null,
        });
        // …and B was claimed and dispatched to the same reviewer, once.
        const ledger = await reviews.listForTask(TASK_ID);
        expect(ledger.map((row) => [row.reviewerAgentId, row.headSha, row.state])).toEqual([
            [REVIEWER, HEAD_B, 'dispatched'],
        ]);
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        await expect(
            transitions.transition(tasks.state.task, TaskStatus.DONE),
        ).rejects.toBeInstanceOf(ConflictException);

        // A second poll at B buys nothing more.
        await transitions.requestAgentReviews(tasks.state.task);
        expect(await reviews.listForTask(TASK_ID)).toHaveLength(1);
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);

        // The review run for B answers.
        const reviewRunId = ledger[0].runId as string;
        expect(reviewRunId).toBeTruthy();
        expect(
            await reviewService.submitVerdict({
                runId: reviewRunId,
                reviewerAgentId: REVIEWER,
                verdict: 'approve',
            }),
        ).toMatchObject({ reason: 'recorded', headSha: HEAD_B });

        // Only now does the gate open — at B.
        const done = await transitions.transition(tasks.state.task, TaskStatus.DONE);
        expect(done.status).toBe(TaskStatus.DONE);
    });
});

describe('a verdict the ledger already holds for the live head is never stranded — real schema (review of the P1-A fix)', () => {
    let dataSource: DataSource;
    let previousMaxRuns: string | undefined;

    beforeEach(async () => {
        previousMaxRuns = process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        dataSource = await openSchema();
    });

    afterEach(async () => {
        if (previousMaxRuns === undefined) delete process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        else process.env.TASK_AGENT_REVIEW_MAX_RUNS = previousMaxRuns;
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    /**
     * The whole stage on a real schema, with ONE provider whose head the test
     * moves — the poll's view (`prHeadSha` / `ciHeadSha`) is moved with it,
     * the way `TaskPrStatusService.refreshTask` would record it.
     */
    function world() {
        const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
        const reviews = new TaskAgentReviewRepository(dataSource.getRepository(TaskAgentReview));
        const provider = { head: HEAD_A };
        const tasks = taskStore(makeTask());
        const runRows: Array<{
            id: string;
            agentId: string;
            taskId: string;
            delegationScope: unknown;
        }> = [{ id: 'run-impl', agentId: IMPLEMENTER, taskId: TASK_ID, delegationScope: null }];
        const runs = {
            createQueued: jest.fn(async (input: any) => {
                const row = {
                    id: `00000000-0000-4000-8000-${String(runRows.length).padStart(12, '0')}`,
                    agentId: input.agentId,
                    taskId: input.taskId,
                    delegationScope: input.delegationScope ?? null,
                };
                runRows.push(row);
                return row;
            }),
            seedResumeContext: jest.fn(async () => undefined),
            setTriggerRunId: jest.fn(async () => undefined),
            markDispatchFailed: jest.fn(async () => undefined),
            findById: jest.fn(async (id: string) => runRows.find((row) => row.id === id) ?? null),
            findByIds: jest.fn(async (ids: string[]) =>
                runRows.filter((row) => ids.includes(row.id)),
            ),
            findAuthorAgentIdsForTask: jest.fn(async (_taskId: string, exclude: string[] = []) => [
                ...new Set(
                    runRows.filter((row) => !exclude.includes(row.id)).map((row) => row.agentId),
                ),
            ]),
        };
        const gitFacade = {
            getPullRequestStatus: jest.fn(async () => ({
                number: 42,
                state: 'open',
                merged: false,
                headSha: provider.head,
                baseRef: 'main',
                ciState: 'passing',
                checks: [],
                checksComplete: true,
            })),
            getCompareDiff: jest.fn(async () => ({
                files: [
                    {
                        path: 'src/b.ts',
                        status: 'modified',
                        additions: 1,
                        deletions: 1,
                        patch: '@@ -1 +1 @@\n-a\n+b\n',
                    },
                ],
                truncated: false,
                totalFiles: 1,
                totalAdditions: 1,
                totalDeletions: 1,
                patchBytes: 20,
            })),
        };
        const reviewService = new TaskAgentReviewService(
            tasks as any,
            reviews,
            approvers,
            {
                findById: jest.fn(async () => ({
                    id: 'work-1',
                    gitProvider: 'github',
                    getRepoOwner: () => 'ever-works',
                    getDataRepo: () => 'ever-works',
                })),
            } as any,
            { findAgentAssignees: jest.fn(async () => []) } as any,
            runs as any,
            {
                findById: jest.fn(async (id: string) => ({ id, userId: 'user-1', slug: id })),
            } as any,
            gitFacade as any,
        );
        const dispatcher = {
            enqueue: jest.fn(async (payload: { runId?: string }) => ({
                runId: `trigger-${payload.runId}`,
            })),
        };
        const transitions = new TaskTransitionService(
            tasks as any,
            { findByTaskId: jest.fn(async () => []) } as any,
            approvers,
            { findAgentAssignees: jest.fn(async () => []) } as any,
            runs as any,
            dispatcher as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
                findByIdAndUser: jest.fn(async (id: string, userId: string) => ({ id, userId })),
            } as any,
            reviewService,
        );

        /** A push the poll has recorded: provider and Task row both at `head`. */
        const pushTo = async (head: string) => {
            provider.head = head;
            tasks.state.task = { ...tasks.state.task, prHeadSha: head, ciHeadSha: head } as Task;
            await transitions.requestAgentReviews(tasks.state.task);
        };
        /** The open review at `head` answers. */
        const answer = async (head: string, verdict: 'approve' | 'request-changes') => {
            const review = (await reviews.listForTask(TASK_ID)).find(
                (row) => row.headSha === head && row.state === 'dispatched',
            );
            expect(review?.runId).toBeTruthy();
            return reviewService.submitVerdict({
                runId: review!.runId as string,
                reviewerAgentId: REVIEWER,
                verdict,
            });
        };
        const approverRow = async () =>
            dataSource
                .getRepository(TaskApprover)
                .findOneOrFail({ where: { approverId: REVIEWER } });
        const doneAllowed = async () =>
            transitions
                .transition({ ...tasks.state.task } as Task, TaskStatus.DONE)
                .then(() => true)
                .catch((error: unknown) => {
                    if (error instanceof ConflictException) return false;
                    throw error;
                });
        return {
            approvers,
            reviews,
            tasks,
            dispatcher,
            gitFacade,
            pushTo,
            answer,
            approverRow,
            doneAllowed,
        };
    }

    it('A approved → push B (reset, B reviewed) → force-push back to A: the approval for A is restored, and nothing is bought', async () => {
        const w = world();
        await w.approvers.add(TASK_ID, 'agent', REVIEWER);

        // Review of A, approved.
        await w.pushTo(HEAD_A);
        expect(await w.answer(HEAD_A, 'approve')).toMatchObject({ reason: 'recorded' });
        expect(await w.approverRow()).toMatchObject({
            approvalState: 'approved',
            decidedHeadSha: HEAD_A,
        });

        // Push B: the approval for A goes back to pending, B is reviewed and
        // approved.
        await w.pushTo(HEAD_B);
        expect(await w.approverRow()).toMatchObject({ approvalState: 'pending' });
        expect(await w.answer(HEAD_B, 'approve')).toMatchObject({ reason: 'recorded' });

        // Force-push back to A. The `(reviewer, A)` claim already exists, so
        // no review of A can ever be bought again — which used to leave the
        // approver on its B decision (or `pending`) forever, and the gate at A
        // refused a commit its reviewer had approved.
        const enqueuedBefore = w.dispatcher.enqueue.mock.calls.length;
        await w.pushTo(HEAD_A);
        expect(await w.approverRow()).toMatchObject({
            approvalState: 'approved',
            decidedVia: 'agent-review',
            decidedHeadSha: HEAD_A,
        });
        expect(w.dispatcher.enqueue.mock.calls.length).toBe(enqueuedBefore);
        expect(await w.reviews.listForTask(TASK_ID)).toHaveLength(2);
        expect(await w.doneAllowed()).toBe(true);
    });

    it('restores a REQUEST FOR CHANGES the same way — it keeps the gate shut, as the reviewer said', async () => {
        const w = world();
        await w.approvers.add(TASK_ID, 'agent', REVIEWER);
        await w.pushTo(HEAD_A);
        expect(await w.answer(HEAD_A, 'request-changes')).toMatchObject({ reason: 'recorded' });
        await w.pushTo(HEAD_B);
        await w.answer(HEAD_B, 'approve');
        await w.pushTo(HEAD_A);
        expect(await w.approverRow()).toMatchObject({
            approvalState: 'rejected',
            decidedHeadSha: HEAD_A,
        });
        expect(await w.doneAllowed()).toBe(false);
    });

    it('restores even when the lifetime budget is spent — putting a recorded verdict back costs no review', async () => {
        process.env.TASK_AGENT_REVIEW_MAX_RUNS = '2';
        const w = world();
        await w.approvers.add(TASK_ID, 'agent', REVIEWER);
        await w.pushTo(HEAD_A);
        await w.answer(HEAD_A, 'approve');
        await w.pushTo(HEAD_B);
        await w.answer(HEAD_B, 'approve');
        // Both budget slots are spent.
        expect(await w.reviews.countForTask(TASK_ID)).toBe(2);

        await w.pushTo(HEAD_A);
        expect(await w.approverRow()).toMatchObject({
            approvalState: 'approved',
            decidedHeadSha: HEAD_A,
        });
        expect(await w.doneAllowed()).toBe(true);
        // No diff was fetched for the restore, and no third review exists.
        expect(w.gitFacade.getCompareDiff).toHaveBeenCalledTimes(2);
        expect(await w.reviews.countForTask(TASK_ID)).toBe(2);
    });

    it('does NOT restore a review that is still open, refused or failed — only a verdict', async () => {
        const w = world();
        await w.approvers.add(TASK_ID, 'agent', REVIEWER);
        await w.pushTo(HEAD_A);
        // A's review never answers. Push B and back: A's claim exists but
        // holds no verdict, so the approver stays pending, gate shut.
        await w.pushTo(HEAD_B);
        await w.pushTo(HEAD_A);
        expect(await w.approverRow()).toMatchObject({ approvalState: 'pending' });
        expect(await w.doneAllowed()).toBe(false);
    });

    it('does NOT overwrite a decision that landed since — the restore is a compare-and-set from pending', async () => {
        const w = world();
        const row = await w.approvers.add(TASK_ID, 'agent', REVIEWER);
        await w.pushTo(HEAD_A);
        await w.answer(HEAD_A, 'approve');
        await w.approvers.setState(row.id, 'rejected', TASK_ID, {
            decidedVia: 'user',
            decidedByRunId: null,
            decidedHeadSha: null,
        });
        expect(
            await w.approvers.restoreAgentDecisionFromReview({
                id: row.id,
                taskId: TASK_ID,
                reviewerAgentId: REVIEWER,
                approvalState: 'approved',
                decidedByRunId: null,
                decidedHeadSha: HEAD_A,
            }),
        ).toBe(false);
        expect(await w.approverRow()).toMatchObject({
            approvalState: 'rejected',
            decidedVia: 'user',
        });
    });
});
