jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));

import { PluginUsageCleanupService } from './plugin-usage-cleanup.service';
import type { PluginUsageRepository } from '@ever-works/agent/database';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';

/**
 * EW-602 — PluginUsageCleanupService is the daily cron that prunes
 * plugin_usage_events older than the 12-month retention window. The
 * job is wrapped in DistributedTaskLockService.runExclusive so only one
 * API replica actually executes it per run.
 */

describe('PluginUsageCleanupService', () => {
    let usageRepository: jest.Mocked<Pick<PluginUsageRepository, 'pruneOlderThan'>>;
    let taskLockService: { runExclusive: jest.Mock };
    let service: PluginUsageCleanupService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        usageRepository = { pruneOlderThan: jest.fn() } as any;
        taskLockService = { runExclusive: jest.fn() };
        service = new PluginUsageCleanupService(
            usageRepository as unknown as PluginUsageRepository,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    it('calls runExclusive with the plugin-usage:cleanup key, 1h TTL, and a debug onLocked logger', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);

        await service.pruneOldEvents();

        const [key, work, opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('plugin-usage:cleanup');
        expect(typeof work).toBe('function');
        expect(opts.ttlMs).toBe(60 * 60 * 1000);
        expect(typeof opts.onLocked).toBe('function');

        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping plugin usage cleanup because another instance holds the task lock',
        );
    });

    it('runs prune successfully and logs the deleted-row count', async () => {
        usageRepository.pruneOlderThan.mockResolvedValue(42);

        let capturedWork: (() => Promise<void>) | undefined;
        taskLockService.runExclusive.mockImplementation(async (_key, work) => {
            capturedWork = work;
            await work();
        });

        await service.pruneOldEvents();

        expect(capturedWork).toBeDefined();
        expect(usageRepository.pruneOlderThan).toHaveBeenCalledTimes(1);
        const cutoffArg = (usageRepository.pruneOlderThan as jest.Mock).mock.calls[0][0];
        expect(cutoffArg).toBeInstanceOf(Date);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Pruning plugin_usage_events'));
        expect(logSpy).toHaveBeenCalledWith('Plugin usage cleanup completed: 42 rows pruned');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs error and swallows when prune throws (cron should never crash the API)', async () => {
        const boom = new Error('connection lost');
        usageRepository.pruneOlderThan.mockRejectedValue(boom);
        taskLockService.runExclusive.mockImplementation(async (_key, work) => {
            await work();
        });

        await expect(service.pruneOldEvents()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Plugin usage cleanup failed:', boom);
    });

    it('does not run prune when lock holder skips (runExclusive resolves without invoking work)', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);
        await service.pruneOldEvents();
        expect(usageRepository.pruneOlderThan).not.toHaveBeenCalled();
    });

    describe('computeCutoff (12-month retention math)', () => {
        function cutoff(now: Date): Date {
            return (service as any).computeCutoff(now);
        }

        it('subtracts exactly 12 UTC months from a mid-year date', () => {
            const c = cutoff(new Date('2026-05-15T12:00:00Z'));
            expect(c.toISOString()).toBe('2025-05-15T12:00:00.000Z');
        });

        it('handles year rollover when crossing January', () => {
            const c = cutoff(new Date('2026-01-15T00:00:00Z'));
            expect(c.toISOString()).toBe('2025-01-15T00:00:00.000Z');
        });

        it('does not lose the day-of-month for typical months', () => {
            const c = cutoff(new Date('2026-07-31T08:00:00Z'));
            // 12 months back from 2026-07-31 = 2025-07-31
            expect(c.toISOString()).toBe('2025-07-31T08:00:00.000Z');
        });
    });
});
