jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        subscriptions: {
            scheduledUpdatesEnabled: jest.fn(),
            getDispatchIntervalMinutes: jest.fn(),
        },
        trigger: {
            shouldUseTrigger: jest.fn(),
        },
    },
}));

import { config } from '@ever-works/agent/config';
import { WorkScheduleDispatcherCronService } from './work-schedule-dispatcher-cron.service';
import type { WorkScheduleDispatcherService } from '@ever-works/agent/services';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';

describe('WorkScheduleDispatcherCronService', () => {
    let dispatcher: { dispatchDue: jest.Mock };
    let taskLockService: { runExclusive: jest.Mock };
    let service: WorkScheduleDispatcherCronService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;
    const scheduledUpdatesEnabled = (config as any).subscriptions
        .scheduledUpdatesEnabled as jest.Mock;
    const getDispatchIntervalMinutes = (config as any).subscriptions
        .getDispatchIntervalMinutes as jest.Mock;
    const shouldUseTrigger = (config as any).trigger.shouldUseTrigger as jest.Mock;
    let dateSpy: jest.SpyInstance | undefined;

    beforeEach(() => {
        dispatcher = { dispatchDue: jest.fn() };
        taskLockService = { runExclusive: jest.fn() };
        service = new WorkScheduleDispatcherCronService(
            dispatcher as unknown as WorkScheduleDispatcherService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest
            .spyOn((service as any).logger, 'error')
            .mockImplementation(() => undefined);
        debugSpy = jest
            .spyOn((service as any).logger, 'debug')
            .mockImplementation(() => undefined);
        // Defaults: feature ON, no trigger
        scheduledUpdatesEnabled.mockReturnValue(true);
        shouldUseTrigger.mockReturnValue(false);
        getDispatchIntervalMinutes.mockReturnValue(1);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        dateSpy?.mockRestore();
    });

    it('returns early when scheduledUpdatesEnabled() is false', async () => {
        scheduledUpdatesEnabled.mockReturnValue(false);
        await service.dispatchDueSchedules();
        expect(taskLockService.runExclusive).not.toHaveBeenCalled();
    });

    it('returns early when trigger should be used (delegates dispatch elsewhere)', async () => {
        shouldUseTrigger.mockReturnValue(true);
        await service.dispatchDueSchedules();
        expect(taskLockService.runExclusive).not.toHaveBeenCalled();
    });

    it('skips when current minute is not aligned with the dispatch interval', async () => {
        // interval=5 → run only at minutes divisible by 5
        getDispatchIntervalMinutes.mockReturnValue(5);
        // 5 mins after epoch = 60_000 * 5 = epochMinute 5 (5 % 5 === 0). Pick a non-aligned: 6.
        const sixMins = new Date(60_000 * 6);
        dateSpy = jest.spyOn(global, 'Date').mockImplementation(() => sixMins as any);

        await service.dispatchDueSchedules();
        expect(taskLockService.runExclusive).not.toHaveBeenCalled();
    });

    it('runs dispatcher when minute is aligned, with ttlMs = max(intervalMinutes*60_000, 60_000)', async () => {
        getDispatchIntervalMinutes.mockReturnValue(5);
        // epochMinute 5 is aligned
        const fiveMins = new Date(60_000 * 5);
        dateSpy = jest.spyOn(global, 'Date').mockImplementation(() => fiveMins as any);
        dispatcher.dispatchDue.mockResolvedValue({
            dispatched: 3,
            skipped: 1,
            failed: 0,
            dueCount: 4,
        });
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.dispatchDueSchedules();
        const [key, , opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('works:schedule-dispatcher');
        expect(opts.ttlMs).toBe(5 * 60 * 1000);
        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping work schedule dispatch because another instance holds the task lock',
        );
        expect(dispatcher.dispatchDue).toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(
            'Work schedule dispatch completed: 3 dispatched, 1 skipped, 0 failed (4 due)',
        );
    });

    it('does not log completion when both dueCount and failed are zero', async () => {
        getDispatchIntervalMinutes.mockReturnValue(1);
        dispatcher.dispatchDue.mockResolvedValue({
            dispatched: 0,
            skipped: 0,
            failed: 0,
            dueCount: 0,
        });
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.dispatchDueSchedules();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('logs completion when only failed count is non-zero', async () => {
        getDispatchIntervalMinutes.mockReturnValue(1);
        dispatcher.dispatchDue.mockResolvedValue({
            dispatched: 0,
            skipped: 0,
            failed: 2,
            dueCount: 0,
        });
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.dispatchDueSchedules();
        expect(logSpy).toHaveBeenCalledWith(
            'Work schedule dispatch completed: 0 dispatched, 0 skipped, 2 failed (0 due)',
        );
    });

    it('clamps ttlMs to a minimum of 60_000 ms when interval=0', async () => {
        getDispatchIntervalMinutes.mockReturnValue(0); // private getter clamps to >=1
        dispatcher.dispatchDue.mockResolvedValue({
            dispatched: 0,
            skipped: 0,
            failed: 0,
            dueCount: 0,
        });
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.dispatchDueSchedules();
        // private getDispatchIntervalMinutes returns max(1, 0) = 1, so ttl = 60_000
        const [, , opts] = taskLockService.runExclusive.mock.calls[0];
        expect(opts.ttlMs).toBe(60_000);
    });

    it('logs error stack when dispatchDue throws Error and swallows', async () => {
        const boom = new Error('dispatch failed');
        dispatcher.dispatchDue.mockRejectedValue(boom);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await expect(service.dispatchDueSchedules()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Work schedule dispatch failed', boom.stack);
    });

    it('logs String(error) when dispatcher rejects with non-Error', async () => {
        dispatcher.dispatchDue.mockRejectedValue('boom');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.dispatchDueSchedules();
        expect(errorSpy).toHaveBeenCalledWith('Work schedule dispatch failed', 'boom');
    });
});
