import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheEntryRepository, DistributedTaskLockService } from '@ever-works/agent/cache';
import { WorkRepository, WorkGenerationHistoryRepository } from '@ever-works/agent/database';
import { Work, GenerateStatusType } from '@ever-works/agent/entities';
import { WorkGenerationCompletedEvent } from '@ever-works/agent/events';
import { config } from '@src/config/constants';

@Injectable()
export class WorkCleanupService {
    private readonly logger = new Logger(WorkCleanupService.name);

    constructor(
        private readonly repository: WorkRepository,
        private readonly cacheRepository: CacheEntryRepository,
        private readonly generationHistoryRepository: WorkGenerationHistoryRepository,
        private readonly eventEmitter: EventEmitter2,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    // Runs every 10 minutes
    @Cron(CronExpression.EVERY_10_MINUTES)
    async handleStalledGenerations() {
        await this.taskLockService.runExclusive(
            'works:cleanup',
            async () => {
                try {
                    const staleThreshold = new Date();
                    staleThreshold.setHours(
                        staleThreshold.getHours() - config.work.staleTimeoutHours(),
                    );

                    const stalledWorks =
                        await this.repository.getUnfinishedGenerations(staleThreshold);

                    if (stalledWorks.length > 0) {
                        this.logger.log(`Found ${stalledWorks.length} stalled generation(s)`);
                    }

                    for (const work of stalledWorks) {
                        await this.handleStalledWork(work);
                    }

                    if (stalledWorks.length > 0) {
                        this.logger.log('Stalled generation check completed');
                    }

                    await this.recoverStuckHistoryRecords();
                } catch (error: any) {
                    this.logger.error(
                        'Error checking stalled generations',
                        'stack' in error ? error.stack : String(error),
                    );
                }
            },
            {
                ttlMs: 9 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping work cleanup because another instance holds the task lock',
                    ),
            },
        );
    }

    // Clear cache for generated work
    @OnEvent(WorkGenerationCompletedEvent.EVENT_NAME)
    clearWorkCache(data: WorkGenerationCompletedEvent) {
        this.cacheRepository.typeormAdapter
            .deleteUnscopedEntriesLike(data.work.id)
            .then(() => {
                this.logger.log(`Cache cleared for work ${data.work.id}`);
            })
            .catch((err) => {
                this.logger.error('Failed to clear cache:', err);
            });
    }

    private async recoverStuckHistoryRecords(): Promise<void> {
        const stuckRecords = await this.generationHistoryRepository.findOrphanedGenerating();

        if (stuckRecords.length === 0) return;

        this.logger.log(
            `Found ${stuckRecords.length} orphaned history record(s), marking as error`,
        );

        for (const record of stuckRecords) {
            await this.generationHistoryRepository.updateEntry(record.id, {
                status: GenerateStatusType.ERROR,
                errorMessage: 'Generation stalled — automatically recovered',
                finishedAt: new Date(),
            });
        }
    }

    private async handleStalledWork(work: Work) {
        const promises = [this.repository.recordGenerationFinishTime(work.id, new Date())];

        if (work.generateStatus.status === GenerateStatusType.GENERATING) {
            promises.push(
                this.repository.updateGenerateStatus(work.id, {
                    status: GenerateStatusType.ERROR,
                    error: 'Generation stalled',
                }),
            );
        }

        await Promise.all(promises);

        const updatedWork = await this.repository.findById(work.id);

        if (updatedWork) {
            this.eventEmitter.emit(
                WorkGenerationCompletedEvent.EVENT_NAME,
                new WorkGenerationCompletedEvent(updatedWork),
            );
        }
    }
}
