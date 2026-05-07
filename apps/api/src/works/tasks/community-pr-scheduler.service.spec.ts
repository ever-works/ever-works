jest.mock('@ever-works/agent/community-pr', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({}));

import { CommunityPrSchedulerService } from './community-pr-scheduler.service';
import type { CommunityPrProcessorService } from '@ever-works/agent/community-pr';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';

describe('CommunityPrSchedulerService', () => {
    let processor: { processAllWorks: jest.Mock };
    let taskLockService: { runExclusive: jest.Mock };
    let service: CommunityPrSchedulerService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        processor = { processAllWorks: jest.fn() };
        taskLockService = { runExclusive: jest.fn() };
        service = new CommunityPrSchedulerService(
            processor as unknown as CommunityPrProcessorService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('runExclusive uses works:community-pr-scheduler key, 1h ttlMs, and a debug onLocked', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);

        await service.handleCommunityPrProcessing();

        const [key, work, opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('works:community-pr-scheduler');
        expect(typeof work).toBe('function');
        expect(opts.ttlMs).toBe(60 * 60 * 1000);
        expect(typeof opts.onLocked).toBe('function');

        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping community PR processing because another instance holds the task lock',
        );
    });

    it('runs the inner work, logs start + completion with processed and error counts', async () => {
        processor.processAllWorks.mockResolvedValue({
            processed: 7,
            errors: ['e1', 'e2'],
        });

        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleCommunityPrProcessing();

        expect(processor.processAllWorks).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith('Starting community PR processing');
        expect(logSpy).toHaveBeenCalledWith(
            'Community PR processing completed: 7 processed, 2 errors',
        );
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs an error stack when processor throws Error and swallows the failure', async () => {
        const boom = new Error('boom');
        processor.processAllWorks.mockRejectedValue(boom);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await expect(service.handleCommunityPrProcessing()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Error during community PR processing', boom.stack);
    });

    it('logs error with String(error) when thrown value is not an Error', async () => {
        processor.processAllWorks.mockRejectedValue('plain string failure');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleCommunityPrProcessing();
        expect(errorSpy).toHaveBeenCalledWith(
            'Error during community PR processing',
            'plain string failure',
        );
    });

    it('does not run inner work when runExclusive returns without invoking it (locked branch)', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);
        await service.handleCommunityPrProcessing();
        expect(processor.processAllWorks).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('handles zero processed and zero errors', async () => {
        processor.processAllWorks.mockResolvedValue({ processed: 0, errors: [] });
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleCommunityPrProcessing();
        expect(logSpy).toHaveBeenCalledWith(
            'Community PR processing completed: 0 processed, 0 errors',
        );
    });
});
