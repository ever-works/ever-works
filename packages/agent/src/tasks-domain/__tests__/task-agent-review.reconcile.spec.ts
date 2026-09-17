import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/database.config';
import { Task, TaskStatus } from '../../entities/task.entity';
import { TaskAgentReview } from '../../entities/task-agent-review.entity';
import { TaskApprover } from '../../entities/task-approver.entity';
import { TaskRepository } from '../../database/repositories/task.repository';
import { TaskAgentReviewRepository } from '../../database/repositories/task-agent-review.repository';
import { TaskApproverRepository } from '../../database/repositories/task-side.repositories';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { TaskTransitionService } from '../task-transition.service';
import { TaskPrStatusService } from '../task-pr-status.service';
import {
    AGENT_REVIEW_PLAN_MAX_ATTEMPTS,
    AGENT_REVIEW_PLAN_REASON_CLASS,
    AGENT_REVIEW_PLAN_RETRY_BASE_MS,
    AGENT_REVIEW_PLAN_RETRY_MAX_MS,
    agentReviewApproverFingerprint,
    agentReviewPlanKey,
    agentReviewPlanRetryDelayMs,
    classifyAgentReviewPlanOutcome,
    decideAgentReviewPlanAttempt,
    type AgentReviewDispatchReason,
} from '../task-agent-review';

/**
 * Reviewer agent stage — DURABLE, SELF-HEALING REVIEW PLANNING
 * (CodeRabbit CR-2 on PR #2419).
 *
 * The finding: review planning is fire-and-forget AFTER the state change is
 * persisted — the entry into `in_review` (`TaskTransitionService.transition`)
 * and a head change the poll recorded (`TaskPrStatusService.refreshTask`). A
 * transient failure or a process kill in between left nothing durable saying
 * a review was owed, so every agent review for that Task and head was
 * suppressed until another head change. Safe (the approvers stay pending),
 * but the autonomy chain silently stalled.
 *
 * The fix: the PR-status poll reconciles every `in_review` Task whose head did
 * not move, under a plan memory on the Task row that remembers deterministic
 * refusals, backs transient failures off (capped), resets on a new head, and
 * is written with a compare-and-set so two replicas plan a Task once.
 *
 * Everything below is REAL except the edges no unit test can run (the git
 * provider, the job runtime, the run table): a better-sqlite3 schema built
 * from the real `ENTITIES`, the real Task / approver / ledger repositories,
 * the real review service, transition service and PR-status poll.
 */

const TASK_ID = '3f0c2a1e-9b7d-4c6e-8a5f-1d2e3c4b5a60';
const USER_ID = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c10';
const WORK_ID = '8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e50';
const REVIEWER = '7b1e0f7a-5d0c-4c5a-8f2e-3a9d6c4b2e11';
const IMPLEMENTER = 'c3f0b1d2-8e7a-4b6c-9d5e-1f2a3b4c5d60';
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
    // `tasks.userId` and `task_approvers.taskId` are real FKs into the whole
    // graph; this spec is about planning, not about fabricating users.
    await dataSource.query('PRAGMA foreign_keys = OFF');
    return dataSource;
}

