import { DirectoryGenerationHistoryRepository, DirectoryRepository } from '@src/database';
import { GenerateStatusType } from '@src/entities/types';
import type { Directory } from '@src/entities/directory.entity';
import type { GenerationStepLog } from '@ever-works/contracts/api';
import { DirectoryOperationsService } from './directory-operations.service';

describe('DirectoryOperationsService', () => {
    let directoryRepository: jest.Mocked<DirectoryRepository>;
    let generationHistoryRepository: jest.Mocked<DirectoryGenerationHistoryRepository>;
    let service: DirectoryOperationsService;

    beforeEach(() => {
        directoryRepository = {
            findById: jest.fn(),
            updateGenerateStatus: jest.fn(),
        } as unknown as jest.Mocked<DirectoryRepository>;

        generationHistoryRepository = {
            appendLogs: jest.fn(),
            updateEntry: jest.fn(),
        } as unknown as jest.Mocked<DirectoryGenerationHistoryRepository>;

        service = new DirectoryOperationsService(directoryRepository, generationHistoryRepository);
    });

    it('serializes generate-status writes so recent logs do not overwrite a concurrent status update', async () => {
        let releaseFirstUpdate!: () => void;
        const firstUpdateDone = new Promise<void>((resolve) => {
            releaseFirstUpdate = resolve;
        });

        let currentStatus: Directory['generateStatus'] = {
            status: GenerateStatusType.GENERATING,
            step: 'collecting',
            warnings: ['duplicate', 'duplicate'],
        };

        directoryRepository.findById.mockImplementation(async () => {
            return { generateStatus: currentStatus } as Directory;
        });

        directoryRepository.updateGenerateStatus
            .mockImplementationOnce(async (_id, status) => {
                await firstUpdateDone;
                currentStatus = status;
            })
            .mockImplementation(async (_id, status) => {
                currentStatus = status;
            });

        const nextStatus: Directory['generateStatus'] = {
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

        expect(directoryRepository.findById).not.toHaveBeenCalled();

        releaseFirstUpdate();

        await Promise.all([statusUpdatePromise, recentLogsUpdatePromise]);

        expect(directoryRepository.updateGenerateStatus).toHaveBeenNthCalledWith(1, 'dir-1', {
            status: GenerateStatusType.GENERATED,
            step: null,
            warnings: ['duplicate', 'final-warning'],
        });
        expect(directoryRepository.updateGenerateStatus).toHaveBeenNthCalledWith(2, 'dir-1', {
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
        let currentStatus: Directory['generateStatus'] = {
            status: GenerateStatusType.GENERATING,
        };

        directoryRepository.findById.mockImplementation(async () => {
            return { generateStatus: currentStatus } as Directory;
        });

        directoryRepository.updateGenerateStatus
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
