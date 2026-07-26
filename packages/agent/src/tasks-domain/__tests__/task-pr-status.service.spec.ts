import { NotFoundException } from '@nestjs/common';
import { PR_STATUS_REFRESH_FLOOR_SECONDS, TaskPrStatusService } from '../task-pr-status.service';
import { TaskStatus } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';
import type { TaskRepository } from '../../database/repositories/task.repository';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { GitFacadeService } from '../../facades/git.facade';
import type { TaskTransitionService } from '../task-transition.service';

/**
 * PR insights (kanban run cockpit, plan 04 M5/M6/M7) — the sync + read
 * service behind the board's review pill, the diff sheet, and the
 * merged-PR landing.
 *
 * What these tests pin down (the rules that cost real money or real
 * correctness if they regress):
 *
 *  1. the refresh FLOOR — a cached verdict younger than the floor is
 *     served without touching the provider;
 *  2. TERMINAL PR states are never re-read, at any age;
 *  3. single-flight — concurrent refreshes for one Task make ONE call;
 *  4. owner scope — a Task the caller doesn't own 404s on both reads;
 *  5. the merged → done landing goes through TaskTransitionService and
 *     a refusal leaves the Task where it was;
 *  6. per-Task failure isolation in the sweep.
 */
describe('TaskPrStatusService', () => {
    const USER = 'user-1';
    const WORK = 'work-1';

    let tasks: {
        findByIdAndUser: jest.Mock;
        findDuePrStatusSync: jest.Mock;
        updatePrStatusCache: jest.Mock;
        updateById: jest.Mock;
    };
    let works: { findById: jest.Mock };
    let git: {
        getPullRequestStatus: jest.Mock;
        getPullRequestDiff: jest.Mock;
        getCompareDiff: jest.Mock;
    };
    let transitions: { transition: jest.Mock };
    let service: TaskPrStatusService;

    const makeTask = (overrides: Partial<Task> = {}): Task =>
        ({
            id: 'task-1',
            userId: USER,
            slug: 't-1',
            status: TaskStatus.IN_REVIEW,
            workId: WORK,
            branchRef: 'task/t-1-abc',
            branchState: 'pr-open',
            prNumber: 41,
            prUrl: 'https://example.invalid/pr/41',
            prState: 'open',
            ciState: 'pending',
            ciCheckedAt: null,
            prChecks: null,
            ...overrides,
        }) as unknown as Task;

    const openStatus = {
        number: 41,
        state: 'open' as const,
        merged: false,
        mergeable: true,
        headSha: 'abc',
        reviewDecision: null,
        ciState: 'passing' as const,
        checks: [{ name: 'build', status: 'completed' as const, conclusion: 'success' as const }],
        url: 'https://example.invalid/pr/41',
    };

    beforeEach(() => {
        tasks = {
            findByIdAndUser: jest.fn(),
            findDuePrStatusSync: jest.fn().mockResolvedValue([]),
            updatePrStatusCache: jest.fn().mockResolvedValue(undefined),
            updateById: jest.fn().mockResolvedValue(undefined),
        };
        works = {
            findById: jest.fn().mockResolvedValue({
                id: WORK,
                gitProvider: 'github',
                taskIsolationBaseBranch: 'develop',
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'widgets',
            }),
        };
        git = {
            getPullRequestStatus: jest.fn().mockResolvedValue(openStatus),
            getPullRequestDiff: jest.fn().mockResolvedValue({
                files: [],
                truncated: false,
                totalFiles: 0,
                totalAdditions: 0,
                totalDeletions: 0,
                patchBytes: 0,
            }),
            getCompareDiff: jest.fn().mockResolvedValue({
                files: [],
                truncated: false,
                totalFiles: 0,
                totalAdditions: 0,
                totalDeletions: 0,
                patchBytes: 0,
            }),
        };
        transitions = { transition: jest.fn().mockResolvedValue(undefined) };
        service = new TaskPrStatusService(
            tasks as unknown as TaskRepository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
            transitions as unknown as TaskTransitionService,
        );
    });

    // ── Throttling ───────────────────────────────────────────────────

    it('serves the cache without a provider call while inside the refresh floor', async () => {
        tasks.findByIdAndUser.mockResolvedValue(
            makeTask({ ciCheckedAt: new Date(Date.now() - 5_000), ciState: 'failing' }),
        );

        const view = await service.getForTask(USER, 'task-1');

        expect(git.getPullRequestStatus).not.toHaveBeenCalled();
        expect(view.cached).toBe(true);
        expect(view.ciState).toBe('failing');
    });

    it('refreshes once the cache is older than the floor', async () => {
        tasks.findByIdAndUser.mockResolvedValue(
            makeTask({
                ciCheckedAt: new Date(Date.now() - (PR_STATUS_REFRESH_FLOOR_SECONDS + 10) * 1000),
            }),
        );

        const view = await service.getForTask(USER, 'task-1');

        expect(git.getPullRequestStatus).toHaveBeenCalledWith('acme', 'widgets', 41, {
            userId: USER,
            providerId: 'github',
            workId: WORK,
        });
        expect(tasks.updatePrStatusCache).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({ prState: 'open', ciState: 'passing' }),
        );
        expect(view.ciState).toBe('passing');
    });

    it('honours an explicit refresh even inside the floor', async () => {
        tasks.findByIdAndUser.mockResolvedValue(makeTask({ ciCheckedAt: new Date() }));

        await service.getForTask(USER, 'task-1', { refresh: true });

        expect(git.getPullRequestStatus).toHaveBeenCalledTimes(1);
    });

    it('never re-reads a merged PR, however stale the cache', async () => {
        tasks.findByIdAndUser.mockResolvedValue(
            makeTask({ prState: 'merged', ciCheckedAt: new Date(0) }),
        );

        const view = await service.getForTask(USER, 'task-1', { refresh: true });

        expect(git.getPullRequestStatus).not.toHaveBeenCalled();
        expect(view.prState).toBe('merged');
    });

    it('never re-reads a closed PR either', async () => {
        tasks.findByIdAndUser.mockResolvedValue(
            makeTask({ prState: 'closed', ciCheckedAt: new Date(0) }),
        );
        await service.getForTask(USER, 'task-1', { refresh: true });
        expect(git.getPullRequestStatus).not.toHaveBeenCalled();
    });

    it('short-circuits a Task with no pull request', async () => {
        tasks.findByIdAndUser.mockResolvedValue(makeTask({ prNumber: null, prState: null }));

        const view = await service.getForTask(USER, 'task-1');

        expect(git.getPullRequestStatus).not.toHaveBeenCalled();
        expect(view.prNumber).toBeNull();
        expect(view.cached).toBe(true);
    });

    it('single-flights concurrent refreshes for one Task', async () => {
        tasks.findByIdAndUser.mockResolvedValue(makeTask({ ciCheckedAt: new Date(0) }));
        let resolveStatus: (value: unknown) => void = () => undefined;
        git.getPullRequestStatus.mockReturnValue(
            new Promise((resolve) => {
                resolveStatus = resolve;
            }),
        );

        const first = service.getForTask(USER, 'task-1', { refresh: true });
        const second = service.getForTask(USER, 'task-1', { refresh: true });
        resolveStatus(openStatus);
        await Promise.all([first, second]);

        expect(git.getPullRequestStatus).toHaveBeenCalledTimes(1);
    });

    it('keeps the previous verdict when the provider read fails', async () => {
        tasks.findByIdAndUser.mockResolvedValue(
            makeTask({ ciCheckedAt: new Date(0), ciState: 'failing' }),
        );
        git.getPullRequestStatus.mockRejectedValue(new Error('rate limited'));

        const view = await service.getForTask(USER, 'task-1', { refresh: true });

        expect(view.ciState).toBe('failing');
        expect(tasks.updatePrStatusCache).not.toHaveBeenCalled();
    });

    it('stamps the read time (not the state) when the PR vanished upstream', async () => {
        tasks.findByIdAndUser.mockResolvedValue(makeTask({ ciCheckedAt: new Date(0) }));
        git.getPullRequestStatus.mockResolvedValue(null);

        await service.getForTask(USER, 'task-1', { refresh: true });

        expect(tasks.updatePrStatusCache).toHaveBeenCalledWith(
            'task-1',
            expect.objectContaining({ ciCheckedAt: expect.any(Date) }),
        );
        const patch = tasks.updatePrStatusCache.mock.calls[0][1];
        expect(patch.prState).toBeUndefined();
    });

    it('mirrors a landed PR onto the branch chip', async () => {
        tasks.findByIdAndUser.mockResolvedValue(makeTask({ ciCheckedAt: new Date(0) }));
        git.getPullRequestStatus.mockResolvedValue({
            ...openStatus,
            state: 'merged',
            merged: true,
        });

        await service.getForTask(USER, 'task-1', { refresh: true });

        expect(tasks.updateById).toHaveBeenCalledWith('task-1', { branchState: 'merged' });
    });

    // ── Owner scope ──────────────────────────────────────────────────

    it('404s the status read for a Task the caller does not own', async () => {
        tasks.findByIdAndUser.mockResolvedValue(null);
        await expect(service.getForTask('someone-else', 'task-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('404s the diff read for a Task the caller does not own', async () => {
        tasks.findByIdAndUser.mockResolvedValue(null);
        await expect(service.getDiffForTask('someone-else', 'task-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(git.getPullRequestDiff).not.toHaveBeenCalled();
    });

    // ── Diff ─────────────────────────────────────────────────────────

    it('prefers the pull request as the diff source and forwards the caps', async () => {
        tasks.findByIdAndUser.mockResolvedValue(makeTask());

        const view = await service.getDiffForTask(USER, 'task-1', {
            maxFiles: 5,
            maxBytes: 1024,
        });

        expect(view.source).toBe('pull-request');
        expect(git.getPullRequestDiff).toHaveBeenCalledWith(
            'acme',
            'widgets',
            41,
            { maxFiles: 5, maxBytes: 1024 },
            expect.objectContaining({ workId: WORK }),
        );
        expect(git.getCompareDiff).not.toHaveBeenCalled();
    });

    it('falls back to base...head compare for a pushed branch with no PR', async () => {
        tasks.findByIdAndUser.mockResolvedValue(
            makeTask({ prNumber: null, prUrl: null, branchState: 'pushed' }),
        );

        const view = await service.getDiffForTask(USER, 'task-1');

        expect(view.source).toBe('compare');
        expect(git.getCompareDiff).toHaveBeenCalledWith(
            'acme',
            'widgets',
            'develop',
            'task/t-1-abc',
            expect.any(Object),
            expect.any(Object),
        );
    });

    it('404s when the Task has neither a branch nor a PR', async () => {
        tasks.findByIdAndUser.mockResolvedValue(
            makeTask({ prNumber: null, branchRef: null, branchState: null }),
        );
        await expect(service.getDiffForTask(USER, 'task-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    // ── Sync sweep ───────────────────────────────────────────────────

    it('refreshes the due batch and reports the summary', async () => {
        tasks.findDuePrStatusSync.mockResolvedValue([
            makeTask({ id: 'task-a' }),
            makeTask({ id: 'task-b' }),
        ]);

        const summary = await service.syncDuePrStatuses({ limit: 10, staleSeconds: 60 });

        expect(tasks.findDuePrStatusSync).toHaveBeenCalledWith(expect.any(Date), 10);
        expect(summary).toMatchObject({ scanned: 2, refreshed: 2, merged: 0, failed: 0 });
    });

    it('lands a merged PR on `done` through the transition service', async () => {
        tasks.findDuePrStatusSync.mockResolvedValue([makeTask({ id: 'task-a' })]);
        git.getPullRequestStatus.mockResolvedValue({
            ...openStatus,
            state: 'merged',
            merged: true,
        });

        const summary = await service.syncDuePrStatuses();

        expect(transitions.transition).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-a' }),
            TaskStatus.DONE,
            { actorType: 'agent' },
        );
        expect(summary).toMatchObject({ merged: 1, completed: 1 });
    });

    it('leaves the Task in review when the approver gate refuses the landing', async () => {
        tasks.findDuePrStatusSync.mockResolvedValue([makeTask({ id: 'task-a' })]);
        git.getPullRequestStatus.mockResolvedValue({
            ...openStatus,
            state: 'merged',
            merged: true,
        });
        transitions.transition.mockRejectedValue(new Error('approvals pending'));

        const summary = await service.syncDuePrStatuses();

        expect(summary).toMatchObject({ merged: 1, completed: 0, failed: 0 });
    });

    it('does not move a Task that is blocked or still in backlog', async () => {
        tasks.findDuePrStatusSync.mockResolvedValue([
            makeTask({ id: 'task-a', status: TaskStatus.BLOCKED }),
        ]);
        git.getPullRequestStatus.mockResolvedValue({
            ...openStatus,
            state: 'merged',
            merged: true,
        });

        const summary = await service.syncDuePrStatuses();

        expect(transitions.transition).not.toHaveBeenCalled();
        expect(summary).toMatchObject({ merged: 1, completed: 0 });
    });

    it('isolates a per-Task failure so the rest of the batch still syncs', async () => {
        tasks.findDuePrStatusSync.mockResolvedValue([
            makeTask({ id: 'task-a' }),
            makeTask({ id: 'task-b' }),
        ]);
        git.getPullRequestStatus
            .mockRejectedValueOnce(new Error('403 rate limited'))
            .mockResolvedValueOnce(openStatus);

        const summary = await service.syncDuePrStatuses();

        expect(summary).toMatchObject({ scanned: 2, refreshed: 1, failed: 1 });
    });

    it('does nothing at all when no git facade is bound in this runtime', async () => {
        const bare = new TaskPrStatusService(
            tasks as unknown as TaskRepository,
            works as unknown as WorkRepository,
        );
        await expect(bare.syncDuePrStatuses()).resolves.toMatchObject({
            scanned: 0,
            refreshed: 0,
        });
        expect(tasks.findDuePrStatusSync).not.toHaveBeenCalled();
    });
});
