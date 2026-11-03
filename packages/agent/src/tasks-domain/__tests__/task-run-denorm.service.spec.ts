import { TaskRunDenormService } from '../task-run-denorm.service';
import type { TaskRepository } from '../../database/repositories/task.repository';

/**
 * Kanban run cockpit (Wave 2 M1) — latest-run denorm on the Task row.
 *
 * The service is a thin, best-effort mirror over
 * `TaskRepository.updateLatestRun`; these tests pin down the three
 * contract points that matter for the board:
 *
 *  1. queued creation installs the pointer UNCONDITIONALLY (newest
 *     dispatch wins),
 *  2. claim + terminal transitions are GUARDED on the run id (a stale
 *     write from an older run can never clobber a newer run's pointer),
 *  3. nothing thrown here may ever escape (denorm is telemetry, not
 *     truth — a failure must not fail the run or the transition).
 */
describe('TaskRunDenormService', () => {
    const TASK_ID = 'task-1111';
    const RUN_ID = 'run-aaaa';

    let updateLatestRun: jest.Mock;
    let service: TaskRunDenormService;

    beforeEach(() => {
        updateLatestRun = jest.fn().mockResolvedValue(true);
        service = new TaskRunDenormService({
            updateLatestRun,
        } as unknown as TaskRepository);
    });

    it('recordQueued installs the pointer unconditionally (no expectRunId guard)', async () => {
        await expect(service.recordQueued(TASK_ID, RUN_ID)).resolves.toBe(true);
        expect(updateLatestRun).toHaveBeenCalledTimes(1);
        expect(updateLatestRun).toHaveBeenCalledWith(
            TASK_ID,
            { latestRunId: RUN_ID, latestRunStatus: 'queued' },
            undefined,
        );
    });

    it('recordStarted mirrors running, guarded on its own run id', async () => {
        await expect(service.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(true);
        expect(updateLatestRun).toHaveBeenCalledWith(
            TASK_ID,
            { latestRunId: RUN_ID, latestRunStatus: 'running' },
            RUN_ID,
        );
    });

    it.each(['completed', 'failed', 'cancelled'] as const)(
        'recordTerminal mirrors %s, guarded on its own run id',
        async (status) => {
            await expect(service.recordTerminal(TASK_ID, RUN_ID, status)).resolves.toBe(true);
            expect(updateLatestRun).toHaveBeenCalledWith(
                TASK_ID,
                { latestRunId: RUN_ID, latestRunStatus: status },
                RUN_ID,
            );
        },
    );

    it('full happy-path lifecycle: queued → running → completed in order', async () => {
        await service.recordQueued(TASK_ID, RUN_ID);
        await service.recordStarted(TASK_ID, RUN_ID);
        await service.recordTerminal(TASK_ID, RUN_ID, 'completed');

        expect(updateLatestRun.mock.calls).toEqual([
            [TASK_ID, { latestRunId: RUN_ID, latestRunStatus: 'queued' }, undefined],
            [TASK_ID, { latestRunId: RUN_ID, latestRunStatus: 'running' }, RUN_ID],
            [TASK_ID, { latestRunId: RUN_ID, latestRunStatus: 'completed' }, RUN_ID],
        ]);
    });

    it('reports (not throws) when the guarded write loses to a newer run', async () => {
        // Repository CAS found the pointer already advanced → affected 0.
        updateLatestRun.mockResolvedValue(false);
        await expect(service.recordTerminal(TASK_ID, RUN_ID, 'failed')).resolves.toBe(false);
        await expect(service.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(false);
    });

    it('swallows repository failures — a denorm error must never escape', async () => {
        updateLatestRun.mockRejectedValue(new Error('db down'));
        await expect(service.recordQueued(TASK_ID, RUN_ID)).resolves.toBe(false);
        await expect(service.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(false);
        await expect(service.recordTerminal(TASK_ID, RUN_ID, 'completed')).resolves.toBe(false);
    });
});

/**
 * APW-08 T26 / T54 (FR-43) — `recordStarted` is where an App Work Task gets its **Run started.**
 * post (the cloud claim and the fleet lease both pass through it). Once per run: only when the
 * pointer moves to (this run, `running`) from anything else. Whether the Task gets a post at all
 * (App Work only) and who speaks is the bound poster's business — pinned in
 * `task-lifecycle-posts.spec.ts`.
 */
describe('TaskRunDenormService — Run started. (APW-08 FR-43)', () => {
    const TASK_ID = 'task-1111';
    const RUN_ID = 'run-aaaa';

    let row: {
        id: string;
        userId: string;
        workId: string;
        latestRunId: string | null;
        latestRunStatus: string | null;
    };
    let tasks: { findById: jest.Mock; updateLatestRun: jest.Mock };
    let lifecycle: { post: jest.Mock };
    let service: TaskRunDenormService;

    beforeEach(() => {
        row = {
            id: TASK_ID,
            userId: 'user-1',
            workId: 'work-1',
            latestRunId: RUN_ID,
            latestRunStatus: 'queued',
        };
        tasks = {
            findById: jest.fn(async () => ({ ...row })),
            updateLatestRun: jest.fn(
                async (
                    _id: string,
                    patch: { latestRunId: string; latestRunStatus: string },
                    expectRunId?: string,
                ) => {
                    if (expectRunId && row.latestRunId && row.latestRunId !== expectRunId)
                        return false;
                    Object.assign(row, patch);
                    return true;
                },
            ),
        };
        lifecycle = { post: jest.fn().mockResolvedValue(true) };
        service = new TaskRunDenormService(
            tasks as unknown as TaskRepository,
            undefined,
            lifecycle,
        );
    });

    it('posts Run started. once for the claim, with the run that started', async () => {
        await expect(service.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(true);
        expect(lifecycle.post).toHaveBeenCalledTimes(1);
        expect(lifecycle.post).toHaveBeenCalledWith({
            task: expect.objectContaining({ id: TASK_ID, userId: 'user-1', workId: 'work-1' }),
            post: { key: 'deliveryPosts.runStarted' },
            runId: RUN_ID,
        });
    });

    it('a retry re-claiming the same run (already running) posts nothing more', async () => {
        await service.recordStarted(TASK_ID, RUN_ID);
        await service.recordStarted(TASK_ID, RUN_ID);
        await service.recordStarted(TASK_ID, RUN_ID);
        expect(tasks.updateLatestRun).toHaveBeenCalledTimes(3);
        expect(lifecycle.post).toHaveBeenCalledTimes(1);
    });

    it('overlapping claims of the same run share one write and one post (review of #3035)', async () => {
        const results = await Promise.all([
            service.recordStarted(TASK_ID, RUN_ID),
            service.recordStarted(TASK_ID, RUN_ID),
            service.recordStarted(TASK_ID, RUN_ID),
        ]);
        expect(results).toEqual([true, true, true]);
        expect(tasks.findById).toHaveBeenCalledTimes(1);
        expect(tasks.updateLatestRun).toHaveBeenCalledTimes(1);
        expect(lifecycle.post).toHaveBeenCalledTimes(1);
        // Settled → the next claim reads again (a later retry is not swallowed by the map).
        await service.recordStarted(TASK_ID, RUN_ID);
        expect(tasks.updateLatestRun).toHaveBeenCalledTimes(2);
        expect(lifecycle.post).toHaveBeenCalledTimes(1);
    });

    it('a second run on the Task is a second event', async () => {
        await service.recordStarted(TASK_ID, RUN_ID);
        await service.recordTerminal(TASK_ID, RUN_ID, 'completed');
        await service.recordQueued(TASK_ID, 'run-bbbb');
        await service.recordStarted(TASK_ID, 'run-bbbb');
        expect(lifecycle.post.mock.calls.map((call) => call[0].runId)).toEqual([
            RUN_ID,
            'run-bbbb',
        ]);
    });

    it('a stale claim that loses the pointer to a newer run posts nothing', async () => {
        row.latestRunId = 'run-newer';
        await expect(service.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(false);
        expect(lifecycle.post).not.toHaveBeenCalled();
    });

    it('an unreadable Task skips the post but not the write', async () => {
        tasks.findById.mockRejectedValueOnce(new Error('db down'));
        await expect(service.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(true);
        expect(tasks.updateLatestRun).toHaveBeenCalledTimes(1);
        expect(lifecycle.post).not.toHaveBeenCalled();
    });

    it('a poster that throws never escapes, and the write still answers true', async () => {
        lifecycle.post.mockRejectedValueOnce(new Error('boom'));
        await expect(service.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(true);
    });

    it('queued and terminal writes never post', async () => {
        await service.recordQueued(TASK_ID, RUN_ID);
        await service.recordTerminal(TASK_ID, RUN_ID, 'failed');
        expect(lifecycle.post).not.toHaveBeenCalled();
        expect(tasks.findById).not.toHaveBeenCalled();
    });

    it('without a bound poster recordStarted reads nothing and writes exactly as before', async () => {
        const plain = new TaskRunDenormService(tasks as unknown as TaskRepository);
        await expect(plain.recordStarted(TASK_ID, RUN_ID)).resolves.toBe(true);
        expect(tasks.findById).not.toHaveBeenCalled();
        expect(tasks.updateLatestRun).toHaveBeenCalledWith(
            TASK_ID,
            { latestRunId: RUN_ID, latestRunStatus: 'running' },
            RUN_ID,
        );
    });
});
