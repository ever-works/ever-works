import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/database.config';
import { TaskAgentReview } from '../../entities/task-agent-review.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskAgentReviewRepository } from '../../database/repositories/task-agent-review.repository';
import { TaskApproverRepository } from '../../database/repositories/task-side.repositories';
import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { TaskTransitionService } from '../task-transition.service';

/**
 * Reviewer agent stage — THE LIFETIME BUDGET UNDER CONCURRENCY
 * (Greptile P1-C on PR #2419).
 *
 * The finding, reproduced by execution: the per-Task review budget was a
 * COUNT of ledger rows read before the claim insert, and the only unique
 * index was `(taskId, claimKey)`. Two planners that both read the count
 * before either inserted saw the same remaining slot and inserted two
 * DISTINCT claims — here, one reviewer at two different heads (a push
 * landing between the two provider reads) — so with
 * `TASK_AGENT_REVIEW_MAX_RUNS=1` two reviews were persisted and two runs
 * dispatched.
 *
 * Everything below is REAL except the edges nobody can run in a unit test
 * (the git provider, the job runtime, the run table): a real better-sqlite3
 * schema built from the real `ENTITIES`, the real ledger and approver
 * repositories, the real `TaskAgentReviewService` planning, and the real
 * `TaskTransitionService.requestAgentReviews` → `dispatchAgentRun` path that
 * the PR-status poll takes. The interleave is FORCED with a barrier on the
 * budget read, the same way Greptile forced it, so the test does not depend
 * on scheduling luck.
 *
 * It is written only against APIs that predate the fix
 * (`requestAgentReviews`, `countForTask`, `listForTask`), so the pre-fix
 * code can be dropped in and seen to fail it.
 */

const TASK_ID = '0d6a3c9e-2f51-4f7e-9a44-6b0c1a1d2e01';
const APPROVER_AGENT = '7b1e0f7a-5d0c-4c5a-8f2e-3a9d6c4b2e11';
const IMPLEMENTER = 'c3f0b1d2-8e7a-4b6c-9d5e-1f2a3b4c5d60';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeTask(): Task {
    return {
        id: TASK_ID,
        slug: 'T-1',
        title: 'Ship the thing',
        userId: 'user-1',
        status: TaskStatus.IN_REVIEW,
        workId: 'work-1',
        prNumber: 42,
        prUrl: 'https://example.invalid/pr/42',
        // No cached head: nothing short-circuits before the budget read.
        prHeadSha: null,
        ciHeadSha: null,
        agentId: null,
        recurrenceOccurredCount: 0,
        tenantId: null,
        organizationId: null,
    } as unknown as Task;
}

function diffFor(head: string) {
    return {
        files: [
            {
                path: `src/${head.slice(0, 1)}.ts`,
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
    };
}

async function openSchema(): Promise<DataSource> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        synchronize: true,
    });
    await dataSource.initialize();
    // `task_approvers.taskId` is a real FK into the whole Task graph; this
    // test is about the ledger, not about fabricating users and works.
    await dataSource.query('PRAGMA foreign_keys = OFF');
    return dataSource;
}

/**
 * Hold every caller of `countForTask` until `parties` of them have read
 * the budget — then let them all go. Each caller gets the count it read.
 */
function barrierOnBudgetRead(reviews: TaskAgentReviewRepository, parties: number) {
    const read = reviews.countForTask.bind(reviews);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const observed: number[] = [];
    reviews.countForTask = async (taskId: string) => {
        const count = await read(taskId);
        observed.push(count);
        arrived += 1;
        if (arrived === parties) release();
        await gate;
        return count;
    };
    return observed;
}

