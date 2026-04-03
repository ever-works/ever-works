import { Injectable, Logger } from '@nestjs/common';
import { config } from '@src/config';
import { DirectoryScheduleRepository } from '@src/database/repositories/directory-schedule.repository';
import { DirectoryGenerationService } from './directory-generation.service';
import { DirectoryScheduleService } from './directory-schedule.service';

@Injectable()
export class DirectoryScheduleDispatcherService {
    private readonly logger = new Logger(DirectoryScheduleDispatcherService.name);

    constructor(
        private readonly scheduleRepository: DirectoryScheduleRepository,
        private readonly directoryGenerationService: DirectoryGenerationService,
        private readonly directoryScheduleService: DirectoryScheduleService,
    ) {}

    async dispatchDue(limit = config.subscriptions.getMaxBatch()): Promise<number> {
        if (!config.subscriptions.scheduledUpdatesEnabled()) {
            this.logger.warn('Scheduled updates disabled, skipping dispatch');
            return 0;
        }

        // Step 0: Cleanup zombies
        await this.directoryScheduleService.recoverStuckSchedules();

        const schedules = await this.scheduleRepository.findDue(limit);
        let dispatched = 0;

        for (const schedule of schedules) {
            try {
                const reservedSchedule =
                    (await this.directoryScheduleService.markRunDispatched(schedule.id)) || null;

                if (!reservedSchedule) {
                    this.logger.warn(`Schedule ${schedule.id} was already dispatched, skipping`);
                    continue;
                }

                await this.directoryGenerationService.runScheduledUpdate(reservedSchedule);
                dispatched += 1;
            } catch (error) {
                // Schedule finalization (markRunFailed) is handled by the inner methods:
                // - finalizeGeneration (for generation errors)
                // - handleSyncFailure (for sync errors)
                // - updateItemsGenerator early-exit (for config errors)
                // We only log here to avoid double-counting failures.
                this.logger.error(
                    `Failed to dispatch scheduled update for directory ${schedule.directoryId}`,
                    error as Error,
                );
            }
        }

        return dispatched;
    }
}
