jest.mock('@ever-works/agent/notifications', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({}));

import { NotificationCleanupService } from './notification-cleanup.service';
import type { NotificationService } from '@ever-works/agent/notifications';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';

describe('NotificationCleanupService', () => {
    let notificationService: jest.Mocked<Pick<NotificationService, 'cleanup'>>;
    let taskLockService: { runExclusive: jest.Mock };
    let service: NotificationCleanupService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        notificationService = {
            cleanup: jest.fn(),
        } as any;
        taskLockService = {
            runExclusive: jest.fn(),
        };
        service = new NotificationCleanupService(
            notificationService as unknown as NotificationService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        // Suppress and spy on logger so we can assert on log output
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest
            .spyOn((service as any).logger, 'error')
            .mockImplementation(() => undefined);
        debugSpy = jest
            .spyOn((service as any).logger, 'debug')
            .mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('calls runExclusive with the notifications:cleanup key, 1h TTL, and an onLocked debug logger', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);

        await service.cleanupNotifications();

        const [key, work, opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('notifications:cleanup');
        expect(typeof work).toBe('function');
        expect(opts.ttlMs).toBe(60 * 60 * 1000);
        expect(typeof opts.onLocked).toBe('function');

        // onLocked should hit logger.debug
        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping notification cleanup because another instance holds the task lock',
        );
    });

    it('runs cleanup successfully and logs counts', async () => {
        notificationService.cleanup.mockResolvedValue({ expired: 4, dismissed: 2, old: 9 });

        // Capture and execute the work function passed to runExclusive
        let capturedWork: (() => Promise<void>) | undefined;
        taskLockService.runExclusive.mockImplementation(async (_key, work) => {
            capturedWork = work;
            await work();
        });

        await service.cleanupNotifications();

        expect(capturedWork).toBeDefined();
        expect(notificationService.cleanup).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith('Starting notification cleanup...');
        expect(logSpy).toHaveBeenCalledWith(
            'Notification cleanup completed: 4 expired, 2 dismissed (>7d), 9 old (>30d)',
        );
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs error and swallows when notificationService.cleanup throws', async () => {
        const boom = new Error('db down');
        notificationService.cleanup.mockRejectedValue(boom);

        taskLockService.runExclusive.mockImplementation(async (_key, work) => {
            await work();
        });

        await expect(service.cleanupNotifications()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Notification cleanup failed:', boom);
    });

    it('does not run cleanup when lock holder skips work (runExclusive resolves without invoking work)', async () => {
        // Simulate the locked branch: runExclusive returns without invoking work
        taskLockService.runExclusive.mockResolvedValue(undefined);

        await service.cleanupNotifications();

        expect(notificationService.cleanup).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });
});
