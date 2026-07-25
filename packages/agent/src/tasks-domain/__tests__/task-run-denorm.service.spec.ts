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
