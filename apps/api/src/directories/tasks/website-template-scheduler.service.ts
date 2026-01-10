import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { config } from '@packages/agent/config';
import { DirectoryRepository } from '@packages/agent/database';
import { Directory } from '@packages/agent/entities';
import { WebsiteUpdateService } from '@packages/agent/website-generator';

@Injectable()
export class WebsiteTemplateSchedulerService {
    private readonly logger = new Logger(WebsiteTemplateSchedulerService.name);

    constructor(
        private readonly directoryRepository: DirectoryRepository,
        private readonly websiteUpdateService: WebsiteUpdateService,
    ) {}

    /**
     * Runs every hour to check for and apply website template updates
     */
    @Cron(CronExpression.EVERY_HOUR)
    async handleScheduledTemplateUpdates() {
        // Skip if feature is disabled
        if (!config.websiteTemplate.autoUpdateEnabled()) {
            return;
        }

        try {
            const directories = await this.directoryRepository.findWithWebsiteAutoUpdateEnabled();

            if (directories.length === 0) {
                return;
            }

            this.logger.log(
                `Checking ${directories.length} directories for website template updates`,
            );

            for (const directory of directories) {
                await this.processDirectoryUpdate(directory);
            }

            this.logger.log('Website template update check completed');
        } catch (error) {
            this.logger.error('Error during scheduled template update check', error.stack);
        }
    }

    /**
     * Process a single directory for template updates
     */
    private async processDirectoryUpdate(directory: Directory): Promise<void> {
        try {
            // Update last checked timestamp
            await this.directoryRepository.update(directory.id, {
                websiteTemplateLastCheckedAt: new Date(),
            });

            // Check if update is available
            const updateCheck = await this.websiteUpdateService.checkForUpdate(directory);

            // Handle token/connection errors
            if (updateCheck.error) {
                await this.directoryRepository.update(directory.id, {
                    websiteTemplateLastError: updateCheck.error,
                });
                this.logger.warn(
                    `Cannot check updates for ${directory.slug}: ${updateCheck.error}`,
                );
                return;
            }

            if (!updateCheck.updateAvailable) {
                this.logger.debug(
                    `No update available for directory ${directory.slug} (branch: ${updateCheck.branch})`,
                );
                return;
            }

            this.logger.log(
                `Update available for ${directory.slug}: ${updateCheck.currentCommit || 'none'} -> ${updateCheck.latestCommit}`,
            );

            // Get the directory owner to perform the update
            const directoryOwner = directory.user;
            if (!directoryOwner) {
                this.logger.warn(`Directory ${directory.slug} has no user loaded, skipping update`);
                return;
            }

            // Perform the update
            const result = await this.websiteUpdateService.updateRepository(
                directory,
                directoryOwner,
                {
                    branch: updateCheck.branch,
                },
            );

            // Update directory with success status
            await this.directoryRepository.update(directory.id, {
                websiteTemplateLastCommit: result.commitSha || updateCheck.latestCommit,
                websiteTemplateLastUpdatedAt: new Date(),
                websiteTemplateLastError: null,
            });

            this.logger.log(`Successfully updated ${directory.slug} using ${result.method} method`);
        } catch (error) {
            // Store error for UI display
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error during template update';

            await this.directoryRepository.update(directory.id, {
                websiteTemplateLastError: errorMessage,
            });

            this.logger.error(
                `Failed to update template for directory ${directory.slug}: ${errorMessage}`,
            );
        }
    }
}