/** One planner: its own provider view (its own live head), shared stores. */
function planner(
    head: string,
    stores: { reviews: TaskAgentReviewRepository; approvers: TaskApproverRepository },
    dispatcher: { enqueue: jest.Mock },
    runIds: { next: number },
) {
    const reviewService = new TaskAgentReviewService(
        { findById: jest.fn(async () => makeTask()) } as any,
        stores.reviews,
        stores.approvers,
        {
            findById: jest.fn(async () => ({
                id: 'work-1',
                gitProvider: 'github',
                getRepoOwner: () => 'ever-works',
                getDataRepo: () => 'ever-works',
            })),
        } as any,
        { findAgentAssignees: jest.fn(async () => []) } as any,
        {
            findByIds: jest.fn(async () => []),
            findAuthorAgentIdsForTask: jest.fn(async () => [IMPLEMENTER]),
        } as any,
        { findById: jest.fn(async (id: string) => ({ id, userId: 'user-1', slug: id })) } as any,
        {
            getPullRequestStatus: jest.fn(async () => ({
                number: 42,
                state: 'open',
                merged: false,
                headSha: head,
                baseRef: 'main',
                ciState: 'passing',
                checks: [],
                checksComplete: true,
            })),
            getCompareDiff: jest.fn(async () => diffFor(head)),
        } as any,
    );
    const runs = {
        createQueued: jest.fn(async () => {
            runIds.next += 1;
            return { id: `00000000-0000-4000-8000-${String(runIds.next).padStart(12, '0')}` };
        }),
        seedResumeContext: jest.fn(async () => undefined),
        setTriggerRunId: jest.fn(async () => undefined),
        markDispatchFailed: jest.fn(async () => undefined),
    };
    const transitions = new TaskTransitionService(
        { casUpdateStatus: jest.fn(), findById: jest.fn(async () => makeTask()) } as any,
        { findByTaskId: jest.fn(async () => []) } as any,
        stores.approvers,
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
    const plans: any[] = [];
    const planReviews = reviewService.planReviews.bind(reviewService);
    reviewService.planReviews = async (task: Task) => {
        const plan = await planReviews(task);
        plans.push(plan);
        return plan;
    };
    return { transitions, plans, runs };
}

describe('the review budget holds under two concurrent planners — real schema (Greptile P1-C)', () => {
    let dataSource: DataSource;
    let previousMaxRuns: string | undefined;

    beforeEach(async () => {
        previousMaxRuns = process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        process.env.TASK_AGENT_REVIEW_MAX_RUNS = '1';
        dataSource = await openSchema();
    });

    afterEach(async () => {
        if (previousMaxRuns === undefined) delete process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        else process.env.TASK_AGENT_REVIEW_MAX_RUNS = previousMaxRuns;
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('MAX_RUNS=1, both planners past the budget read before either claims: ONE review row, ONE dispatch', async () => {
        const reviews = new TaskAgentReviewRepository(dataSource.getRepository(TaskAgentReview));
        const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
        await approvers.add(TASK_ID, 'agent', APPROVER_AGENT);
        const observedBudget = barrierOnBudgetRead(reviews, 2);

        const dispatcher = {
            enqueue: jest.fn(async (payload: { runId?: string }) => ({
                runId: `trigger-${payload.runId}`,
            })),
        };
        const runIds = { next: 0 };
        const first = planner(HEAD_A, { reviews, approvers }, dispatcher, runIds);
        const second = planner(HEAD_B, { reviews, approvers }, dispatcher, runIds);

        await Promise.all([
            first.transitions.requestAgentReviews(makeTask()),
            second.transitions.requestAgentReviews(makeTask()),
        ]);

        // The interleave really happened: BOTH planners read "nothing spent"
        // before either of them claimed — the state Greptile forced.
        expect(observedBudget).toEqual([0, 0]);

        // THE bound, in the database: exactly one review persisted…
        const persisted = await reviews.listForTask(TASK_ID);
        expect(persisted).toHaveLength(1);
        expect([HEAD_A, HEAD_B]).toContain(persisted[0].headSha);
        // …and exactly one run handed to the job runtime.
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(
            first.runs.createQueued.mock.calls.length + second.runs.createQueued.mock.calls.length,
        ).toBe(1);

        // The loser was told why, in the words an operator reads.
        const reasons = [...first.plans, ...second.plans]
            .flatMap((plan) => plan.decisions)
            .map((decision: { reason: string }) => decision.reason)
            .sort();
        expect(reasons).toEqual(['budget-spent', 'dispatched']);
    });

    it('control: with budget for two, the same interleave buys both reviews', async () => {
        // Proves the refusal above is the BUDGET, not a harness that can only
        // ever dispatch once.
        process.env.TASK_AGENT_REVIEW_MAX_RUNS = '2';
        const reviews = new TaskAgentReviewRepository(dataSource.getRepository(TaskAgentReview));
        const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
        await approvers.add(TASK_ID, 'agent', APPROVER_AGENT);
        barrierOnBudgetRead(reviews, 2);

        const dispatcher = { enqueue: jest.fn(async () => ({ runId: 'trigger-x' })) };
        const runIds = { next: 0 };
        const first = planner(HEAD_A, { reviews, approvers }, dispatcher, runIds);
        const second = planner(HEAD_B, { reviews, approvers }, dispatcher, runIds);
        await Promise.all([
            first.transitions.requestAgentReviews(makeTask()),
            second.transitions.requestAgentReviews(makeTask()),
        ]);

        expect((await reviews.listForTask(TASK_ID)).map((row) => row.headSha).sort()).toEqual([
            HEAD_A,
            HEAD_B,
        ]);
        expect(dispatcher.enqueue).toHaveBeenCalledTimes(2);
    });
});
