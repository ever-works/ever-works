import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheEntryRepository } from '@packages/agent/cache';
import { DirectoryRepository } from '@packages/agent/database';
import { Directory, GenerateStatusType } from '@packages/agent/entities';
import { DirectoryGenerationCompletedEvent } from '@packages/agent/events';
import { config } from '@src/config/constants';

@Injectable()
export class DirectoryCleanupService {
    private readonly logger = new Logger(DirectoryCleanupService.name);

    constructor(
        private readonly repository: DirectoryRepository,
        private readonly cacheRepository: CacheEntryRepository,
    ) {}

    // Runs every 10 minutes
    @Cron(CronExpression.EVERY_10_MINUTES)
    async handleStalledGenerations() {
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

            // Process each stalled directory
            for (const directory of stalledDirectories) {
                await this.handleStalledDirectory(directory);
            }

            if (stalledDirectories.length > 0) {
                this.logger.log('Stalled generation check completed');
            }
        } catch (error) {
            this.logger.error('Error checking stalled generations', error.stack);
        }
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
    }
}
