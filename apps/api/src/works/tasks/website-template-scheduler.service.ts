import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { WorkRepository } from '@ever-works/agent/database';
import { Work } from '@ever-works/agent/entities';
import { WebsiteUpdateService } from '@ever-works/agent/generators';

@Injectable()
export class WebsiteTemplateSchedulerService {
    private readonly logger = new Logger(WebsiteTemplateSchedulerService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly websiteUpdateService: WebsiteUpdateService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    /**
     * Runs every hour to check for and apply website template updates
     */
    @Cron(CronExpression.EVERY_HOUR)
    async handleScheduledTemplateUpdates() {
        await this.taskLockService.runExclusive(
            'works:website-template-scheduler',
            async () => {
                // Skip if feature is disabled
                if (!config.websiteTemplate.autoUpdateEnabled()) {
                    return;
                }

                try {
                    const works =
                        await this.workRepository.findWithWebsiteAutoUpdateEnabled();

                    if (works.length === 0) {
                        return;
                    }

                    this.logger.log(
                        `Checking ${works.length} works for website template updates`,
                    );

                    for (const work of works) {
                        await this.processWorkUpdate(work);
                    }

                    this.logger.log('Website template update check completed');
                } catch (error) {
                    this.logger.error('Error during scheduled template update check', error.stack);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping website template scheduler because another instance holds the task lock',
                    ),
            },
        );
    }

    /**
     * Process a single work for template updates
     */
    private async processWorkUpdate(work: Work): Promise<void> {
        try {
            // Update last checked timestamp
            await this.workRepository.update(work.id, {
                websiteTemplateLastCheckedAt: new Date(),
            });

            // Check if update is available
            const updateCheck = await this.websiteUpdateService.checkForUpdate(work);

            // Handle token/connection errors
            if (updateCheck.error) {
                await this.workRepository.update(work.id, {
                    websiteTemplateLastError: updateCheck.error,
                });
                this.logger.warn(
                    `Cannot check updates for ${work.slug}: ${updateCheck.error}`,
                );
                return;
            }

            if (!updateCheck.updateAvailable) {
                this.logger.debug(
                    `No update available for work ${work.slug} (branch: ${updateCheck.branch})`,
                );
                return;
            }

            this.logger.log(
                `Update available for ${work.slug}: ${updateCheck.currentCommit || 'none'} -> ${updateCheck.latestCommit}`,
            );

            // Get the work owner to perform the update
            const workOwner = work.user;
            if (!workOwner) {
                this.logger.warn(`Work ${work.slug} has no user loaded, skipping update`);
                return;
            }

            // Perform the update
            const result = await this.websiteUpdateService.updateRepository(
                work,
                workOwner,
                {
                    branch: updateCheck.branch,
                },
            );

            // Update work with success status
            await this.workRepository.update(work.id, {
                websiteTemplateLastCommit: result.commitSha || updateCheck.latestCommit,
                websiteTemplateLastUpdatedAt: new Date(),
                websiteTemplateLastError: null,
            });

            this.logger.log(`Successfully updated ${work.slug} using ${result.method} method`);
        } catch (error) {
            // Store error for UI display
            const errorMessage =
                error instanceof Error ? error.message : 'Unknown error during template update';

            await this.workRepository.update(work.id, {
                websiteTemplateLastError: errorMessage,
            });

            this.logger.error(
                `Failed to update template for work ${work.slug}: ${errorMessage}`,
            );
        }
    }
}
