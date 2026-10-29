import { TaskPrStatusService } from '../task-pr-status.service';
import { TaskStatus } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';
import type { TaskRepository } from '../../database/repositories/task.repository';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { GitFacadeService } from '../../facades/git.facade';
import type { TaskTransitionService } from '../task-transition.service';
import type { TaskDeliveryTracker } from '../task-delivery.port';

/**
 * APW-08 T22 (FR-29, FR-30, FR-33; ACC-08-23, ACC-08-43 sweep half) — the PR-status sweep's
 * merge hook. A merge the delivery chain tracks is recorded and does NOT complete the Task; every
 * other merge completes exactly as before. `refreshTask` now answers `{ task, status }` so the
 * hook sees the provider's merge commit and base branch (APW08-G10).
 */
describe('TaskPrStatusService — delivery merge hook (APW-08 T22)', () => {
    const MERGE_SHA = '3f9c2ab000000000000000000000000000000001';

    const makeTask = (overrides: Partial<Task> = {}): Task =>
        ({
            id: 'task-1',
            userId: 'user-1',
            slug: 'T-1',
            status: TaskStatus.IN_REVIEW,
            workId: 'work-1',
            branchRef: 'task/t-1',
            branchState: 'pr-open',
            prNumber: 7,
            prUrl: 'https://example.invalid/pr/7',
            prState: 'open',
            ciState: 'passing',
            ciCheckedAt: null,
            prChecks: null,
            ...overrides,
        }) as unknown as Task;

    const mergedStatus = {
        number: 7,
        state: 'merged' as const,
        merged: true,
        headSha: 'feedface',
        baseRef: 'production',
        mergeCommitSha: MERGE_SHA,
        ciState: 'passing' as const,
        checks: [],
    };

    let tasks: {
        findByIdAndUser: jest.Mock;
        findDuePrStatusSync: jest.Mock;
        updatePrStatusCache: jest.Mock;
        updateById: jest.Mock;
        recordCiHead: jest.Mock;
    };
    let works: { findById: jest.Mock };
    let git: { getPullRequestStatus: jest.Mock };
    let transitions: { transition: jest.Mock };
    let tracker: { isDeliveryTracked: jest.Mock; recordMerge: jest.Mock };

    function service(bound: { tracker: TaskDeliveryTracker | undefined } = { tracker: tracker as never }) {
        const withTracker = bound.tracker;
        return new TaskPrStatusService(
            tasks as unknown as TaskRepository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
            transitions as unknown as TaskTransitionService,
            undefined,
            undefined,
            undefined,
            undefined,
            withTracker,
        );
    }

    beforeEach(() => {
        tasks = {
            findByIdAndUser: jest.fn(),
            findDuePrStatusSync: jest.fn().mockResolvedValue([makeTask()]),
            updatePrStatusCache: jest.fn().mockResolvedValue(undefined),
            updateById: jest.fn().mockResolvedValue(undefined),
            recordCiHead: jest.fn().mockResolvedValue(true),
        };
        works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                kind: 'app',
                gitProvider: 'github',
                taskIsolationBaseBranch: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'bookings',
            }),
        };
        git = { getPullRequestStatus: jest.fn().mockResolvedValue(mergedStatus) };
        transitions = { transition: jest.fn().mockResolvedValue(undefined) };
        tracker = {
            isDeliveryTracked: jest.fn().mockResolvedValue(true),
            recordMerge: jest.fn().mockResolvedValue({ recorded: true }),
        };
    });

    it('a tracked merge is recorded with the provider status and the Task is NOT completed', async () => {
        const summary = await service().syncDuePrStatuses();

        expect(tracker.isDeliveryTracked).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-1', prState: 'merged' }),
            expect.objectContaining({ mergeCommitSha: MERGE_SHA, baseRef: 'production' }),
        );
        expect(tracker.recordMerge).toHaveBeenCalledTimes(1);
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(summary).toMatchObject({ merged: 1, completed: 0, deliveryTracked: 1 });
    });

    it('an untracked merge (another branch, S19 / a non-App Work) completes exactly as before', async () => {
        tracker.isDeliveryTracked.mockResolvedValue(false);
        const summary = await service().syncDuePrStatuses();

        expect(tracker.recordMerge).not.toHaveBeenCalled();
        expect(transitions.transition).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-1' }),
            TaskStatus.DONE,
            expect.objectContaining({ actorType: 'agent' }),
        );
        expect(summary).toMatchObject({ merged: 1, completed: 1, deliveryTracked: 0 });
    });

    it('a tracker that throws never strands the Task — it completes on merge', async () => {
        tracker.isDeliveryTracked.mockRejectedValue(new Error('db down'));
        const summary = await service().syncDuePrStatuses();
        expect(transitions.transition).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ completed: 1, deliveryTracked: 0, failed: 0 });
    });

    it('with no delivery chain bound, every merge completes as before', async () => {
        const summary = await service({ tracker: undefined }).syncDuePrStatuses();
        expect(transitions.transition).toHaveBeenCalledTimes(1);
        expect(summary).toMatchObject({ completed: 1, deliveryTracked: 0 });
    });

    it('an open pull request never reaches the hook', async () => {
        git.getPullRequestStatus.mockResolvedValue({ ...mergedStatus, state: 'open', merged: false });
        await service().syncDuePrStatuses();
        expect(tracker.isDeliveryTracked).not.toHaveBeenCalled();
    });

    it('refreshTask answers { task, status } — the provider read rides along (APW08-G10)', async () => {
        const svc = service();
        const result = await (
            svc as unknown as {
                refreshTask: (task: Task, userId: string) => Promise<{ task: Task; status: unknown }>;
            }
        ).refreshTask(makeTask(), 'user-1');
        expect(result.task).toMatchObject({ id: 'task-1', prState: 'merged' });
        expect(result.status).toBe(mergedStatus);
    });

    it('refreshTask answers status null when the pull request is gone from the provider', async () => {
        git.getPullRequestStatus.mockResolvedValue(null);
        const result = await (
            service() as unknown as {
                refreshTask: (task: Task, userId: string) => Promise<{ task: Task; status: unknown }>;
            }
        ).refreshTask(makeTask(), 'user-1');
        expect(result.status).toBeNull();
        expect(result.task.id).toBe('task-1');
    });

    it('the on-demand read that first sees a tracked merge records it (and still completes nothing)', async () => {
        tasks.findByIdAndUser.mockResolvedValue(makeTask({ ciCheckedAt: null }));
        const view = await service().getForTask('user-1', 'task-1', { refresh: true });
        expect(view.prState).toBe('merged');
        expect(tracker.recordMerge).toHaveBeenCalledTimes(1);
        expect(transitions.transition).not.toHaveBeenCalled();
    });
});
