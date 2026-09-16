import { TaskPrStatusService } from '../task-pr-status.service';
import { TaskStatus, type Task } from '../../entities/task.entity';

/**
 * Reviewer agent stage (slice AD, EW-811) — a PUSH while the Task sits in
 * `in_review` gets reviewed.
 *
 * The finding: the review hook fired only on ENTRY to `in_review`. Slice
 * AC's CI fix loop resumes the implementation run and pushes a new commit
 * without moving the Task out of `in_review`, so the new head was never
 * reviewed by anyone; the review in flight for the old head was refused
 * `stale-head` and the approver stayed `pending` for good. The PR-status
 * poll is where the platform learns a head moved, so that is where the new
 * commit's review is requested. Cost stays bounded by the review ledger
 * (one claim per reviewer per head, lifetime budget), which the service
 * spec pins.
 */

const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        userId: 'user-1',
        slug: 't-1',
        status: TaskStatus.IN_REVIEW,
        workId: 'work-1',
        branchRef: 'task/t-1',
        branchState: 'pr-open',
        prNumber: 41,
        prUrl: 'https://example.invalid/pr/41',
        prState: 'open',
        ciState: 'pending',
        ciCheckedAt: null,
        prChecks: null,
        prHeadSha: OLD_HEAD,
        ciHeadSha: OLD_HEAD,
        ...over,
    } as unknown as Task;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function harness(task: Task, providerHead: string | null) {
    const tasks = {
        findDuePrStatusSync: jest.fn().mockResolvedValue([task]),
        updatePrStatusCache: jest.fn().mockResolvedValue(undefined),
        updateById: jest.fn().mockResolvedValue(undefined),
        recordCiHead: jest.fn().mockResolvedValue(true),
    };
    const works = {
        findById: jest.fn().mockResolvedValue({
            id: 'work-1',
            gitProvider: 'github',
            taskIsolationBaseBranch: 'develop',
            getRepoOwner: () => 'acme',
            getDataRepo: () => 'widgets',
        }),
    };
    const git = {
        getPullRequestStatus: jest.fn().mockResolvedValue({
            number: 41,
            state: 'open',
            merged: false,
            headSha: providerHead,
            ciState: 'pending',
            checks: [],
        }),
    };
    const transitions = {
        transition: jest.fn(),
        requestAgentReviews: jest.fn(async () => undefined),
    };
    const svc = new TaskPrStatusService(tasks as any, works as any, git as any, transitions as any);
    return { svc, tasks, transitions, git };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the PR-status poll requests a review when an in_review head moves', () => {
    it('requests reviews for the NEW head, with the Task already carrying it', async () => {
        const h = harness(makeTask(), NEW_HEAD);
        await h.svc.syncDuePrStatuses();
        await settle();

        expect(h.transitions.requestAgentReviews).toHaveBeenCalledTimes(1);
        const [task] = h.transitions.requestAgentReviews.mock.calls[0] as unknown as [Task];
        expect(task.prHeadSha).toBe(NEW_HEAD);
        expect(task.status).toBe(TaskStatus.IN_REVIEW);
    });

    it('requests nothing when the head did not move — a routine poll buys no review', async () => {
        const h = harness(makeTask(), OLD_HEAD);
        await h.svc.syncDuePrStatuses();
        await settle();
        expect(h.transitions.requestAgentReviews).not.toHaveBeenCalled();
    });

    it('requests nothing for a Task that is not in review', async () => {
        const h = harness(makeTask({ status: TaskStatus.IN_PROGRESS }), NEW_HEAD);
        await h.svc.syncDuePrStatuses();
        await settle();
        expect(h.transitions.requestAgentReviews).not.toHaveBeenCalled();
    });

    it('requests nothing when the provider reports no parseable head', async () => {
        const h = harness(makeTask(), 'not-a-sha');
        await h.svc.syncDuePrStatuses();
        await settle();
        expect(h.transitions.requestAgentReviews).not.toHaveBeenCalled();
    });

    it('a review hiccup never fails the status refresh', async () => {
        const h = harness(makeTask(), NEW_HEAD);
        h.transitions.requestAgentReviews.mockRejectedValue(new Error('boom'));
        const summary = await h.svc.syncDuePrStatuses();
        await settle();
        expect(summary.failed).toBe(0);
        expect(summary.refreshed).toBe(1);
    });
});

