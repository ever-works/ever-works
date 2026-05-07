jest.mock('@ever-works/agent/cache', () => ({
    CACHE_MANAGER: 'CACHE_MANAGER',
}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    GenerateStatusType: {
        GENERATING: 'GENERATING',
        COMPLETED: 'COMPLETED',
        ERROR: 'ERROR',
    },
}));

import { WorkCacheWarmupService } from './work-cache-warmup.service';
import type { Cache } from '@ever-works/agent/cache';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';
import type { WorkRepository } from '@ever-works/agent/database';
import type { WorkQueryService } from '@ever-works/agent/services';
import {
    getWorkCategoriesTagsCacheKey,
    getWorkConfigCacheKey,
    getWorkCountCacheKey,
    getWorkItemsCacheKey,
    WORK_CACHE_TTL_MS,
} from '../work-cache.constants';

describe('WorkCacheWarmupService', () => {
    let cacheManager: { get: jest.Mock; set: jest.Mock };
    let workRepository: {
        countForDetailCacheWarmup: jest.Mock;
        findForDetailCacheWarmup: jest.Mock;
    };
    let workQueryService: {
        workItems: jest.Mock;
        workConfig: jest.Mock;
        workCount: jest.Mock;
        workCategoriesTags: jest.Mock;
    };
    let taskLockService: { runExclusive: jest.Mock };
    let service: WorkCacheWarmupService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        cacheManager = {
            get: jest.fn(),
            set: jest.fn().mockResolvedValue(undefined),
        };
        workRepository = {
            countForDetailCacheWarmup: jest.fn(),
            findForDetailCacheWarmup: jest.fn(),
        };
        workQueryService = {
            workItems: jest.fn(),
            workConfig: jest.fn(),
            workCount: jest.fn(),
            workCategoriesTags: jest.fn(),
        };
        taskLockService = { runExclusive: jest.fn() };
        service = new WorkCacheWarmupService(
            cacheManager as unknown as Cache,
            workRepository as unknown as WorkRepository,
            workQueryService as unknown as WorkQueryService,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
        debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('runExclusive uses works:cache-warmup key, 9-min ttl, debug onLocked', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);
        await service.warmWorkCaches();
        const [key, , opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('works:cache-warmup');
        expect(opts.ttlMs).toBe(9 * 60 * 1000);
        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping work cache warm-up because another instance holds the task lock',
        );
    });

    it('returns early when totalEligible is zero', async () => {
        workRepository.countForDetailCacheWarmup.mockResolvedValue(0);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });
        await service.warmWorkCaches();
        expect(workRepository.findForDetailCacheWarmup).not.toHaveBeenCalled();
        expect(cacheManager.set).not.toHaveBeenCalled();
    });

    it('warms a single work and sets all four cache entries with WORK_CACHE_TTL_MS', async () => {
        workRepository.countForDetailCacheWarmup.mockResolvedValue(1);
        const work = {
            id: 'w1',
            generateStatus: { status: 'COMPLETED' },
            user: { id: 'u1' },
        };
        workRepository.findForDetailCacheWarmup.mockResolvedValueOnce([work]);
        workQueryService.workItems.mockResolvedValue('items');
        workQueryService.workConfig.mockResolvedValue('config');
        workQueryService.workCount.mockResolvedValue('count');
        workQueryService.workCategoriesTags.mockResolvedValue('cats');

        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });
        await service.warmWorkCaches();

        expect(workRepository.findForDetailCacheWarmup).toHaveBeenCalledWith(25, 0);
        expect(cacheManager.set).toHaveBeenCalledWith(
            getWorkItemsCacheKey('w1', 'u1'),
            'items',
            WORK_CACHE_TTL_MS,
        );
        expect(cacheManager.set).toHaveBeenCalledWith(
            getWorkConfigCacheKey('w1', 'u1'),
            'config',
            WORK_CACHE_TTL_MS,
        );
        expect(cacheManager.set).toHaveBeenCalledWith(
            getWorkCountCacheKey('w1', 'u1'),
            'count',
            WORK_CACHE_TTL_MS,
        );
        expect(cacheManager.set).toHaveBeenCalledWith(
            getWorkCategoriesTagsCacheKey('w1', 'u1'),
            'cats',
            WORK_CACHE_TTL_MS,
        );
        // total-eligible<=BATCH so cursor is set to 0 with the 30-day TTL
        const cursorTtl = 1000 * 60 * 60 * 24 * 30;
        expect(cacheManager.set).toHaveBeenCalledWith('work-cache-warmup-offset', 0, cursorTtl);
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining(
                'Work detail cache warm-up completed: 1 warmed, 0 skipped, 0 errors',
            ),
        );
    });

    it('skips works with status=GENERATING and works without user.id', async () => {
        workRepository.countForDetailCacheWarmup.mockResolvedValue(2);
        workRepository.findForDetailCacheWarmup.mockResolvedValue([
            { id: 'gen', generateStatus: { status: 'GENERATING' }, user: { id: 'u1' } },
            { id: 'noUser', generateStatus: { status: 'COMPLETED' }, user: null },
        ]);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.warmWorkCaches();
        expect(workQueryService.workItems).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0 warmed, 2 skipped'));
    });

    it('counts errors when query services throw, logs the per-work warning', async () => {
        workRepository.countForDetailCacheWarmup.mockResolvedValue(1);
        workRepository.findForDetailCacheWarmup.mockResolvedValue([
            { id: 'w1', generateStatus: { status: 'COMPLETED' }, user: { id: 'u1' } },
        ]);
        workQueryService.workItems.mockRejectedValue(new Error('items down'));
        workQueryService.workConfig.mockResolvedValue('c');
        workQueryService.workCount.mockResolvedValue('c2');
        workQueryService.workCategoriesTags.mockResolvedValue('c3');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.warmWorkCaches();
        expect(warnSpy).toHaveBeenCalledWith('Failed to warm detail cache for work w1: items down');
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining('0 warmed, 0 skipped, 1 errors'),
        );
    });

    it('handles non-Error rejection in per-work warm path with String(error) in warn', async () => {
        workRepository.countForDetailCacheWarmup.mockResolvedValue(1);
        workRepository.findForDetailCacheWarmup.mockResolvedValue([
            { id: 'w1', generateStatus: { status: 'COMPLETED' }, user: { id: 'u1' } },
        ]);
        workQueryService.workItems.mockRejectedValue('network');
        workQueryService.workConfig.mockResolvedValue('c');
        workQueryService.workCount.mockResolvedValue('c2');
        workQueryService.workCategoriesTags.mockResolvedValue('c3');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.warmWorkCaches();
        expect(warnSpy).toHaveBeenCalledWith('Failed to warm detail cache for work w1: network');
    });

    it('uses cached cursor and advances offset when totalEligible exceeds batch size', async () => {
        // totalEligible=30, batch=25, currentOffset=10 from cache
        workRepository.countForDetailCacheWarmup.mockResolvedValue(30);
        cacheManager.get.mockResolvedValue(10);
        const works = Array.from({ length: 20 }, (_, i) => ({
            id: `w${i}`,
            generateStatus: { status: 'COMPLETED' },
            user: { id: 'u' },
        }));
        const wrapped = Array.from({ length: 5 }, (_, i) => ({
            id: `wr${i}`,
            generateStatus: { status: 'COMPLETED' },
            user: { id: 'u' },
        }));
        workRepository.findForDetailCacheWarmup
            .mockResolvedValueOnce(works) // first batch with offset=10, returned 20 (less than 25)
            .mockResolvedValueOnce(wrapped); // wrap-around second batch from offset 0, remainder 5
        workQueryService.workItems.mockResolvedValue('i');
        workQueryService.workConfig.mockResolvedValue('c');
        workQueryService.workCount.mockResolvedValue('cnt');
        workQueryService.workCategoriesTags.mockResolvedValue('t');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.warmWorkCaches();

        // Verify two repo calls: the first with (25, 10), then wrap with (5, 0)
        expect(workRepository.findForDetailCacheWarmup).toHaveBeenNthCalledWith(1, 25, 10);
        expect(workRepository.findForDetailCacheWarmup).toHaveBeenNthCalledWith(2, 5, 0);

        // nextOffset = (10 + 25) % 30 = 5
        const cursorTtl = 1000 * 60 * 60 * 24 * 30;
        expect(cacheManager.set).toHaveBeenCalledWith('work-cache-warmup-offset', 5, cursorTtl);
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining('25 warmed, 0 skipped, 0 errors, offset 10 -> 5'),
        );
    });

    it('coerces invalid cursor (string-non-numeric) to currentOffset=0', async () => {
        workRepository.countForDetailCacheWarmup.mockResolvedValue(30);
        cacheManager.get.mockResolvedValue('not-a-number');
        workRepository.findForDetailCacheWarmup.mockResolvedValueOnce([
            { id: 'w1', generateStatus: { status: 'COMPLETED' }, user: { id: 'u' } },
        ]);
        workRepository.findForDetailCacheWarmup.mockResolvedValueOnce([]);
        workQueryService.workItems.mockResolvedValue('i');
        workQueryService.workConfig.mockResolvedValue('c');
        workQueryService.workCount.mockResolvedValue('cnt');
        workQueryService.workCategoriesTags.mockResolvedValue('t');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });
        await service.warmWorkCaches();
        expect(workRepository.findForDetailCacheWarmup).toHaveBeenNthCalledWith(1, 25, 0);
    });

    it('resets cursor to 0 when current window yields zero works', async () => {
        workRepository.countForDetailCacheWarmup.mockResolvedValue(30);
        cacheManager.get.mockResolvedValue(0);
        workRepository.findForDetailCacheWarmup.mockResolvedValue([]);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.warmWorkCaches();
        const cursorTtl = 1000 * 60 * 60 * 24 * 30;
        expect(cacheManager.set).toHaveBeenCalledWith('work-cache-warmup-offset', 0, cursorTtl);
        expect(logSpy).not.toHaveBeenCalledWith(
            expect.stringContaining('Work detail cache warm-up completed'),
        );
    });

    it('logs the outer error stack and swallows when countForDetailCacheWarmup throws', async () => {
        const boom = new Error('count failed');
        workRepository.countForDetailCacheWarmup.mockRejectedValue(boom);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await expect(service.warmWorkCaches()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Error during work detail cache warm-up', boom.stack);
    });

    it('outer error handler uses String(error) for non-Error', async () => {
        workRepository.countForDetailCacheWarmup.mockRejectedValue('weird');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.warmWorkCaches();
        expect(errorSpy).toHaveBeenCalledWith('Error during work detail cache warm-up', 'weird');
    });
});
