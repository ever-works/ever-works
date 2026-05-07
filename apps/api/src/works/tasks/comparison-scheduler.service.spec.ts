jest.mock('@ever-works/agent/comparison-generator', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({}));

import { ComparisonSchedulerService } from './comparison-scheduler.service';
import type { ComparisonGenerationService } from '@ever-works/agent/comparison-generator';
import type { WorkRepository } from '@ever-works/agent/database';
import type { DistributedTaskLockService } from '@ever-works/agent/cache';

describe('ComparisonSchedulerService', () => {
    let comparisonService: { generateNextComparison: jest.Mock };
    let workRepository: { findWithComparisonsEnabled: jest.Mock };
    let taskLockService: { runExclusive: jest.Mock };
    let service: ComparisonSchedulerService;
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
        comparisonService = { generateNextComparison: jest.fn() };
        workRepository = { findWithComparisonsEnabled: jest.fn() };
        taskLockService = { runExclusive: jest.fn() };
        service = new ComparisonSchedulerService(
            comparisonService as unknown as ComparisonGenerationService,
            workRepository as unknown as WorkRepository,
            taskLockService as unknown as DistributedTaskLockService,
        );
        logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
        debugSpy = jest.spyOn((service as any).logger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('runExclusive uses works:comparison-scheduler key, 1h ttl, debug onLocked', async () => {
        taskLockService.runExclusive.mockResolvedValue(undefined);

        await service.handleComparisonGeneration();

        const [key, work, opts] = taskLockService.runExclusive.mock.calls[0];
        expect(key).toBe('works:comparison-scheduler');
        expect(typeof work).toBe('function');
        expect(opts.ttlMs).toBe(60 * 60 * 1000);
        opts.onLocked();
        expect(debugSpy).toHaveBeenCalledWith(
            'Skipping scheduled comparison generation because another instance holds the task lock',
        );
    });

    it('returns early with zero counts when there are no eligible works', async () => {
        workRepository.findWithComparisonsEnabled.mockResolvedValue([]);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleComparisonGeneration();
        expect(comparisonService.generateNextComparison).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith('Starting scheduled comparison generation');
        expect(logSpy).toHaveBeenCalledWith(
            'Comparison generation completed: 0 generated, 0 skipped, 0 errors',
        );
    });

    it('counts generated/skipped/errors and forwards { respectCadence: true }', async () => {
        const works = [
            { id: 'w1', userId: 'u1' },
            { id: 'w2', userId: 'u2' },
            { id: 'w3', userId: 'u3' },
            { id: 'w4', userId: 'u4' },
        ];
        workRepository.findWithComparisonsEnabled.mockResolvedValue(works);

        comparisonService.generateNextComparison
            .mockResolvedValueOnce({ status: 'success', slug: 'foo-vs-bar' })
            .mockResolvedValueOnce({ status: 'skipped' })
            .mockResolvedValueOnce({ status: 'success', slug: 'baz-vs-qux' })
            .mockRejectedValueOnce(new Error('per-work failure'));

        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleComparisonGeneration();

        expect(comparisonService.generateNextComparison).toHaveBeenCalledTimes(4);
        works.forEach((work) => {
            expect(comparisonService.generateNextComparison).toHaveBeenCalledWith(
                work.id,
                work.userId,
                { respectCadence: true },
            );
        });

        expect(logSpy).toHaveBeenCalledWith('Generated comparison for work w1: foo-vs-bar');
        expect(logSpy).toHaveBeenCalledWith('Generated comparison for work w3: baz-vs-qux');
        expect(errorSpy).toHaveBeenCalledWith(
            'Failed to generate comparison for work w4: per-work failure',
        );
        expect(logSpy).toHaveBeenCalledWith(
            'Comparison generation completed: 2 generated, 1 skipped, 1 errors',
        );
    });

    it('treats a non-Error rejection as String(error) in the per-work error log', async () => {
        workRepository.findWithComparisonsEnabled.mockResolvedValue([{ id: 'w1', userId: 'u1' }]);
        comparisonService.generateNextComparison.mockRejectedValue('rate limit');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleComparisonGeneration();
        expect(errorSpy).toHaveBeenCalledWith(
            'Failed to generate comparison for work w1: rate limit',
        );
    });

    it('does not increment generated/skipped on unknown status values', async () => {
        workRepository.findWithComparisonsEnabled.mockResolvedValue([{ id: 'w1', userId: 'u1' }]);
        comparisonService.generateNextComparison.mockResolvedValue({ status: 'pending' });
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleComparisonGeneration();
        expect(logSpy).toHaveBeenCalledWith(
            'Comparison generation completed: 0 generated, 0 skipped, 0 errors',
        );
    });

    it('logs error stack when findWithComparisonsEnabled throws Error', async () => {
        const boom = new Error('db unavailable');
        workRepository.findWithComparisonsEnabled.mockRejectedValue(boom);
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await expect(service.handleComparisonGeneration()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Error during comparison generation', boom.stack);
    });

    it('logs error with String(error) when outer rejection is not an Error', async () => {
        workRepository.findWithComparisonsEnabled.mockRejectedValue('outer-string');
        taskLockService.runExclusive.mockImplementation(async (_k, w) => {
            await w();
        });

        await service.handleComparisonGeneration();
        expect(errorSpy).toHaveBeenCalledWith('Error during comparison generation', 'outer-string');
    });
});
