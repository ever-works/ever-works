import { TaskPrStatusService } from '../task-pr-status.service';
import { TaskLifecyclePostsService } from '../task-lifecycle-posts.service';
import { TaskStatus, type Task } from '../../entities/task.entity';
import type { TaskRepository } from '../../database/repositories/task.repository';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import type { GitFacadeService } from '../../facades/git.facade';
import type { TaskMergeGateService } from '../task-merge-gate.service';
import type { TaskLifecyclePoster } from '../task-lifecycle-poster.port';
import type { TaskThreadPoster } from '../task-thread-poster.port';

/**
 * APW-08 T26 / T54 (FR-43) — the PR-status read posts **Checks passed.** / **Checks failed:
 * {names}.** into an App Work Task's thread when the recorded verdict SETTLES, once: the verdict
 * the Task had recorded before the read against the one written now. A second sweep that reads
 * the same verdict posts nothing; a non-App Work Task never gets a post.
 */
describe('TaskPrStatusService — checks thread posts (APW-08 FR-43)', () => {
    const red = (name: string) => ({ name, status: 'completed', conclusion: 'failure' });
    const green = (name: string) => ({ name, status: 'completed', conclusion: 'success' });
    const running = (name: string) => ({ name, status: 'in_progress', conclusion: null });

    let row: Record<string, unknown>;
    let tasks: Record<string, jest.Mock>;
    let works: { findById: jest.Mock };
    let git: { getPullRequestStatus: jest.Mock };
    let chat: { post: jest.Mock };
    let mergeGate: { onPullRequestStatusRefreshed: jest.Mock };
    let order: string[];

    const snapshot = () => ({ ...row }) as unknown as Task;
    const read = (ciState: string, checks: unknown[]) =>
        git.getPullRequestStatus.mockResolvedValueOnce({
            number: 12,
            state: 'open',
            headSha: 'c'.repeat(40),
            ciState,
            checks,
        });

    function service(kind = 'app', lifecycle?: TaskLifecyclePoster) {
        works.findById.mockResolvedValue({
            id: 'work-1',
            kind,
            gitProvider: 'github',
            taskIsolationBaseBranch: null,
            getRepoOwner: () => 'acme',
            getDataRepo: () => 'bookings',
        });
        const poster =
            lifecycle ??
            new TaskLifecyclePostsService(
                works as unknown as WorkRepository,
                { findById: jest.fn() } as unknown as AgentRunRepository,
                chat as unknown as TaskThreadPoster,
            );
        return new TaskPrStatusService(
            tasks as unknown as TaskRepository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
            undefined,
            mergeGate as unknown as TaskMergeGateService,
            undefined,
            undefined,
            undefined,
            undefined,
            poster,
        );
    }

    const sweep = (svc: TaskPrStatusService) => svc.syncDuePrStatuses({ staleSeconds: 0 });
    const keys = () => chat.post.mock.calls.map((call) => call[1].messageKey);

    beforeEach(() => {
        order = [];
        row = {
            id: 'task-1',
            userId: 'user-1',
            slug: 'T-118',
            workId: 'work-1',
            agentId: 'agent-wren',
            status: TaskStatus.IN_REVIEW,
            branchRef: 'task/t-118',
            branchState: 'pr-open',
            prNumber: 12,
            prUrl: 'https://github.com/acme/bookings/pull/12',
            prState: 'open',
            ciState: null,
            prChecks: null,
            ciCheckedAt: null,
        };
        tasks = {
            findDuePrStatusSync: jest.fn(async () => [snapshot()]),
            findByIdAndUser: jest.fn(async () => snapshot()),
            updatePrStatusCache: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
                Object.assign(row, patch);
            }),
            updateById: jest.fn().mockResolvedValue(undefined),
            recordCiHead: jest.fn().mockResolvedValue(true),
            findById: jest.fn(async () => snapshot()),
        };
        works = { findById: jest.fn() };
        git = { getPullRequestStatus: jest.fn() };
        chat = {
            post: jest.fn(async (_userId: string, message: { messageKey: string }) => {
                order.push(message.messageKey);
                return { id: 'm' };
            }),
        };
        mergeGate = {
            onPullRequestStatusRefreshed: jest.fn(async () => {
                order.push('merge-gate');
                return { action: 'skipped' };
            }),
        };
    });

    it('posts Checks passed once when the verdict settles green, and not again on an unchanged sweep', async () => {
        const svc = service();
        read('pending', [running('lint')]);
        read('passing', [green('lint')]);
        read('passing', [green('lint')]);
        for (let i = 0; i < 3; i += 1) await sweep(svc);

        expect(keys()).toEqual(['deliveryPosts.checksPassed']);
        expect(chat.post).toHaveBeenCalledWith('user-1', {
            taskId: 'task-1',
            authorType: 'agent',
            authorId: 'agent-wren',
            body: 'Checks passed.',
            messageKey: 'deliveryPosts.checksPassed',
            messageParams: null,
        });
    });

    it('posts Checks failed with the failing names, once, then passed after the fix', async () => {
        const svc = service();
        read('failing', [red('lint'), green('build'), red('e2e')]);
        read('failing', [red('lint'), green('build'), red('e2e')]);
        read('pending', [running('lint')]);
        read('passing', [green('lint')]);
        for (let i = 0; i < 4; i += 1) await sweep(svc);

        expect(
            chat.post.mock.calls.map((call) => [call[1].messageKey, call[1].messageParams]),
        ).toEqual([
            ['deliveryPosts.checksFailed', { names: 'lint, e2e' }],
            ['deliveryPosts.checksPassed', null],
        ]);
        expect(chat.post.mock.calls[0][1].body).toBe('Checks failed: lint, e2e.');
    });

    it('a red the CI webhook wrote first is still posted once by the sweep', async () => {
        const svc = service();
        read('pending', [running('lint')]);
        await sweep(svc);
        // The webhook records the red verdict without the check list.
        row.ciState = 'failing';
        read('failing', [red('lint')]);
        read('failing', [red('lint')]);
        await sweep(svc);
        await sweep(svc);

        expect(keys()).toEqual(['deliveryPosts.checksFailed']);
    });

    it('the on-demand read posts on the same transition, and the sweep after it does not repeat it', async () => {
        const svc = service();
        read('passing', [green('lint')]);
        await svc.getForTask('user-1', 'task-1', { refresh: true });
        read('passing', [green('lint')]);
        await sweep(svc);

        expect(keys()).toEqual(['deliveryPosts.checksPassed']);
    });

    it('posts before the merge gate is asked, so "Checks passed." precedes any merge', async () => {
        const svc = service();
        read('passing', [green('lint')]);
        await sweep(svc);

        expect(order).toEqual(['deliveryPosts.checksPassed', 'merge-gate']);
    });

    it('a Task with no Agent gets a system post', async () => {
        row.agentId = null;
        const svc = service();
        read('passing', [green('lint')]);
        await sweep(svc);

        expect(chat.post.mock.calls[0][1]).toMatchObject({ authorType: 'system', authorId: null });
    });

    it.each([['website'], ['default']])(
        'a %s Work Task gets NO post, whatever its checks do',
        async (kind) => {
            const svc = service(kind);
            read('failing', [red('lint')]);
            read('pending', [running('lint')]);
            read('passing', [green('lint')]);
            for (let i = 0; i < 3; i += 1) await sweep(svc);

            expect(tasks.updatePrStatusCache).toHaveBeenCalledTimes(3);
            expect(chat.post).not.toHaveBeenCalled();
        },
    );

    it('a poster that throws never fails the refresh or the sweep', async () => {
        const throwing: TaskLifecyclePoster = {
            post: jest.fn().mockRejectedValue(new Error('boom')),
        };
        const svc = service('app', throwing);
        read('passing', [green('lint')]);
        const summary = await sweep(svc);

        expect(throwing.post).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ scanned: 1, refreshed: 1, failed: 0 });
        expect(mergeGate.onPullRequestStatusRefreshed).toHaveBeenCalledTimes(1);
    });

    // APW-08 T16 (FR-16) — on an App Work, a failing ADVISORY `Ever Works check: {name}` leg
    // (read at the PR base through `TASK_APP_CHECKS`) is not a failure of the gate, so it is
    // never in **Checks failed: {names}.** — and alone it is **Checks passed.**
    describe('advisory App legs (APW-08 T16)', () => {
        const ADVISORY = 'Ever Works check: e2e';
        const appChecks = {
            resumeBudget: jest.fn(async () => 2),
            advisoryLegs: jest.fn(async () => new Set([ADVISORY])),
            escalateExhausted: jest.fn(async () => false),
        };
        const withAppChecks = () => {
            service();
            return new TaskPrStatusService(
                tasks as unknown as TaskRepository,
                works as unknown as WorkRepository,
                git as unknown as GitFacadeService,
                undefined,
                mergeGate as unknown as TaskMergeGateService,
                undefined,
                undefined,
                undefined,
                undefined,
                new TaskLifecyclePostsService(
                    works as unknown as WorkRepository,
                    { findById: jest.fn() } as unknown as AgentRunRepository,
                    chat as unknown as TaskThreadPoster,
                ),
                appChecks,
            );
        };

        it('names only the required legs when an advisory leg fails beside them', async () => {
            const svc = withAppChecks();
            read('failing', [red('Ever Works check: type-check'), red(ADVISORY)]);
            await sweep(svc);

            expect(chat.post.mock.calls.map((call) => call[1].body)).toEqual([
                'Checks failed: Ever Works check: type-check.',
            ]);
        });

        it('posts Checks passed when the only failing leg is advisory', async () => {
            const svc = withAppChecks();
            read('failing', [green('Ever Works check: type-check'), red(ADVISORY)]);
            await sweep(svc);

            expect(keys()).toEqual(['deliveryPosts.checksPassed']);
            expect(row.ciState).toBe('passing');
        });

        it('another kind with the same port bound is posted to and named exactly as before', async () => {
            const svc = withAppChecks();
            works.findById.mockResolvedValue({
                id: 'work-1',
                kind: 'website',
                gitProvider: 'github',
                taskIsolationBaseBranch: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'bookings',
            });
            read('failing', [green('Ever Works check: type-check'), red(ADVISORY)]);
            await sweep(svc);

            expect(row.ciState).toBe('failing');
            expect(appChecks.advisoryLegs).not.toHaveBeenCalled();
            expect(chat.post).not.toHaveBeenCalled();
        });

        beforeEach(() => appChecks.advisoryLegs.mockClear());
    });

    it('without a bound poster a refresh behaves exactly as before (nothing posted, nothing read)', async () => {
        works.findById.mockResolvedValue({
            id: 'work-1',
            kind: 'app',
            gitProvider: 'github',
            taskIsolationBaseBranch: null,
            getRepoOwner: () => 'acme',
            getDataRepo: () => 'bookings',
        });
        const svc = new TaskPrStatusService(
            tasks as unknown as TaskRepository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
        );
        read('passing', [green('lint')]);
        const summary = await sweep(svc);

        expect(summary).toMatchObject({ refreshed: 1, failed: 0 });
        expect(chat.post).not.toHaveBeenCalled();
        expect(works.findById).toHaveBeenCalledTimes(1);
    });
});
