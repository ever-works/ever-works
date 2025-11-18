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
        const schedules = await this.scheduleRepository.findDue(limit);

        for (const schedule of schedules) {
            try {
                await this.directoryGenerationService.runScheduledUpdate(schedule);
            } catch (error) {
                this.logger.error(
                    `Failed to dispatch scheduled update for directory ${schedule.directoryId}`,
                    error as Error,
                );
                await this.directoryScheduleService.markRunFailed(
                    schedule.id,
                    (error as Error)?.message,
                );
            }
        }

        return schedules.length;
    }
}
