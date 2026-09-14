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
    return { svc, tasks, transitions };
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
