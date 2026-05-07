jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));

import { ItemSourceValidationCronService } from './item-source-validation-scheduler.service';
import type { CacheEntryRepository, DistributedTaskLockService } from '@ever-works/agent/cache';
import type { ItemSourceValidationSchedulerService } from '@ever-works/agent/services';
import {
    WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
    WORK_CONFIG_CACHE_KEY_PREFIX,
    WORK_COUNT_CACHE_KEY_PREFIX,
    WORK_ITEMS_CACHE_KEY_PREFIX,
} from '../work-cache.constants';

describe('ItemSourceValidationCronService', () => {
    let scheduler: { processDueSchedules: jest.Mock };
    let cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: jest.Mock } };
    let taskLockService: { runExclusive: jest.Mock };
    let service: ItemSourceValidationCronService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        scheduler = { processDueSchedules: jest.fn() };
        cacheEntryRepository = {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn().mockResolvedValue(undefined) },
        };
        taskLockService = { runExclusive: jest.fn() };
        service = new ItemSourceValidationCronService(
            scheduler as unknown as ItemSourceValidationSchedulerService,
            cacheEntryRepository as unknown as CacheEntryRepository,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('runExclusive uses works:item-source-validation-scheduler key, 1h ttl, debug onLocked', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);

        await service.handleScheduledSourceValidation();

        const [key, work, opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('works:item-source-validation-scheduler');
        expect(typeof work).toBe('function');
        expect(opts.ttlMs).toBe(60 * 60 * 1000);
        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping scheduled item source validation because another instance holds the task lock',
        );
    });

    it('processes schedules, deletes the four work cache prefixes in parallel, logs counts', async () => {
        scheduler.processDueSchedules.mockResolvedValue({
            processed: 3,
            skipped: 1,
            itemsChecked: 12,
            itemsChanged: 5,
            errors: ['err-a'],
        });

        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleScheduledSourceValidation();

        expect(scheduler.processDueSchedules).toHaveBeenCalledTimes(1);
        expect(cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike).toHaveBeenCalledTimes(
            4,
        );
        const calls = cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike.mock.calls.map(
            (c) => c[0],
        );
        expect(calls).toEqual(
            expect.arrayContaining([
                WORK_ITEMS_CACHE_KEY_PREFIX,
                WORK_CONFIG_CACHE_KEY_PREFIX,
                WORK_COUNT_CACHE_KEY_PREFIX,
                WORK_CATEGORIES_TAGS_CACHE_KEY_PREFIX,
            ]),
        );
        expect(logSpy).toHaveBeenCalledWith('Starting scheduled item source validation');
        expect(logSpy).toHaveBeenCalledWith(
            'Scheduled item source validation completed: 3 processed, 1 skipped, 12 items checked, 5 items changed, 1 errors',
        );
    });

    it('logs the error stack when processDueSchedules throws Error and swallows', async () => {
        const boom = new Error('process failed');
        scheduler.processDueSchedules.mockRejectedValue(boom);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await expect(service.handleScheduledSourceValidation()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith(
            'Error during scheduled item source validation',
            boom.stack,
        );
        expect(
            cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
        ).not.toHaveBeenCalled();
    });

    it('logs error with String(error) when thrown value is not an Error', async () => {
        scheduler.processDueSchedules.mockRejectedValue('boom');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleScheduledSourceValidation();
        expect(errorSpy).toHaveBeenCalledWith(
            'Error during scheduled item source validation',
            'boom',
        );
    });

    it('does not invoke processDueSchedules or cache deletes when locked branch skips', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);
        await service.handleScheduledSourceValidation();
        expect(scheduler.processDueSchedules).not.toHaveBeenCalled();
        expect(
            cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
        ).not.toHaveBeenCalled();
    });
});