function reviewableDiff() {
    return {
        files: [
            {
                path: 'src/a.ts',
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

/** A diff the review stage refuses DETERMINISTICALLY (`diff-too-large`). */
function truncatedDiff() {
    return { ...reviewableDiff(), truncated: true };
}

const work = {
    findById: jest.fn(async () => ({
        id: WORK_ID,
        gitProvider: 'github',
        taskIsolationBaseBranch: 'main',
        getRepoOwner: () => 'ever-works',
        getDataRepo: () => 'ever-works',
    })),
};

/** The provider as the review service sees it — every call counted. */
interface ProviderView {
    liveHead: string;
    diff: () => unknown;
    statusError: Error | null;
}

/**
 * One API replica: its own review service, transition service and poll, on
 * the SHARED database.
 */
function replica(dataSource: DataSource, provider: ProviderView) {
    const tasks = new TaskRepository(dataSource.getRepository(Task));
    const reviewsRepo = new TaskAgentReviewRepository(dataSource.getRepository(TaskAgentReview));
    const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
    const reviewGit = {
        getPullRequestStatus: jest.fn(async () => {
            if (provider.statusError) throw provider.statusError;
            return {
                number: 42,
                state: 'open',
                merged: false,
                headSha: provider.liveHead,
                baseRef: 'main',
                ciState: 'passing',
                checks: [],
                checksComplete: true,
            };
        }),
        getCompareDiff: jest.fn(async () => provider.diff()),
    };
    let runSeq = 0;
    const runs = {
        // Authorship, for the self-review refusal: the implementer wrote it.
        findByIds: jest.fn(async () => []),
        findAuthorAgentIdsForTask: jest.fn(async () => [IMPLEMENTER]),
        // The dispatch path.
        createQueued: jest.fn(async () => {
            runSeq += 1;
            return { id: `00000000-0000-4000-8000-${String(runSeq).padStart(12, '0')}` };
        }),
        seedResumeContext: jest.fn(async () => undefined),
        setTriggerRunId: jest.fn(async () => undefined),
        markDispatchFailed: jest.fn(async () => undefined),
    };
    const dispatcher = { enqueue: jest.fn(async () => ({ runId: 'trigger-run' })) };
    const agents = {
        findById: jest.fn(async (id: string) => ({ id, userId: USER_ID, slug: id })),
        findByIdAndUser: jest.fn(async (id: string, userId: string) => ({ id, userId })),
    };
    const assignees = { findAgentAssignees: jest.fn(async () => []) };
    const reviewService = new TaskAgentReviewService(
        tasks,
        reviewsRepo,
        approvers,
        work as any,
        assignees as any,
        runs as any,
        agents as any,
        reviewGit as any,
    );
    const transitions = new TaskTransitionService(
        tasks,
        { findByTaskId: jest.fn(async () => []) } as any,
        approvers,
        assignees as any,
        runs as any,
        dispatcher as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        agents as any,
        reviewService,
    );
    return {
        tasks,
        reviewsRepo,
        approvers,
        reviewGit,
        runs,
        dispatcher,
        transitions,
        reviewService,
    };
}

/** The PR-status poll of one replica, reading the provider head `pollHead()`. */
function poll(dataSource: DataSource, transitions: TaskTransitionService, pollHead: () => string) {
    const pollGit = {
        getPullRequestStatus: jest.fn(async () => ({
            number: 42,
            state: 'open',
            merged: false,
            headSha: pollHead(),
            ciState: 'passing',
            checks: [],
        })),
    };
    const service = new TaskPrStatusService(
        new TaskRepository(dataSource.getRepository(Task)),
        work as any,
        pollGit as any,
        transitions,
    );
    return { service, pollGit };
}

/** The poll's review hooks are fire-and-forget; wait for exactly those. */
async function drain(spy: jest.SpyInstance): Promise<void> {
    await Promise.all(spy.mock.results.map((result) => result.value));
}

/** For the entry hook, whose promise nothing returns: poll the database. */
async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('condition never held');
}

async function seedTask(dataSource: DataSource, over: Partial<Task> = {}): Promise<Task> {
    return dataSource.getRepository(Task).save({
        id: TASK_ID,
        userId: USER_ID,
        slug: 'T-1',
        title: 'Ship the thing',
        status: TaskStatus.IN_REVIEW,
        workId: WORK_ID,
        prNumber: 42,
        prUrl: 'https://example.invalid/pr/42',
        prState: 'open',
        prHeadSha: HEAD_A,
        ciHeadSha: HEAD_A,
        createdByType: 'user',
        createdById: USER_ID,
        requireAllApprovers: true,
        ...over,
    } as Task);
}

async function reload(dataSource: DataSource): Promise<Task> {
    return (await dataSource.getRepository(Task).findOneByOrFail({ id: TASK_ID })) as Task;
}

describe('agent review planning is durable and self-healing — real schema (CodeRabbit CR-2)', () => {
    let dataSource: DataSource;
    let provider: ProviderView;
    // The names `config.agents` reads (`packages/agent/src/config/index.ts`):
    // the per-entry cap is `TASK_AGENT_REVIEW_MAX_APPROVERS`. This used to
    // clear `TASK_AGENT_REVIEW_MAX_APPROVERS_PER_ENTRY`, which nothing reads,
    // so the cap these tests assert against came from the process environment.
    const savedEnv = {
        maxRuns: process.env.TASK_AGENT_REVIEW_MAX_RUNS,
        maxApprovers: process.env.TASK_AGENT_REVIEW_MAX_APPROVERS,
    };

    beforeEach(async () => {
        delete process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        delete process.env.TASK_AGENT_REVIEW_MAX_APPROVERS;
        dataSource = await openSchema();
        provider = { liveHead: HEAD_A, diff: reviewableDiff, statusError: null };
        await new TaskApproverRepository(dataSource.getRepository(TaskApprover)).add(
            TASK_ID,
            'agent',
            REVIEWER,
        );
    });

    afterEach(async () => {
        jest.useRealTimers();
        if (savedEnv.maxRuns === undefined) delete process.env.TASK_AGENT_REVIEW_MAX_RUNS;
        else process.env.TASK_AGENT_REVIEW_MAX_RUNS = savedEnv.maxRuns;
        if (savedEnv.maxApprovers === undefined) {
            delete process.env.TASK_AGENT_REVIEW_MAX_APPROVERS;
        } else {
            process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = savedEnv.maxApprovers;
        }
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('(a) crash window: in_review persisted, planner never ran — the next poll plans it exactly once', async () => {
        await seedTask(dataSource, { status: TaskStatus.IN_PROGRESS, ciCheckedAt: null });
        // The process that persisted the transition dies before planning: a
        // transition service with no review stage wired stands in for it —
        // the status write lands, and nothing else happens.
        const crashed = replica(dataSource, provider);
        const dying = new TaskTransitionService(
            crashed.tasks,
            { findByTaskId: jest.fn(async () => []) } as any,
            crashed.approvers,
        );
        await dying.transition(await reload(dataSource), TaskStatus.IN_REVIEW);
        expect((await reload(dataSource)).status).toBe(TaskStatus.IN_REVIEW);
        expect((await reload(dataSource)).agentReviewPlanKey ?? null).toBeNull();

        // A healthy replica's two-minute sweep. The head did NOT move.
        const healthy = replica(dataSource, provider);
        const reconcile = jest.spyOn(healthy.transitions, 'reconcileAgentReviews');
        const request = jest.spyOn(healthy.transitions, 'requestAgentReviews');
        const sweep = poll(dataSource, healthy.transitions, () => HEAD_A);

        await sweep.service.syncDuePrStatuses();
        await drain(reconcile);

        expect(request).not.toHaveBeenCalled();
        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(healthy.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(healthy.reviewGit.getCompareDiff).toHaveBeenCalledTimes(1);
        expect(healthy.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        const ledger = await healthy.reviewsRepo.listForTask(TASK_ID);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ reviewerAgentId: REVIEWER, headSha: HEAD_A });
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'settled',
            agentReviewPlanReason: 'dispatched',
            agentReviewPlanAttempts: 1,
        });

        // …and exactly once: later sweeps find the claim and buy nothing.
        await sweep.service.syncDuePrStatuses({ staleSeconds: -1 });
        await sweep.service.syncDuePrStatuses({ staleSeconds: -1 });
        await drain(reconcile);
        expect(reconcile).toHaveBeenCalledTimes(3);
        expect(healthy.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(healthy.reviewGit.getCompareDiff).toHaveBeenCalledTimes(1);
        expect(healthy.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(await healthy.reviewsRepo.listForTask(TASK_ID)).toHaveLength(1);
    });

    it('(b) a DETERMINISTIC refusal is remembered — later reconciles make zero provider and diff calls for that head', async () => {
        await seedTask(dataSource);
        provider.diff = truncatedDiff;
        const r = replica(dataSource, provider);

        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(r.reviewGit.getCompareDiff).toHaveBeenCalledTimes(1);
        const refused = await reload(dataSource);
        expect(refused).toMatchObject({
            agentReviewPlanState: 'refused',
            agentReviewPlanReason: 'diff-too-large',
            agentReviewPlanAttempts: 1,
            agentReviewPlanNextAt: null,
        });
        expect(refused.agentReviewPlanKey?.startsWith(`${HEAD_A}:`)).toBe(true);

        for (let i = 0; i < 5; i += 1) {
            await r.transitions.reconcileAgentReviews(await reload(dataSource));
        }
        // …and through the poll, which is what calls it in production.
        const reconcile = jest.spyOn(r.transitions, 'reconcileAgentReviews');
        const sweep = poll(dataSource, r.transitions, () => HEAD_A);
        await sweep.service.syncDuePrStatuses({ staleSeconds: -1 });
        await drain(reconcile);
        expect(reconcile).toHaveBeenCalledTimes(1);

        expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(r.reviewGit.getCompareDiff).toHaveBeenCalledTimes(1);
        expect(r.dispatcher.enqueue).not.toHaveBeenCalled();
        expect(await r.reviewsRepo.listForTask(TASK_ID)).toHaveLength(0);
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'refused',
            agentReviewPlanAttempts: 1,
        });
    });

    it('(c) a TRANSIENT refusal is retried after capped exponential backoff, and stops at the attempt cap', async () => {
        await seedTask(dataSource);
        provider.statusError = new Error('provider 502');
        const r = replica(dataSource, provider);
        const t0 = new Date('2026-09-14T10:00:00.000Z').getTime();
        jest.useFakeTimers({
            doNotFake: [
                'nextTick',
                'setImmediate',
                'clearImmediate',
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'queueMicrotask',
                'hrtime',
                'performance',
            ],
        });
        let now = t0;
        const at = (ms: number) => {
            now = ms;
            jest.setSystemTime(now);
        };
        const reconcileNow = async () =>
            r.transitions.reconcileAgentReviews(await reload(dataSource));

        at(t0);
        await reconcileNow();
        expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
        let memory = await reload(dataSource);
        expect(memory).toMatchObject({
            agentReviewPlanState: 'retry',
            agentReviewPlanReason: 'pr-unreadable',
            agentReviewPlanAttempts: 1,
        });

        // Inside the backoff: nothing, however often the poll asks.
        at(t0 + 60_000);
        await reconcileNow();
        await reconcileNow();
        expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);

        // Each retry lands only once its own, doubling, delay has elapsed —
        // not a millisecond before. (The due times are computed here, not
        // read back from the row: the gate compares them in the database.)
        let lastAttemptAt = t0;
        const gaps: number[] = [];
        for (let attempt = 2; attempt <= AGENT_REVIEW_PLAN_MAX_ATTEMPTS; attempt += 1) {
            const due = lastAttemptAt + agentReviewPlanRetryDelayMs(attempt - 1);
            at(due - 1);
            await reconcileNow();
            expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(attempt - 1);
            at(due);
            await reconcileNow();
            expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(attempt);
            expect(await reload(dataSource)).toMatchObject({ agentReviewPlanAttempts: attempt });
            gaps.push(due - lastAttemptAt);
            lastAttemptAt = due;
        }
        expect(gaps).toEqual([
            AGENT_REVIEW_PLAN_RETRY_BASE_MS,
            AGENT_REVIEW_PLAN_RETRY_BASE_MS * 2,
            AGENT_REVIEW_PLAN_RETRY_BASE_MS * 4,
            AGENT_REVIEW_PLAN_RETRY_BASE_MS * 8,
        ]);

        memory = await reload(dataSource);
        expect(memory).toMatchObject({
            agentReviewPlanState: 'exhausted',
            agentReviewPlanReason: 'pr-unreadable',
            agentReviewPlanAttempts: AGENT_REVIEW_PLAN_MAX_ATTEMPTS,
            agentReviewPlanNextAt: null,
        });

        // The cap holds: a day later, provider healthy again, still nothing
        // for this key (a new head resets it — see (d)).
        provider.statusError = null;
        at(now + 24 * 60 * 60 * 1000);
        await reconcileNow();
        await reconcileNow();
        expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(
            AGENT_REVIEW_PLAN_MAX_ATTEMPTS,
        );
        expect(r.reviewGit.getCompareDiff).not.toHaveBeenCalled();
        expect(r.dispatcher.enqueue).not.toHaveBeenCalled();
    });

    it('(c) a planning attempt killed mid-flight counts as an attempt once its lease expires', async () => {
        await seedTask(dataSource);
        const r = replica(dataSource, provider);
        // A replica took the lease and died: the row says in-flight, no outcome.
        const snapshot = await reload(dataSource);
        const probe = await r.reviewService.probeAgentReviewPlan(snapshot);
        const expired = new Date(Date.now() - 1000);
        expect(
            await r.tasks.claimAgentReviewPlan({
                taskId: TASK_ID,
                expectedLease: null,
                now: new Date(),
                when: 'always',
                patch: {
                    agentReviewPlanKey: probe!.planKey!,
                    agentReviewPlanState: 'in-flight',
                    agentReviewPlanAttempts: 1,
                    agentReviewPlanNextAt: expired,
                    agentReviewPlanLease: 'dead-lease',
                },
            }),
        ).toBe(true);

        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'settled',
            agentReviewPlanAttempts: 2,
        });
        // The dead attempt cannot overwrite its successor's outcome.
        expect(
            await r.tasks.settleAgentReviewPlan({
                taskId: TASK_ID,
                lease: 'dead-lease',
                patch: {
                    agentReviewPlanKey: probe!.planKey!,
                    agentReviewPlanState: 'retry',
                    agentReviewPlanReason: 'error',
                    agentReviewPlanNextAt: null,
                    agentReviewPlanLease: 'dead-lease-rotated',
                },
            }),
        ).toBe(false);
    });

    it('the lease compare-and-set enforces its time condition in the database', async () => {
        await seedTask(dataSource);
        const tasks = new TaskRepository(dataSource.getRepository(Task));
        const now = new Date();
        const claim = (
            expectedLease: string | null,
            when: 'always' | 'due' | 'no-live-lease',
            lease: string,
            nextAt: Date,
        ) =>
            tasks.claimAgentReviewPlan({
                taskId: TASK_ID,
                expectedLease,
                now,
                when,
                patch: {
                    agentReviewPlanKey: `${HEAD_A}:k`,
                    agentReviewPlanState: 'in-flight',
                    agentReviewPlanAttempts: 1,
                    agentReviewPlanNextAt: nextAt,
                    agentReviewPlanLease: lease,
                },
            });
        const live = new Date(now.getTime() + 60_000);
        expect(await claim(null, 'always', 'l1', live)).toBe(true);
        // A live lease: neither a due poll attempt nor an entry may take it…
        expect(await claim('l1', 'due', 'l2', live)).toBe(false);
        expect(await claim('l1', 'no-live-lease', 'l2', live)).toBe(false);
        // …nor anyone holding a stale token.
        expect(await claim(null, 'always', 'l2', live)).toBe(false);
        // Expired: both may.
        await dataSource
            .getRepository(Task)
            .update({ id: TASK_ID }, { agentReviewPlanNextAt: new Date(now.getTime() - 1) });
        expect(await claim('l1', 'no-live-lease', 'l3', live)).toBe(true);
        await dataSource
            .getRepository(Task)
            .update({ id: TASK_ID }, { agentReviewPlanNextAt: new Date(now.getTime() - 1) });
        expect(await claim('l3', 'due', 'l4', live)).toBe(true);
    });

    it('(d) a head change resets the memory — the new head is planned, attempts start again', async () => {
        await seedTask(dataSource);
        provider.diff = truncatedDiff;
        const r = replica(dataSource, provider);
        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        expect(await reload(dataSource)).toMatchObject({ agentReviewPlanState: 'refused' });

        // The fix loop pushes B; the provider and the poll both see it.
        provider.liveHead = HEAD_B;
        provider.diff = reviewableDiff;
        const request = jest.spyOn(r.transitions, 'requestAgentReviews');
        const reconcile = jest.spyOn(r.transitions, 'reconcileAgentReviews');
        const sweep = poll(dataSource, r.transitions, () => HEAD_B);
        await sweep.service.syncDuePrStatuses();
        await drain(request);

        expect(request).toHaveBeenCalledTimes(1);
        expect(reconcile).not.toHaveBeenCalled();
        expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(2);
        expect(r.reviewGit.getCompareDiff).toHaveBeenCalledTimes(2);
        expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        const planned = await reload(dataSource);
        expect(planned).toMatchObject({
            agentReviewPlanState: 'settled',
            agentReviewPlanReason: 'dispatched',
            agentReviewPlanAttempts: 1,
        });
        expect(planned.agentReviewPlanKey?.startsWith(`${HEAD_B}:`)).toBe(true);
        expect((await r.reviewsRepo.listForTask(TASK_ID)).map((row) => row.headSha)).toEqual([
            HEAD_B,
        ]);
    });

    it('(d) a head change resets an EXHAUSTED key too', async () => {
        await seedTask(dataSource);
        provider.statusError = new Error('provider 502');
        const r = replica(dataSource, provider);
        // Exhausted at A, as (c) leaves it.
        const snapshot = await reload(dataSource);
        const probe = await r.reviewService.probeAgentReviewPlan(snapshot);
        await dataSource.getRepository(Task).update(
            { id: TASK_ID },
            {
                agentReviewPlanKey: probe!.planKey!,
                agentReviewPlanState: 'exhausted',
                agentReviewPlanAttempts: AGENT_REVIEW_PLAN_MAX_ATTEMPTS,
                agentReviewPlanReason: 'pr-unreadable',
                agentReviewPlanLease: 'old-lease',
            },
        );
        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        expect(r.reviewGit.getPullRequestStatus).not.toHaveBeenCalled();

        provider.statusError = null;
        provider.liveHead = HEAD_B;
        await r.tasks.updatePrStatusCache(TASK_ID, { prHeadSha: HEAD_B });
        await r.transitions.reconcileAgentReviews(await reload(dataSource));

        expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'settled',
            agentReviewPlanAttempts: 1,
        });
    });

    it('(e) two concurrent reconciles of one Task on two replicas plan it once and dispatch once', async () => {
        await seedTask(dataSource);
        const first = replica(dataSource, provider);
        const second = replica(dataSource, provider);
        // Both replicas read the Task before either acts — the state two
        // sweeps landing on the same Task are in.
        const [snapshotOne, snapshotTwo] = [await reload(dataSource), await reload(dataSource)];

        await Promise.all([
            first.transitions.reconcileAgentReviews(snapshotOne),
            second.transitions.reconcileAgentReviews(snapshotTwo),
        ]);

        const providerCalls =
            first.reviewGit.getPullRequestStatus.mock.calls.length +
            second.reviewGit.getPullRequestStatus.mock.calls.length;
        const diffCalls =
            first.reviewGit.getCompareDiff.mock.calls.length +
            second.reviewGit.getCompareDiff.mock.calls.length;
        const dispatches =
            first.dispatcher.enqueue.mock.calls.length +
            second.dispatcher.enqueue.mock.calls.length;
        expect({ providerCalls, diffCalls, dispatches }).toEqual({
            providerCalls: 1,
            diffCalls: 1,
            dispatches: 1,
        });
        expect(await first.reviewsRepo.listForTask(TASK_ID)).toHaveLength(1);
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'settled',
            agentReviewPlanAttempts: 1,
        });
    });

    it('(f) a Task that left in_review is no longer reconciled — even from a stale in-memory copy', async () => {
        await seedTask(dataSource);
        const r = replica(dataSource, provider);
        const stale = await reload(dataSource);
        // Someone moves it back to in_progress after the sweep read it.
        expect(
            await r.tasks.casUpdateStatus(TASK_ID, TaskStatus.IN_REVIEW, {
                status: TaskStatus.IN_PROGRESS,
            }),
        ).toBe(true);

        await r.transitions.reconcileAgentReviews(stale);
        await r.transitions.reconcileAgentReviews(await reload(dataSource));

        expect(r.reviewGit.getPullRequestStatus).not.toHaveBeenCalled();
        expect(r.reviewGit.getCompareDiff).not.toHaveBeenCalled();
        expect(r.dispatcher.enqueue).not.toHaveBeenCalled();
        const row = await reload(dataSource);
        expect(row.agentReviewPlanKey ?? null).toBeNull();
        expect(row.agentReviewPlanLease ?? null).toBeNull();

        // …and the poll does not even ask for a Task outside review.
        const reconcile = jest.spyOn(r.transitions, 'reconcileAgentReviews');
        const sweep = poll(dataSource, r.transitions, () => HEAD_A);
        await sweep.service.syncDuePrStatuses();
        expect(sweep.pollGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('the ENTRY hook records its outcome, so the reconcile after it buys nothing — and a new entry still re-plans a refused head', async () => {
        await seedTask(dataSource, { status: TaskStatus.IN_PROGRESS });
        provider.diff = truncatedDiff;
        const r = replica(dataSource, provider);
        const plan = jest.spyOn(r.reviewService, 'planReviews');

        await r.transitions.transition(await reload(dataSource), TaskStatus.IN_REVIEW);
        // The entry hook is fire-and-forget: wait for its outcome to land.
        await waitFor(async () => (await reload(dataSource)).agentReviewPlanState === 'refused');
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'refused',
            agentReviewPlanReason: 'diff-too-large',
        });
        expect(r.reviewGit.getCompareDiff).toHaveBeenCalledTimes(1);

        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        expect(r.reviewGit.getCompareDiff).toHaveBeenCalledTimes(1);

        // A human pulls it back and re-enters review on the same head: an
        // entry plans exactly as it did before the memory existed.
        await r.tasks.casUpdateStatus(TASK_ID, TaskStatus.IN_REVIEW, {
            status: TaskStatus.IN_PROGRESS,
        });
        await r.transitions.transition(await reload(dataSource), TaskStatus.IN_REVIEW);
        await waitFor(async () => r.reviewGit.getCompareDiff.mock.calls.length === 2);
        await waitFor(async () => (await reload(dataSource)).agentReviewPlanState === 'refused');
        expect(plan).toHaveBeenCalledTimes(2);
        expect(r.reviewGit.getCompareDiff).toHaveBeenCalledTimes(2);
    });

    it('a changed agent approver set is a new key — a second reviewer added after a self-review refusal gets its review', async () => {
        await seedTask(dataSource);
        // The only agent approver is the implementer itself.
        const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
        await dataSource.getRepository(TaskApprover).delete({ taskId: TASK_ID });
        await approvers.add(TASK_ID, 'agent', IMPLEMENTER);
        const r = replica(dataSource, provider);

        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'refused',
            agentReviewPlanReason: 'self-review',
            agentReviewPlanAttempts: 1,
        });
        // Refused before any provider call, and remembered.
        expect(r.reviewGit.getPullRequestStatus).not.toHaveBeenCalled();

        await approvers.add(TASK_ID, 'agent', REVIEWER);
        await r.transitions.reconcileAgentReviews(await reload(dataSource));
        expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(
            (await r.reviewsRepo.listForTask(TASK_ID)).map((row) => row.reviewerAgentId),
        ).toEqual([REVIEWER]);
    });

    /**
     * Adversarial review of CR-2, finding 1 — the lease compare-and-set could
     * be won from a STALE copy of the row. A settle left the lease token as it
     * was, and a settled / refused / exhausted row has `agentReviewPlanNextAt`
     * NULL, which satisfies `due`. So a copy read while an attempt was in
     * flight (`in-flight`, that attempt's token — the sweep loads its 25 Tasks
     * up front, the on-demand refresh loads one) still passed both checks once
     * that attempt settled, and planned the key again.
     */
    describe('a copy of the row read while another attempt was in flight', () => {
        const REVIEWER2 = '9d2e1f0a-6b5c-4d4e-8a7b-2c1d0e9f8a71';

        /** Runs `first` until its diff read, snapshots the row, then lets it settle. */
        async function snapshotMidFlight(
            first: ReturnType<typeof replica>,
            diff: () => unknown,
        ): Promise<{ midFlight: Task; diffCalls: () => number }> {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let calls = 0;
            provider.diff = async () => {
                calls += 1;
                if (calls === 1) await gate;
                return diff();
            };
            const running = first.transitions.reconcileAgentReviews(await reload(dataSource));
            await waitFor(
                async () =>
                    calls === 1 && (await reload(dataSource)).agentReviewPlanState === 'in-flight',
            );
            const midFlight = await reload(dataSource);
            expect(midFlight.agentReviewPlanState).toBe('in-flight');
            release();
            await running;
            return { midFlight, diffCalls: () => calls };
        }

        it('cannot plan the key that attempt then REFUSED — no provider call, no diff', async () => {
            await seedTask(dataSource);
            const first = replica(dataSource, provider);
            const second = replica(dataSource, provider);

            const { midFlight, diffCalls } = await snapshotMidFlight(first, truncatedDiff);
            expect(await reload(dataSource)).toMatchObject({
                agentReviewPlanState: 'refused',
                agentReviewPlanReason: 'diff-too-large',
                agentReviewPlanAttempts: 1,
            });

            await second.transitions.reconcileAgentReviews(midFlight);

            expect(second.reviewGit.getPullRequestStatus).not.toHaveBeenCalled();
            expect(diffCalls()).toBe(1);
            expect(await reload(dataSource)).toMatchObject({
                agentReviewPlanState: 'refused',
                agentReviewPlanAttempts: 1,
            });
        });

        it('cannot buy the approvers that attempt SETTLED past the per-entry cap', async () => {
            process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = '1';
            await new TaskApproverRepository(dataSource.getRepository(TaskApprover)).add(
                TASK_ID,
                'agent',
                REVIEWER2,
            );
            await seedTask(dataSource);
            const first = replica(dataSource, provider);
            const second = replica(dataSource, provider);

            const { midFlight } = await snapshotMidFlight(first, reviewableDiff);
            expect(first.dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(await reload(dataSource)).toMatchObject({
                agentReviewPlanState: 'settled',
                agentReviewPlanStarted: 1,
            });

            await second.transitions.reconcileAgentReviews(midFlight);

            expect(second.reviewGit.getPullRequestStatus).not.toHaveBeenCalled();
            expect(second.dispatcher.enqueue).not.toHaveBeenCalled();
            expect(await first.reviewsRepo.listForTask(TASK_ID)).toHaveLength(1);
        });
    });

    /**
     * Adversarial review of CR-2, finding 2 — a retry re-opened the per-entry
     * approver cap. An outcome is `retry` when ANY approver hit a transient
     * failure, even beside a dispatch and a capped approver, and every
     * attempt used to start its cap count at zero — so each retry bought
     * another cap's worth of runs for one entry and one head.
     */
    describe('a retry does not re-open the per-entry approver cap', () => {
        const REVIEWER2 = '9d2e1f0a-6b5c-4d4e-8a7b-2c1d0e9f8a71';
        const THIRD = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a82';

        async function elapseBackoff(): Promise<void> {
            await dataSource
                .getRepository(Task)
                .update(
                    { id: TASK_ID },
                    { agentReviewPlanNextAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                );
        }

        it('beside a transient reviewer: the retry buys nothing past the cap, and costs no read', async () => {
            process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = '1';
            const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
            await approvers.add(TASK_ID, 'agent', REVIEWER2);
            // THIRD's agent row cannot be read: `reviewer-unreadable`, transient.
            await approvers.add(TASK_ID, 'agent', THIRD);
            await seedTask(dataSource);
            const r = replica(dataSource, provider);
            ((r.reviewService as any).agents.findById as jest.Mock).mockImplementation(
                async (id: string) => (id === THIRD ? null : { id, userId: USER_ID, slug: id }),
            );

            await r.transitions.reconcileAgentReviews(await reload(dataSource));
            expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(await reload(dataSource)).toMatchObject({
                agentReviewPlanState: 'retry',
                agentReviewPlanReason: 'reviewer-unreadable',
                agentReviewPlanStarted: 1,
            });

            await elapseBackoff();
            await r.transitions.reconcileAgentReviews(await reload(dataSource));
            expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(r.reviewGit.getPullRequestStatus).toHaveBeenCalledTimes(1);
            expect(r.reviewGit.getCompareDiff).toHaveBeenCalledTimes(1);
            expect(await reload(dataSource)).toMatchObject({
                agentReviewPlanState: 'refused',
                agentReviewPlanReason: 'approver-cap',
                agentReviewPlanAttempts: 2,
            });

            // Remembered: later polls buy nothing either.
            await r.transitions.reconcileAgentReviews(await reload(dataSource));
            expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(await r.reviewsRepo.listForTask(TASK_ID)).toHaveLength(1);
        });

        it('after a claim that threw: the retry buys only what the cap had left', async () => {
            process.env.TASK_AGENT_REVIEW_MAX_APPROVERS = '2';
            const approvers = new TaskApproverRepository(dataSource.getRepository(TaskApprover));
            await approvers.add(TASK_ID, 'agent', REVIEWER2);
            await approvers.add(TASK_ID, 'agent', THIRD);
            await seedTask(dataSource);
            const r = replica(dataSource, provider);
            // The SECOND claim of the first attempt hits a store blip; every
            // approver after it is refused `error` in that plan.
            const realClaim = r.reviewsRepo.claim.bind(r.reviewsRepo);
            let claims = 0;
            jest.spyOn(r.reviewsRepo, 'claim').mockImplementation(async (input) => {
                claims += 1;
                if (claims === 2) throw new Error('store blip');
                return realClaim(input);
            });

            await r.transitions.reconcileAgentReviews(await reload(dataSource));
            expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(1);
            expect(await reload(dataSource)).toMatchObject({
                agentReviewPlanState: 'retry',
                agentReviewPlanReason: 'error',
                agentReviewPlanStarted: 1,
            });

            await elapseBackoff();
            await r.transitions.reconcileAgentReviews(await reload(dataSource));

            // A cap of 2 for this entry and head: 2 runs, not 3.
            expect(r.dispatcher.enqueue).toHaveBeenCalledTimes(2);
            expect(await r.reviewsRepo.listForTask(TASK_ID)).toHaveLength(2);
            expect(await reload(dataSource)).toMatchObject({
                agentReviewPlanState: 'settled',
                agentReviewPlanStarted: 2,
            });
        });
    });

    /**
     * Adversarial review of CR-2, finding 8 — a RE-entry into `in_review` on a
     * key the memory already remembered was not crash-safe: the entry plans
     * past the remembered outcome, but only its fire-and-forget hook knew
     * that. A process killed before the hook's lease left the old outcome in
     * place, and every later reconcile skipped the key.
     */
    it('a RE-entry whose planning never ran is recovered by the next poll, over a remembered outcome', async () => {
        await seedTask(dataSource, { status: TaskStatus.IN_PROGRESS, ciCheckedAt: null });
        const healthy = replica(dataSource, provider);
        // A previous review period exhausted this very key.
        const probe = await healthy.reviewService.probeAgentReviewPlan(await reload(dataSource));
        await dataSource.getRepository(Task).update(
            { id: TASK_ID },
            {
                agentReviewPlanKey: probe!.planKey!,
                agentReviewPlanState: 'exhausted',
                agentReviewPlanReason: 'pr-unreadable',
                agentReviewPlanAttempts: AGENT_REVIEW_PLAN_MAX_ATTEMPTS,
                agentReviewPlanLease: 'previous-period-lease',
            },
        );

        // A human moves it back into review; the process dies before planning.
        const dying = new TaskTransitionService(
            healthy.tasks,
            { findByTaskId: jest.fn(async () => []) } as any,
            healthy.approvers,
        );
        await dying.transition(await reload(dataSource), TaskStatus.IN_REVIEW);
        const entered = await reload(dataSource);
        expect(entered.status).toBe(TaskStatus.IN_REVIEW);
        expect(entered).toMatchObject({
            agentReviewPlanKey: null,
            agentReviewPlanState: null,
            agentReviewPlanAttempts: null,
        });
        expect(entered.agentReviewPlanLease).not.toBe('previous-period-lease');

        const reconcile = jest.spyOn(healthy.transitions, 'reconcileAgentReviews');
        const sweep = poll(dataSource, healthy.transitions, () => HEAD_A);
        await sweep.service.syncDuePrStatuses();
        await drain(reconcile);

        expect(reconcile).toHaveBeenCalledTimes(1);
        expect(healthy.dispatcher.enqueue).toHaveBeenCalledTimes(1);
        expect(await reload(dataSource)).toMatchObject({
            agentReviewPlanState: 'settled',
            agentReviewPlanAttempts: 1,
        });
    });
});

