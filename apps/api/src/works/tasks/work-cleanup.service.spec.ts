jest.mock('@ever-works/agent/cache', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    GenerateStatusType: {
        GENERATING: 'GENERATING',
        COMPLETED: 'COMPLETED',
        ERROR: 'ERROR',
    },
}));
jest.mock('@ever-works/agent/events', () => ({
    WorkGenerationCompletedEvent: class WorkGenerationCompletedEvent {
        static EVENT_NAME = 'work.generation.completed';
        constructor(public readonly work: any) {}
    },
}));
jest.mock('@src/config/constants', () => ({
    config: {
        work: {
            staleTimeoutHours: jest.fn(() => 2),
        },
    },
}));

import { WorkCleanupService } from './work-cleanup.service';
import {
    WorkGenerationCompletedEvent,
    // type-side import
} from '@ever-works/agent/events';
import { GenerateStatusType } from '@ever-works/agent/entities';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type {
    CacheEntryRepository,
    DistributedTaskLockService,
} from '@ever-works/agent/cache';
import type {
    WorkRepository,
    WorkGenerationHistoryRepository,
} from '@ever-works/agent/database';

describe('WorkCleanupService', () => {
    let workRepository: {
        getUnfinishedGenerations: jest.Mock;
        recordGenerationFinishTime: jest.Mock;
        updateGenerateStatus: jest.Mock;
        findById: jest.Mock;
    };
    let cacheRepository: {
        typeormAdapter: { deleteUnscopedEntriesLike: jest.Mock };
    };
    let generationHistoryRepository: {
        findOrphanedGenerating: jest.Mock;
        updateEntry: jest.Mock;
    };
    let eventEmitter: { emit: jest.Mock };
    let taskLockService: { runExclusive: jest.Mock };
    let service: WorkCleanupService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        workRepository = {
            getUnfinishedGenerations: jest.fn().mockResolvedValue([]),
            recordGenerationFinishTime: jest.fn().mockResolvedValue(undefined),
            updateGenerateStatus: jest.fn().mockResolvedValue(undefined),
            findById: jest.fn().mockResolvedValue(null),
        };
        cacheRepository = {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn() },
        };
        generationHistoryRepository = {
            findOrphanedGenerating: jest.fn().mockResolvedValue([]),
            updateEntry: jest.fn().mockResolvedValue(undefined),
        };
        eventEmitter = { emit: jest.fn() };
        taskLockService = { runExclusive: jest.fn() };

        service = new WorkCleanupService(
            workRepository as unknown as WorkRepository,
            cacheRepository as unknown as CacheEntryRepository,
            generationHistoryRepository as unknown as WorkGenerationHistoryRepository,
            eventEmitter as unknown as EventEmitter2,
            taskLockService as unknown as DistributedTaskLockService,
        );
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

    it('runExclusive uses works:cleanup key, 9-min ttl, debug onLocked', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);
        await service.handleStalledGenerations();
        const [key, , opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('works:cleanup');
        expect(opts.ttlMs).toBe(9 * 60 * 1000);
        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping work cleanup because another instance holds the task lock',
        );
    });

    it('uses staleTimeoutHours config to compute the staleThreshold passed to repository', async () => {
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });
        const before = Date.now();
        await service.handleStalledGenerations();
        const after = Date.now();
        expect(workRepository.getUnfinishedGenerations).toHaveBeenCalledTimes(1);
        const arg = workRepository.getUnfinishedGenerations.mock.calls[0][0] as Date;
        expect(arg).toBeInstanceOf(Date);
        const diffMs = before - arg.getTime();
        // staleTimeoutHours mock returns 2 → threshold ≈ now - 2h
        const expectedMs = 2 * 60 * 60 * 1000;
        expect(diffMs).toBeGreaterThanOrEqual(expectedMs - 1000);
        expect(diffMs).toBeLessThanOrEqual(after - arg.getTime());
    });

    it('does not log when there are no stalled works and no orphaned history records', async () => {
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });
        await service.handleStalledGenerations();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('marks GENERATING stalled works as ERROR, finishes them, refetches, and emits event', async () => {
        const stalled = {
            id: 'w-gen',
            generateStatus: { status: GenerateStatusType.GENERATING },
        };
        workRepository.getUnfinishedGenerations.mockResolvedValue([stalled]);
        const updatedWork = { id: 'w-gen', generateStatus: { status: GenerateStatusType.ERROR } };
        workRepository.findById.mockResolvedValue(updatedWork);

        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });
        await service.handleStalledGenerations();

        expect(workRepository.recordGenerationFinishTime).toHaveBeenCalledWith(
            'w-gen',
            expect.any(Date),
        );
        expect(workRepository.updateGenerateStatus).toHaveBeenCalledWith('w-gen', {
            status: GenerateStatusType.ERROR,
            error: 'Generation stalled',
        });
        expect(workRepository.findById).toHaveBeenCalledWith('w-gen');
        const [eventName, eventArg] = eventEmitter.emit.mock.calls[0];
        expect(eventName).toBe('work.generation.completed');
        expect(eventArg).toBeInstanceOf(WorkGenerationCompletedEvent);
        expect((eventArg as WorkGenerationCompletedEvent).work).toBe(updatedWork);
        expect(logSpy).toHaveBeenCalledWith('Found 1 stalled generation(s)');
        expect(logSpy).toHaveBeenCalledWith('Stalled generation check completed');
    });

    it('does not call updateGenerateStatus for stalled works that are not GENERATING', async () => {
        const stalled = {
            id: 'w-error',
            generateStatus: { status: GenerateStatusType.ERROR },
        };
        workRepository.getUnfinishedGenerations.mockResolvedValue([stalled]);
        workRepository.findById.mockResolvedValue(stalled);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleStalledGenerations();
        expect(workRepository.recordGenerationFinishTime).toHaveBeenCalledWith(
            'w-error',
            expect.any(Date),
        );
        expect(workRepository.updateGenerateStatus).not.toHaveBeenCalled();
        expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    });

    it('does not emit when refetched work is null', async () => {
        const stalled = {
            id: 'w1',
            generateStatus: { status: GenerateStatusType.GENERATING },
        };
        workRepository.getUnfinishedGenerations.mockResolvedValue([stalled]);
        workRepository.findById.mockResolvedValue(null);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleStalledGenerations();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('recovers orphaned history records by marking them ERROR', async () => {
        generationHistoryRepository.findOrphanedGenerating.mockResolvedValue([
            { id: 'h1' },
            { id: 'h2' },
        ]);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleStalledGenerations();
        expect(logSpy).toHaveBeenCalledWith(
            'Found 2 orphaned history record(s), marking as error',
        );
        expect(generationHistoryRepository.updateEntry).toHaveBeenCalledTimes(2);
        const firstUpdate = generationHistoryRepository.updateEntry.mock.calls[0];
        expect(firstUpdate[0]).toBe('h1');
        expect(firstUpdate[1]).toEqual({
            status: GenerateStatusType.ERROR,
            errorMessage: 'Generation stalled — automatically recovered',
            finishedAt: expect.any(Date),
        });
    });

    it('logs error stack when getUnfinishedGenerations throws Error and swallows', async () => {
        const boom = new Error('db down');
        workRepository.getUnfinishedGenerations.mockRejectedValue(boom);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await expect(service.handleStalledGenerations()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Error checking stalled generations', boom.stack);
    });

    it('logs String(error) when thrown value is not an Error', async () => {
        workRepository.getUnfinishedGenerations.mockRejectedValue({
            // no `stack`
            details: 'hello',
        });
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleStalledGenerations();
        expect(errorSpy).toHaveBeenCalledWith(
            'Error checking stalled generations',
            '[object Object]',
        );
    });

    describe('clearWorkCache (event handler)', () => {
        it('deletes cache entries by work id and logs success', async () => {
            cacheRepository.typeormAdapter.deleteUnscopedEntriesLike.mockResolvedValue(undefined);
            const event = new WorkGenerationCompletedEvent({ id: 'w42' } as any);
            service.clearWorkCache(event);
            // wait microtasks so the .then() runs
            await Promise.resolve();
            await Promise.resolve();
            expect(
                cacheRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w42');
            expect(logSpy).toHaveBeenCalledWith('Cache cleared for work w42');
        });

        it('logs error when cache clear fails', async () => {
            const err = new Error('redis down');
            cacheRepository.typeormAdapter.deleteUnscopedEntriesLike.mockRejectedValue(err);
            const event = new WorkGenerationCompletedEvent({ id: 'w99' } as any);
            service.clearWorkCache(event);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(errorSpy).toHaveBeenCalledWith('Failed to clear cache:', err);
        });
    });
});