/**
 * CodeRabbit CR-2 on PR #2419 — the poll also RECONCILES an `in_review` Task
 * whose head did not move, because planning that never happened (a process
 * killed after `in_review` was persisted, a transient failure) has no other
 * recovery. The routine poll above still requests nothing: the reconcile is a
 * separate, memory-bounded call (see `task-agent-review.reconcile.spec.ts`
 * for what it does and does not buy).
 */
describe('the PR-status poll reconciles an in_review Task whose head did not move', () => {
    function reconcilingHarness(task: Task, providerHead: string | null) {
        const h = harness(task, providerHead);
        const transitions = Object.assign(h.transitions, {
            reconcileAgentReviews: jest.fn(async () => undefined),
        });
        return { ...h, transitions };
    }

    it('reconciles, and does not re-request, when the head is unchanged', async () => {
        const h = reconcilingHarness(makeTask(), OLD_HEAD);
        await h.svc.syncDuePrStatuses();
        await settle();
        expect(h.transitions.requestAgentReviews).not.toHaveBeenCalled();
        expect(h.transitions.reconcileAgentReviews).toHaveBeenCalledTimes(1);
        const [task] = h.transitions.reconcileAgentReviews.mock.calls[0] as unknown as [Task];
        expect(task).toMatchObject({
            id: 'task-1',
            status: TaskStatus.IN_REVIEW,
            prHeadSha: OLD_HEAD,
        });
    });

    it('does not reconcile when the head moved — that is a request, handled once', async () => {
        const h = reconcilingHarness(makeTask(), NEW_HEAD);
        await h.svc.syncDuePrStatuses();
        await settle();
        expect(h.transitions.requestAgentReviews).toHaveBeenCalledTimes(1);
        expect(h.transitions.reconcileAgentReviews).not.toHaveBeenCalled();
    });

    it('does not reconcile a Task outside review, or one without a parseable head', async () => {
        const out = reconcilingHarness(makeTask({ status: TaskStatus.IN_PROGRESS }), OLD_HEAD);
        await out.svc.syncDuePrStatuses();
        const headless = reconcilingHarness(makeTask(), 'not-a-sha');
        await headless.svc.syncDuePrStatuses();
        await settle();
        expect(out.transitions.reconcileAgentReviews).not.toHaveBeenCalled();
        expect(headless.transitions.reconcileAgentReviews).not.toHaveBeenCalled();
    });

    /**
     * Adversarial review of CR-2, finding 4 — the refresh that first sees a
     * merged or closed pull request used to reconcile too. Planning refuses
     * that (`pr-closed`) only after a Work read and a provider read of its
     * own, so the reconcile bought exactly one wasted provider call per
     * merged Task, racing the merge completion.
     */
    it('does not reconcile when this read reports the pull request merged or closed — a draft still is', async () => {
        const reported = (state: string) => ({
            number: 41,
            state,
            merged: state === 'merged',
            headSha: OLD_HEAD,
            ciState: 'passing',
            checks: [],
        });
        for (const state of ['merged', 'closed']) {
            const h = reconcilingHarness(makeTask(), OLD_HEAD);
            h.git.getPullRequestStatus.mockResolvedValue(reported(state));
            await h.svc.syncDuePrStatuses();
            await settle();
            expect({
                state,
                reconciles: h.transitions.reconcileAgentReviews.mock.calls.length,
            }).toEqual({ state, reconciles: 0 });
        }
        const draft = reconcilingHarness(makeTask(), OLD_HEAD);
        draft.git.getPullRequestStatus.mockResolvedValue(reported('draft'));
        await draft.svc.syncDuePrStatuses();
        await settle();
        expect(draft.transitions.reconcileAgentReviews).toHaveBeenCalledTimes(1);
    });

    it('a reconcile hiccup never fails the status refresh', async () => {
        const h = reconcilingHarness(makeTask(), OLD_HEAD);
        h.transitions.reconcileAgentReviews.mockRejectedValue(new Error('boom'));
        const summary = await h.svc.syncDuePrStatuses();
        await settle();
        expect(summary.failed).toBe(0);
        expect(summary.refreshed).toBe(1);
    });
});
