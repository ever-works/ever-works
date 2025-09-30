import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DirectoryRepository } from '@packages/agent/database';
import { Directory, GenerateStatusType } from '@packages/agent/entities';

@Injectable()
export class DirectoryCleanupService {
    private readonly logger = new Logger(DirectoryCleanupService.name);

    constructor(private readonly repository: DirectoryRepository) {}

    // Runs every 5 minutes
    @Cron(CronExpression.EVERY_10_MINUTES)
    async handleStalledGenerations() {
        try {
            const oneHourAgo = new Date();
            oneHourAgo.setHours(oneHourAgo.getHours() - 1);

            const stalledDirectories = await this.repository.getUnfinishedGenerations(oneHourAgo);

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

    private async handleStalledDirectory(directory: Directory) {
        await Promise.all([
            this.repository.recordGenerationFinishTime(directory.id, new Date()),
            this.repository.updateGenerateStatus(directory.id, {
                status: GenerateStatusType.ERROR,
                error: 'Generation stalled',
            }),
        ]);
    }
}
