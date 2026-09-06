import type { Task } from '@src/entities/task.entity';
import { PROMOTION_TASK_LABEL } from '@ever-works/contracts';
import { TaskPrStatusService } from '../task-pr-status.service';

/**
 * Release promotion lane (self-build slice AI, EW-808) — the seam
 * `TaskPrStatusService` gives the lane, and the two properties that seam
 * has to have.
 *
 *   1. **Ordering.** The promotion watcher runs BEFORE the merge gate, on
 *      the same live status, because the gate's promotion guard is a pure
 *      read of what the watcher just recorded. Reversed, the guard would
 *      always be judging the PREVIOUS sweep's head.
 *   2. **Unconditional.** The watcher runs whatever CI says. A promotion
 *      has to be legible even when it can never merge — an operator
 *      watching a red promotion should see the gate's verdict, not
 *      silence.
 *
 * Plus the standing rule for everything on this seam: it is best-effort,
 * and it can never fail a status refresh for the Tasks behind it.
 */
describe('TaskPrStatusService — promotion lane seam', () => {
    const USER = 'user-1';
    const WORK = 'work-1';

    const task = (over: Record<string, unknown> = {}) =>
        ({
            id: 'task-1',
            userId: USER,
            workId: WORK,
            slug: 'T-9',
            prNumber: 41,
            prUrl: 'https://example.invalid/pr/41',
            prState: 'open',
            ciState: 'pending',
            ciCheckedAt: null,
            prChecks: null,
            labels: [PROMOTION_TASK_LABEL],
            ...over,
        }) as unknown as Task;

    const status = (over: Record<string, unknown> = {}) => ({
        number: 41,
        state: 'open' as const,
        merged: false,
        mergeable: true,
        headSha: 'abc1234',
        reviewDecision: null,
        ciState: 'passing' as const,
        checksComplete: true,
        checks: [],
        url: 'https://example.invalid/pr/41',
        ...over,
    });

    function build(over: { promotionLane?: unknown } = {}) {
        const calls: string[] = [];
        const tasks = {
            findByIdAndUser: jest.fn(),
            findDuePrStatusSync: jest.fn().mockResolvedValue([]),
            updatePrStatusCache: jest.fn().mockResolvedValue(undefined),
            updateById: jest.fn().mockResolvedValue(undefined),
        };
        const works = {
            findById: jest.fn().mockResolvedValue({
                id: WORK,
                gitProvider: 'github',
                taskIsolationBaseBranch: 'develop',
                getRepoOwner: () => 'ever-works',
                getDataRepo: () => 'ever-works',
            }),
        };
        const git = { getPullRequestStatus: jest.fn().mockResolvedValue(status()) };
        const transitions = { transition: jest.fn().mockResolvedValue(undefined) };
        const mergeGate = {
            onPullRequestStatusRefreshed: jest.fn().mockImplementation(async () => {
                calls.push('merge-gate');
                return { action: 'skipped', reason: 'no-agent' };
            }),
        };
        const promotionLane =
            over.promotionLane === null
                ? undefined
                : (over.promotionLane ?? {
                      onPullRequestStatusRefreshed: jest.fn().mockImplementation(async () => {
                          calls.push('promotion');
                          return { action: 'observed' };
                      }),
                  });
        const service = new TaskPrStatusService(
            tasks as never,
            works as never,
            git as never,
            transitions as never,
            mergeGate as never,
            promotionLane as never,
        );
        return { service, tasks, git, mergeGate, promotionLane, calls };
    }

    it('drives the promotion watcher BEFORE the merge gate, on the same live status', async () => {
        const harness = build();
        harness.tasks.findByIdAndUser.mockResolvedValue(task());

        await harness.service.getForTask(USER, 'task-1', { refresh: true });

        expect(harness.calls).toEqual(['promotion', 'merge-gate']);
        const live = harness.git.getPullRequestStatus.mock.results[0].value;
        await expect(live).resolves.toBeDefined();
        expect(
            (harness.promotionLane as { onPullRequestStatusRefreshed: jest.Mock })
                .onPullRequestStatusRefreshed,
        ).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), await live);
    });

    it.each([
        ['failing CI', { ciState: 'failing' }],
        ['an incomplete check read', { checksComplete: false }],
        ['a draft pull request', { state: 'draft' }],
    ])('still runs the watcher for %s, where the merge gate stands down', async (_label, over) => {
        const harness = build();
        harness.tasks.findByIdAndUser.mockResolvedValue(task());
        harness.git.getPullRequestStatus.mockResolvedValue(status(over));

        await harness.service.getForTask(USER, 'task-1', { refresh: true });

        expect(
            (harness.promotionLane as { onPullRequestStatusRefreshed: jest.Mock })
                .onPullRequestStatusRefreshed,
        ).toHaveBeenCalledTimes(1);
    });

    it('never lets a throwing watcher fail the status refresh', async () => {
        const harness = build({
            promotionLane: {
                onPullRequestStatusRefreshed: jest.fn().mockRejectedValue(new Error('db down')),
            },
        });
        harness.tasks.findByIdAndUser.mockResolvedValue(task());

        const view = await harness.service.getForTask(USER, 'task-1', { refresh: true });

        expect(view.ciState).toBe('passing');
        expect(harness.tasks.updatePrStatusCache).toHaveBeenCalled();
        // And the merge gate still ran, so one Task's promotion problem
        // cannot stall every other Task's merge evaluation.
        expect(harness.mergeGate.onPullRequestStatusRefreshed).toHaveBeenCalled();
    });

    it('behaves exactly as before when no watcher is bound', async () => {
        const harness = build({ promotionLane: null });
        harness.tasks.findByIdAndUser.mockResolvedValue(task());

        const view = await harness.service.getForTask(USER, 'task-1', { refresh: true });

        expect(view.ciState).toBe('passing');
        expect(harness.calls).toEqual(['merge-gate']);
    });

    it('runs the watcher for a Task the provider no longer has a status for — never', async () => {
        // A deleted pull request records the read and stops; there is no
        // live status to judge a promotion against.
        const harness = build();
        harness.tasks.findByIdAndUser.mockResolvedValue(task());
        harness.git.getPullRequestStatus.mockResolvedValue(null);

        await harness.service.getForTask(USER, 'task-1', { refresh: true });

        expect(
            (harness.promotionLane as { onPullRequestStatusRefreshed: jest.Mock })
                .onPullRequestStatusRefreshed,
        ).not.toHaveBeenCalled();
    });
});
