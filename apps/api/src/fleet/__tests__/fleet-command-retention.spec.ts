import { Logger } from '@nestjs/common';
import { FLEET_JOB_PURGE_BATCH_SIZE, FleetJobRetentionService } from '../fleet-job-retention.service';

/**
 * Commands on computers (FL-12 P3, T-27) — the nightly pass that clears the
 * stored head and tail of ended command runs older than the fleet retention
 * window (default 30 days). Pins the window, the batching, the off switch and
 * that an unbound repository (Commands not mounted) does nothing.
 */
describe('FleetJobRetentionService — command outputs', () => {
    const NOW = new Date('2026-10-21T03:45:00.000Z');
    const DAY = 86_400_000;
    const env = { ...process.env };

    let jobs: { purgeTerminalBodies: jest.Mock };
    let taskLock: { runExclusive: jest.Mock };
    let commandRuns: { purgeEndedOutputs: jest.Mock };

    beforeEach(() => {
        jobs = { purgeTerminalBodies: jest.fn().mockResolvedValue(0) };
        taskLock = {
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => ({
                acquired: true,
                result: await fn(),
            })),
        };
        commandRuns = { purgeEndedOutputs: jest.fn().mockResolvedValue(0) };
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.env = { ...env };
        jest.restoreAllMocks();
    });

    const service = (withCommands = true) =>
        new FleetJobRetentionService(jobs as never, taskLock as never, withCommands ? (commandRuns as never) : undefined);

    it('clears outputs ended before the 30-day cut-off, in batches until one comes back short', async () => {
        commandRuns.purgeEndedOutputs
            .mockResolvedValueOnce(FLEET_JOB_PURGE_BATCH_SIZE)
            .mockResolvedValueOnce(3);
        const purged = await service().purgeCommandOutputs(NOW);
        expect(purged).toBe(FLEET_JOB_PURGE_BATCH_SIZE + 3);
        const [cutoff] = commandRuns.purgeEndedOutputs.mock.calls[0];
        expect((cutoff as Date).getTime()).toBe(NOW.getTime() - 30 * DAY);
        expect(commandRuns.purgeEndedOutputs).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the purge is switched off or Commands are not mounted', async () => {
        process.env.FLEET_JOB_PURGE_ENABLED = 'false';
        await service().purgeExpiredCommandOutputs();
        expect(taskLock.runExclusive).not.toHaveBeenCalled();
        delete process.env.FLEET_JOB_PURGE_ENABLED;
        await service(false).purgeExpiredCommandOutputs();
        expect(taskLock.runExclusive).not.toHaveBeenCalled();
        expect(await service(false).purgeCommandOutputs(NOW)).toBe(0);
    });

    it('never lets a failure escape the cron tick', async () => {
        commandRuns.purgeEndedOutputs.mockRejectedValue(new Error('database gone'));
        await expect(service().purgeExpiredCommandOutputs()).resolves.toBeUndefined();
    });
});
