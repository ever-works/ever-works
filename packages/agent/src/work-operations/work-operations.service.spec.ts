import { WorkGenerationHistoryRepository, WorkRepository } from '@src/database';
import { GenerateStatusType } from '@src/entities/types';
import type { Work } from '@src/entities/work.entity';
import type { GenerationStepLog } from '@ever-works/contracts/api';
import { WorkOperationsService } from './work-operations.service';

describe('WorkOperationsService', () => {
    let workRepository: jest.Mocked<WorkRepository>;
    let generationHistoryRepository: jest.Mocked<WorkGenerationHistoryRepository>;
    let service: WorkOperationsService;

    beforeEach(() => {
        workRepository = {
            findById: jest.fn(),
            updateGenerateStatus: jest.fn(),
        } as unknown as jest.Mocked<WorkRepository>;

        generationHistoryRepository = {
            appendLogs: jest.fn(),
            updateEntry: jest.fn(),
        } as unknown as jest.Mocked<WorkGenerationHistoryRepository>;

        service = new WorkOperationsService(workRepository, generationHistoryRepository);
    });

    it('serializes generate-status writes so recent logs do not overwrite a concurrent status update', async () => {
        let releaseFirstUpdate!: () => void;
        const firstUpdateDone = new Promise<void>((resolve) => {
            releaseFirstUpdate = resolve;
        });

        let currentStatus: Work['generateStatus'] = {
            status: GenerateStatusType.GENERATING,
            step: 'collecting',
            warnings: ['duplicate', 'duplicate'],
        };

        workRepository.findById.mockImplementation(async () => {
            return { generateStatus: currentStatus } as Work;
        });

        workRepository.updateGenerateStatus
            .mockImplementationOnce(async (_id, status) => {
                await firstUpdateDone;
                currentStatus = status;
            })
            .mockImplementation(async (_id, status) => {
                currentStatus = status;
            });

        const nextStatus: Work['generateStatus'] = {
            status: GenerateStatusType.GENERATED,
            step: null,
            warnings: ['duplicate', 'final-warning'],
        };
        const recentLogs: GenerationStepLog[] = [
            {
                timestamp: new Date().toISOString(),
                level: 'info',
                source: 'orchestrator',
                event: 'message',
                message: 'generation still running',
            },
        ];

        const statusUpdatePromise = service.updateGenerateStatus('dir-1', nextStatus);
        const recentLogsUpdatePromise = service.updateGenerateRecentLogs('dir-1', recentLogs);

        await Promise.resolve();

        expect(workRepository.findById).not.toHaveBeenCalled();

        releaseFirstUpdate();

        await Promise.all([statusUpdatePromise, recentLogsUpdatePromise]);

        expect(workRepository.updateGenerateStatus).toHaveBeenNthCalledWith(1, 'dir-1', {
            status: GenerateStatusType.GENERATED,
            step: null,
            warnings: ['duplicate', 'final-warning'],
        });
        expect(workRepository.updateGenerateStatus).toHaveBeenNthCalledWith(2, 'dir-1', {
            status: GenerateStatusType.GENERATED,
            step: null,
            warnings: ['duplicate', 'final-warning'],
            recentLogs,
        });
        expect(currentStatus).toEqual({
            status: GenerateStatusType.GENERATED,
            step: null,
            warnings: ['duplicate', 'final-warning'],
            recentLogs,
        });
    });

    it('continues processing queued generate-status updates after a failure', async () => {
        let currentStatus: Work['generateStatus'] = {
            status: GenerateStatusType.GENERATING,
        };

        workRepository.findById.mockImplementation(async () => {
            return { generateStatus: currentStatus } as Work;
        });

        workRepository.updateGenerateStatus
            .mockRejectedValueOnce(new Error('failed update'))
            .mockImplementation(async (_id, status) => {
                currentStatus = status;
            });

        await expect(
            service.updateGenerateStatus('dir-2', {
                status: GenerateStatusType.ERROR,
            }),
        ).rejects.toThrow('failed update');

        const recentLogs: GenerationStepLog[] = [
            {
                timestamp: new Date().toISOString(),
                level: 'info',
                source: 'orchestrator',
                event: 'message',
                message: 'retry log flush',
            },
        ];

        await expect(
            service.updateGenerateRecentLogs('dir-2', recentLogs),
        ).resolves.toBeUndefined();
        expect(currentStatus).toEqual({
            status: GenerateStatusType.GENERATING,
            recentLogs,
        });
    });
});
