jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/fleet', () => ({}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: {
            shouldUseTrigger: jest.fn(),
        },
    },
}));

import { FLEET_HEALTH_ROLLUP_CRON } from '@ever-works/contracts';
import { config } from '@ever-works/agent/config';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';
import type { FleetNodeHealthService } from '@ever-works/agent/fleet';
import { FleetHealthRollupCronService } from './fleet-health-rollup-cron.service';

/**
 * Computer health (FL-03) — the hourly roll-up on installs where Trigger.dev is
 * not the runtime. Mirrors `skill-readiness-sweep-cron.service.spec.ts`: the
 * same gate (`shouldUseTrigger()` → the Trigger.dev schedule owns the pass),
 * the same distributed lock, and the pass is `rollupAndPrune()`.
 */
describe('FleetHealthRollupCronService', () => {
    const shouldUseTrigger = (config as unknown as { trigger: { shouldUseTrigger: jest.Mock } })
        .trigger.shouldUseTrigger;
    let health: { rollupAndPrune: jest.Mock; isHistoryEnabled: jest.Mock };
    let taskLockService: { runExclusive: jest.Mock };
    let service: FleetHealthRollupCronService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    const summary = (over: Record<string, number> = {}) => ({
        enabled: true,
        rolledHours: 0,
        hourlyRows: 0,
        prunedRaw: 0,
        prunedHourly: 0,
        ...over,
    });

    beforeEach(() => {
        health = {
            rollupAndPrune: jest.fn().mockResolvedValue(summary()),
            isHistoryEnabled: jest.fn(() => true),
        };
        taskLockService = {
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => ({
                acquired: true,
                result: await fn(),
            })),
        };
        service = new FleetHealthRollupCronService(
            health as unknown as FleetNodeHealthService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the private logger, as the sibling spec reaches it
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        shouldUseTrigger.mockReturnValue(false);
    });

    it('runs on the cron the Trigger.dev task shares', () => {
        expect(FLEET_HEALTH_ROLLUP_CRON).toBe('7 * * * *');
    });

    it('stays out of the way when Trigger.dev owns the schedule', async () => {
        shouldUseTrigger.mockReturnValue(true);
        await service.runHourlyRollup();
        expect(taskLockService.runExclusive).not.toHaveBeenCalled();
        expect(health.rollupAndPrune).not.toHaveBeenCalled();
    });

    it('still runs the pass with the history switched off — retention must keep ageing rows out', async () => {
        health.isHistoryEnabled.mockReturnValue(false);
        health.rollupAndPrune.mockResolvedValueOnce({
            ...summary({ prunedRaw: 12 }),
            enabled: false,
        });
        await service.runHourlyRollup();
        expect(taskLockService.runExclusive).toHaveBeenCalledTimes(1);
        expect(health.rollupAndPrune).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('12 raw'));
    });

    it('runs one pass under the distributed lock, and logs counters only when something happened', async () => {
        await service.runHourlyRollup();
        expect(taskLockService.runExclusive).toHaveBeenCalledWith(
            'fleet-health:rollup',
            expect.any(Function),
            expect.any(Object),
        );
        expect(health.rollupAndPrune).toHaveBeenCalledTimes(1);
        expect(logSpy).not.toHaveBeenCalled();

        health.rollupAndPrune.mockResolvedValueOnce(
            summary({ rolledHours: 1, hourlyRows: 3, prunedRaw: 60 }),
        );
        await service.runHourlyRollup();
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining('1 hour(s) rolled into 3 row(s), 60 raw'),
        );
    });

    it('a failing pass is logged, never thrown out of the cron tick', async () => {
        health.rollupAndPrune.mockRejectedValueOnce(new Error('db down'));
        await expect(service.runHourlyRollup()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
    });
});
