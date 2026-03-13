import { Injectable, Logger } from '@nestjs/common';
import { DirectoryScheduleRepository } from '../database/repositories/directory-schedule.repository';
import { DirectoryScheduleService } from './directory-schedule.service';
import { ItemHealthService } from './item-health.service';
import { User } from '@src/entities/user.entity';

export type ItemSourceValidationSchedulerResult = {
    processed: number;
    skipped: number;
    itemsChecked: number;
    itemsChanged: number;
    errors: { directoryId: string; message: string }[];
};

@Injectable()
export class ItemSourceValidationSchedulerService {
    private readonly logger = new Logger(ItemSourceValidationSchedulerService.name);
    private readonly LIMIT = 50;

    constructor(
        private readonly scheduleRepository: DirectoryScheduleRepository,
        private readonly scheduleService: DirectoryScheduleService,
        private readonly itemHealthService: ItemHealthService,
    ) {}

    async processDueSchedules(): Promise<ItemSourceValidationSchedulerResult> {
        const schedules = await this.scheduleRepository.findDueSourceValidation(this.LIMIT);

        const result: ItemSourceValidationSchedulerResult = {
            processed: 0,
            skipped: 0,
            itemsChecked: 0,
            itemsChanged: 0,
            errors: [],
        };

        for (const schedule of schedules) {
            const directory = schedule.directory;
            const user = schedule.user as User | undefined;

            if (!directory || !user || !directory.scheduledUpdatesEnabled) {
                result.skipped += 1;
                continue;
            }

            const cadence = schedule.sourceValidationCadence || schedule.cadence;
            if (!cadence) {
                result.skipped += 1;
                continue;
            }

            try {
                const checkResult = await this.itemHealthService.runScheduledCheck(directory, user);
                const now = new Date();
                await this.scheduleRepository.updateById(schedule.id, {
                    sourceValidationLastRunAt: now,
                    sourceValidationNextRunAt: this.scheduleService.calculateNextRun(cadence, 0, now),
                });

                result.processed += 1;
                result.itemsChecked += checkResult.checkedCount;
                result.itemsChanged += checkResult.changedCount;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result.errors.push({ directoryId: schedule.directoryId, message });
                this.logger.error(
                    `Source validation failed for directory ${schedule.directoryId}`,
                    error instanceof Error ? error.stack : undefined,
                );
            }
        }

        return result;
    }
}
