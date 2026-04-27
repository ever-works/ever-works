import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheEntryRepository, DistributedTaskLockService } from '@ever-works/agent/cache';
import {
    DirectoryRepository,
    DirectoryGenerationHistoryRepository,
} from '@ever-works/agent/database';
import { Directory, GenerateStatusType } from '@ever-works/agent/entities';
import { DirectoryGenerationCompletedEvent } from '@ever-works/agent/events';
import { config } from '@src/config/constants';

@Injectable()
export class DirectoryCleanupService {
    private readonly logger = new Logger(DirectoryCleanupService.name);

    constructor(
        private readonly repository: DirectoryRepository,
        private readonly cacheRepository: CacheEntryRepository,
        private readonly generationHistoryRepository: DirectoryGenerationHistoryRepository,
        private readonly eventEmitter: EventEmitter2,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    // Runs every 10 minutes
    @Cron(CronExpression.EVERY_10_MINUTES)
    async handleStalledGenerations() {
        await this.taskLockService.runExclusive(
            'directories:cleanup',
            async () => {
                try {
                    const staleThreshold = new Date();
                    staleThreshold.setHours(
                        staleThreshold.getHours() - config.directory.staleTimeoutHours(),
                    );

                    const stalledDirectories =
                        await this.repository.getUnfinishedGenerations(staleThreshold);

                    if (stalledDirectories.length > 0) {
                        this.logger.log(`Found ${stalledDirectories.length} stalled generation(s)`);
                    }

                    for (const directory of stalledDirectories) {
                        await this.handleStalledDirectory(directory);
                    }

                    if (stalledDirectories.length > 0) {
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
                        'Skipping directory cleanup because another instance holds the task lock',
                    ),
            },
        );
    }

    // Clear cache for generated directory
    @OnEvent(DirectoryGenerationCompletedEvent.EVENT_NAME)
    clearDirectoryCache(data: DirectoryGenerationCompletedEvent) {
        this.cacheRepository.typeormAdapter
            .deleteUnscopedEntriesLike(data.directory.id)
            .then(() => {
                this.logger.log(`Cache cleared for directory ${data.directory.id}`);
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

    private async handleStalledDirectory(directory: Directory) {
        const promises = [this.repository.recordGenerationFinishTime(directory.id, new Date())];

        if (directory.generateStatus.status === GenerateStatusType.GENERATING) {
            promises.push(
                this.repository.updateGenerateStatus(directory.id, {
                    status: GenerateStatusType.ERROR,
                    error: 'Generation stalled',
                }),
            );
        }

        await Promise.all(promises);

        const updatedDirectory = await this.repository.findById(directory.id);

        if (updatedDirectory) {
            this.eventEmitter.emit(
                DirectoryGenerationCompletedEvent.EVENT_NAME,
                new DirectoryGenerationCompletedEvent(updatedDirectory),
            );
        }
    }
}
