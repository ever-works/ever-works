import { WorkGenerationHistoryRepository, WorkRepository } from '@src/database';
import { GenerateStatusType } from '@src/entities/types';
import type { Work } from '@src/entities/work.entity';
import type { GenerationStepLog } from '@ever-works/contracts/api';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkGenerationCompletedEvent } from '@src/events';
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

    // The Trigger.dev worker proxies this service over the internal RPC, so its
    // orchestrators' `finally { emitGenerationCompleted(work.id) }` runs HERE, in
    // the API process, on the API's emitter. `WorkCleanupService.clearWorkCache`
    // listens for this event and clears the Work's items/config/count/taxonomy
    // caches. Since `POST /api/works/:id/sync-data` stopped invalidating caches
    // on an unchanged sync (`updated: []`), this event is what keeps the Items
    // tab fresh after a Trigger.dev-hosted generation finishes (the generator
    // has already written `itemsCount`, so the page's post-generation sync is a
    // no-op).
    describe('emitGenerationCompleted', () => {
        it('emits WorkGenerationCompletedEvent carrying the reloaded Work', async () => {
            const eventEmitter = new EventEmitter2();
            const received: WorkGenerationCompletedEvent[] = [];
            eventEmitter.on(WorkGenerationCompletedEvent.EVENT_NAME, (event) => {
                received.push(event);
            });
            const reloaded = {
                id: 'dir-3',
                generateStatus: { status: GenerateStatusType.GENERATED },
            } as Work;
            workRepository.findById.mockResolvedValue(reloaded);
            service = new WorkOperationsService(
                workRepository,
                generationHistoryRepository,
                eventEmitter,
            );

            await service.emitGenerationCompleted('dir-3');

            expect(workRepository.findById).toHaveBeenCalledWith('dir-3');
            expect(received).toHaveLength(1);
            expect(received[0]).toBeInstanceOf(WorkGenerationCompletedEvent);
            expect(received[0].work).toBe(reloaded);
        });

        it('emits nothing when the Work no longer exists', async () => {
            const eventEmitter = new EventEmitter2();
            const listener = jest.fn();
            eventEmitter.on(WorkGenerationCompletedEvent.EVENT_NAME, listener);
            workRepository.findById.mockResolvedValue(null);
            service = new WorkOperationsService(
                workRepository,
                generationHistoryRepository,
                eventEmitter,
            );

            await service.emitGenerationCompleted('gone');

            expect(listener).not.toHaveBeenCalled();
        });
    });
});
