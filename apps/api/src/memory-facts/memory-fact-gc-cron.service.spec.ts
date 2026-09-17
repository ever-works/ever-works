jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: {
            shouldUseTrigger: jest.fn(),
        },
    },
}));
jest.mock('@ever-works/agent/tasks', () => ({
    MEMORY_FACT_GC_CRON: '13 4 * * *',
    runMemoryFactGcJob: (target: { sweep: () => Promise<unknown> }) => target.sweep(),
}));

import { config } from '@ever-works/agent/config';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';
import type { MemoryFactSweepService } from '@ever-works/agent/services';
import { MemoryFactGcCronService } from './memory-fact-gc-cron.service';

/**
 * AW-07 — the nightly sweep on installs where Trigger.dev is not the runtime.
 *
 * Mirrors `work-schedule-dispatcher-cron.service.spec.ts`: the same gate
 * (`shouldUseTrigger()` → the Trigger.dev schedule owns the pass), the same
 * distributed lock, and the pass itself is the runtime-neutral handler.
 */
describe('MemoryFactGcCronService', () => {
    const shouldUseTrigger = (config as any).trigger.shouldUseTrigger as jest.Mock;
    let sweeper: { sweep: jest.Mock };
    let taskLockService: { runExclusive: jest.Mock };
    let service: MemoryFactGcCronService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    const quietSummary = { purged: 0, embedded: 0, reembedded: 0, embedStoppedReason: null };

    beforeEach(() => {
        sweeper = { sweep: jest.fn().mockResolvedValue(quietSummary) };
        taskLockService = {
            runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => {
                const result = await fn();
                return { acquired: true, result };
            }),
        };
        service = new MemoryFactGcCronService(
            sweeper as unknown as MemoryFactSweepService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        shouldUseTrigger.mockReturnValue(false);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('leaves the pass to the Trigger.dev schedule when Trigger.dev is the runtime', async () => {
        shouldUseTrigger.mockReturnValue(true);
        await service.runNightlySweep();
        expect(taskLockService.runExclusive).not.toHaveBeenCalled();
        expect(sweeper.sweep).not.toHaveBeenCalled();
    });

    it('runs one sweep under the distributed lock on any other install', async () => {
        await service.runNightlySweep();
        expect(taskLockService.runExclusive).toHaveBeenCalledWith(
            'memory-facts:gc',
            expect.any(Function),
            expect.objectContaining({ ttlMs: 60 * 60 * 1000 }),
        );
        expect(sweeper.sweep).toHaveBeenCalledTimes(1);
        // Quiet when nothing happened.
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('logs a pass that purged or embedded something', async () => {
        sweeper.sweep.mockResolvedValue({
            purged: 2,
            embedded: 1,
            reembedded: 0,
            embedStoppedReason: null,
        });
        await service.runNightlySweep();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 purged, 1 embedded'));
    });

    it('never throws out of the scheduler when the pass fails', async () => {
        sweeper.sweep.mockRejectedValue(new Error('db down'));
        await expect(service.runNightlySweep()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('memory-fact-gc pass failed', expect.any(String));
    });

    it('skips when another replica holds the lock', async () => {
        taskLockService.runExclusive.mockResolvedValue({ acquired: false });
        await service.runNightlySweep();
        expect(sweeper.sweep).not.toHaveBeenCalled();
    });
});