describe('the plan-memory rules (pure)', () => {
    const key = agentReviewPlanKey(HEAD_A, agentReviewApproverFingerprint(['app-1']));

    it('classifies every planning reason, with the deterministic / transient split the reconcile relies on', () => {
        const deterministic: AgentReviewDispatchReason[] = [
            'disabled',
            'approver-cap',
            'no-agent-approvers',
            'not-in-review',
            'no-pull-request',
            'pr-closed',
            'diff-too-large',
            'diff-incomplete',
            'diff-empty',
            'self-review',
            'budget-spent',
            'dispatch-failed',
        ];
        const transient: AgentReviewDispatchReason[] = [
            'no-work',
            'pr-unreadable',
            'head-unknown',
            'diff-unavailable',
            'reviewer-unreadable',
            'budget-unreadable',
            'error',
        ];
        const settled: AgentReviewDispatchReason[] = ['dispatched', 'already-claimed'];
        expect(Object.keys(AGENT_REVIEW_PLAN_REASON_CLASS).sort()).toEqual(
            [...deterministic, ...transient, ...settled].sort(),
        );
        for (const reason of deterministic) {
            expect([reason, AGENT_REVIEW_PLAN_REASON_CLASS[reason]]).toEqual([
                reason,
                'deterministic',
            ]);
        }
        for (const reason of transient) {
            expect([reason, AGENT_REVIEW_PLAN_REASON_CLASS[reason]]).toEqual([reason, 'transient']);
        }
    });

    it('a transient signal anywhere makes the outcome a retry, even beside a dispatch', () => {
        expect(
            classifyAgentReviewPlanOutcome({
                decisions: [{ reason: 'dispatched' }, { reason: 'reviewer-unreadable' }],
                dispatches: [{}],
            }),
        ).toEqual({ state: 'retry', reason: 'reviewer-unreadable' });
        expect(
            classifyAgentReviewPlanOutcome({
                decisions: [{ reason: 'dispatched' }, { reason: 'approver-cap' }],
                dispatches: [{}],
            }),
        ).toEqual({ state: 'settled', reason: 'dispatched' });
        expect(
            classifyAgentReviewPlanOutcome({
                decisions: [{ reason: 'self-review' }],
                dispatches: [],
            }),
        ).toEqual({ state: 'refused', reason: 'self-review' });
        expect(
            classifyAgentReviewPlanOutcome({
                decisions: [{ reason: 'already-claimed' }],
                dispatches: [],
            }),
        ).toEqual({ state: 'settled', reason: 'already-claimed' });
    });

    it('backs off exponentially and caps the delay', () => {
        expect([1, 2, 3, 4, 5, 6, 7, 8].map(agentReviewPlanRetryDelayMs)).toEqual([
            AGENT_REVIEW_PLAN_RETRY_BASE_MS,
            AGENT_REVIEW_PLAN_RETRY_BASE_MS * 2,
            AGENT_REVIEW_PLAN_RETRY_BASE_MS * 4,
            AGENT_REVIEW_PLAN_RETRY_BASE_MS * 8,
            AGENT_REVIEW_PLAN_RETRY_MAX_MS,
            AGENT_REVIEW_PLAN_RETRY_MAX_MS,
            AGENT_REVIEW_PLAN_RETRY_MAX_MS,
            AGENT_REVIEW_PLAN_RETRY_MAX_MS,
        ]);
    });

    it('gates the poll modes on the memory, and lets an entry through anything but a live lease', () => {
        const memory = (over: Record<string, unknown>) => ({
            agentReviewPlanKey: key,
            agentReviewPlanAttempts: 1,
            ...over,
        });
        for (const mode of ['reconcile', 'head-change'] as const) {
            // Never planned, or a different key: attempt 1, no time condition.
            expect(decideAgentReviewPlanAttempt({}, key, mode)).toEqual({
                attempt: 1,
                when: 'always',
            });
            expect(
                decideAgentReviewPlanAttempt(
                    memory({ agentReviewPlanState: 'refused' }),
                    'other:key',
                    mode,
                ),
            ).toEqual({ attempt: 1, when: 'always' });
            // Remembered outcomes for the same key: never.
            for (const state of ['settled', 'refused', 'exhausted']) {
                expect(
                    decideAgentReviewPlanAttempt(
                        memory({ agentReviewPlanState: state }),
                        key,
                        mode,
                    ),
                ).toBeNull();
            }
            // A retry, or a lease that may have expired: the next attempt, once due.
            for (const state of ['retry', 'in-flight']) {
                expect(
                    decideAgentReviewPlanAttempt(
                        memory({ agentReviewPlanState: state, agentReviewPlanAttempts: 2 }),
                        key,
                        mode,
                    ),
                ).toEqual({ attempt: 3, when: 'due' });
                expect(
                    decideAgentReviewPlanAttempt(
                        memory({
                            agentReviewPlanState: state,
                            agentReviewPlanAttempts: AGENT_REVIEW_PLAN_MAX_ATTEMPTS,
                        }),
                        key,
                        mode,
                    ),
                ).toBeNull();
            }
        }
        // An entry is a new entry: past any remembered outcome, unless a
        // lease on the same key is live (checked in the database).
        for (const state of ['settled', 'refused', 'exhausted', 'retry', 'in-flight']) {
            expect(
                decideAgentReviewPlanAttempt(memory({ agentReviewPlanState: state }), key, 'entry'),
            ).toEqual({
                attempt: 1,
                when: 'no-live-lease',
            });
        }
        expect(decideAgentReviewPlanAttempt({}, key, 'entry')).toEqual({
            attempt: 1,
            when: 'always',
        });
    });

    it('keys on the head AND the agent approver set, order-free', () => {
        expect(agentReviewApproverFingerprint(['x', 'y'])).toBe(
            agentReviewApproverFingerprint(['y', 'x']),
        );
        expect(agentReviewApproverFingerprint(['x'])).not.toBe(
            agentReviewApproverFingerprint(['x', 'y']),
        );
        expect(agentReviewPlanKey(HEAD_A, 'f'.repeat(16))).not.toBe(
            agentReviewPlanKey(HEAD_B, 'f'.repeat(16)),
        );
    });
});
