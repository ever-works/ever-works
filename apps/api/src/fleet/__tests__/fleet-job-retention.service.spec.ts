import { Logger } from '@nestjs/common';
import {
    FLEET_JOB_PURGE_BATCH_SIZE,
    FleetJobRetentionService,
} from '../fleet-job-retention.service';

/**
 * Self-build slice AP — the nightly fleet job retention pass.
 *
 * The predicates themselves (terminal only, older than the cut-off, never
 * twice) are pinned against a real schema in the agent package's
 * `fleet-job.retention.repository.integration.spec.ts`. This pins the pass
 * around them: the window it computes, the batching, the lock, the off
 * switch, and that a failure never escapes a cron tick.
 */
describe('FleetJobRetentionService', () => {
    const NOW = new Date('2026-10-08T03:35:00.000Z');
    const DAY = 86_400_000;
    const env = { ...process.env };

    let jobs: { purgeTerminalBodies: jest.Mock };
    let taskLock: { runExclusive: jest.Mock };

    beforeEach(() => {
        jobs = { purgeTerminalBodies: jest.fn().mockResolvedValue(0) };
        taskLock = {
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => ({
                acquired: true,
                result: await fn(),
            })),
        };
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.env = { ...env };
        jest.restoreAllMocks();
    });

    const service = () => new FleetJobRetentionService(jobs as never, taskLock as never);

    it('cuts off at 30 days by default and purges in bounded batches until one comes back short', async () => {
        delete process.env.FLEET_JOB_RETENTION_DAYS;
        jobs.purgeTerminalBodies
            .mockResolvedValueOnce(FLEET_JOB_PURGE_BATCH_SIZE)
            .mockResolvedValueOnce(FLEET_JOB_PURGE_BATCH_SIZE)
            .mockResolvedValueOnce(7);

        await expect(service().purge(NOW)).resolves.toBe(2 * FLEET_JOB_PURGE_BATCH_SIZE + 7);

        expect(jobs.purgeTerminalBodies).toHaveBeenCalledTimes(3);
        const [cutoff, batch, stamp] = jobs.purgeTerminalBodies.mock.calls[0];
        expect((cutoff as Date).toISOString()).toBe(
            new Date(NOW.getTime() - 30 * DAY).toISOString(),
        );
        expect(batch).toBe(FLEET_JOB_PURGE_BATCH_SIZE);
        expect(stamp).toBe(NOW);
    });

    it('honours FLEET_JOB_RETENTION_DAYS', async () => {
        process.env.FLEET_JOB_RETENTION_DAYS = '7';
        await service().purge(NOW);
        const [cutoff] = jobs.purgeTerminalBodies.mock.calls[0];
        expect((cutoff as Date).toISOString()).toBe(
            new Date(NOW.getTime() - 7 * DAY).toISOString(),
        );
    });

    it('stops at the per-pass batch ceiling and leaves the rest to the next night', async () => {
        jobs.purgeTerminalBodies.mockResolvedValue(10);
        await expect(service().purge(NOW, 10, 3)).resolves.toBe(30);
        expect(jobs.purgeTerminalBodies).toHaveBeenCalledTimes(3);
        expect(Logger.prototype.warn).toHaveBeenCalledWith(
            expect.stringContaining('stopped at 3 batches'),
        );
    });

    it('runs the cron tick under the distributed task lock', async () => {
        await service().purgeExpiredJobBodies();
        expect(taskLock.runExclusive).toHaveBeenCalledWith(
            'fleet-jobs:purge-bodies',
            expect.any(Function),
            expect.objectContaining({ ttlMs: 60 * 60 * 1000 }),
        );
        expect(jobs.purgeTerminalBodies).toHaveBeenCalledTimes(1);
    });

    it('does nothing at all when FLEET_JOB_PURGE_ENABLED=false (an audit hold)', async () => {
        process.env.FLEET_JOB_PURGE_ENABLED = 'false';
        await service().purgeExpiredJobBodies();
        expect(taskLock.runExclusive).not.toHaveBeenCalled();
        expect(jobs.purgeTerminalBodies).not.toHaveBeenCalled();
    });

    it('never lets a failing purge escape the cron tick', async () => {
        jobs.purgeTerminalBodies.mockRejectedValue(new Error('db down'));
        await expect(service().purgeExpiredJobBodies()).resolves.toBeUndefined();
        expect(Logger.prototype.error).toHaveBeenCalledWith(
            'Fleet job retention purge failed:',
            expect.any(Error),
        );
    });
});
