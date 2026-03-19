import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DirectoryRepository } from '../database/repositories/directory.repository';
import { DirectoryScheduleService } from './directory-schedule.service';
import { ItemHealthService } from './item-health.service';
import { User } from '@src/entities/user.entity';
import type { DirectoryScheduleAllowedCadence } from '@ever-works/contracts/api';
import type { SourceValidationSettingsDto } from '@ever-works/contracts/api';
import { UpdateSourceValidationDto } from '@src/dto/update-source-validation.dto';

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
        private readonly directoryRepository: DirectoryRepository,
        private readonly scheduleService: DirectoryScheduleService,
        private readonly itemHealthService: ItemHealthService,
    ) {}

    async processDueSchedules(): Promise<ItemSourceValidationSchedulerResult> {
        const directories = await this.directoryRepository.findDueSourceValidation(this.LIMIT);

        const result: ItemSourceValidationSchedulerResult = {
            processed: 0,
            skipped: 0,
            itemsChecked: 0,
            itemsChanged: 0,
            errors: [],
        };

        for (const directory of directories) {
            const user = directory.user as User | undefined;

            if (!user || !directory.sourceValidationCadence) {
                result.skipped += 1;
                continue;
            }

            try {
                const checkResult = await this.itemHealthService.runScheduledCheck(directory, user);
                const nextRunAt = this.scheduleService.calculateNextRun(
                    directory.sourceValidationCadence,
                    0,
                    new Date(),
                );
                await this.directoryRepository.updateSourceValidationRun(directory.id, nextRunAt);

                result.processed += 1;
                result.itemsChecked += checkResult.checkedCount;
                result.itemsChanged += checkResult.changedCount;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result.errors.push({ directoryId: directory.id, message });
                this.logger.error(
                    `Source validation failed for directory ${directory.id}`,
                    error instanceof Error ? error.stack : undefined,
                );
            }
        }

        return result;
    }

    async getSettings(
        directoryId: string,
        allowedCadences: DirectoryScheduleAllowedCadence[],
    ): Promise<SourceValidationSettingsDto> {
        const directory = await this.directoryRepository.findById(directoryId);
        if (!directory) {
            throw new NotFoundException(`Directory ${directoryId} not found`);
        }

        return {
            enabled: directory.sourceValidationEnabled,
            cadence: directory.sourceValidationCadence ?? null,
            nextRunAt: directory.sourceValidationNextRunAt?.toISOString() ?? null,
            lastRunAt: directory.sourceValidationLastRunAt?.toISOString() ?? null,
            allowedCadences,
        };
    }

    async updateSettings(
        directoryId: string,
        dto: UpdateSourceValidationDto,
        allowedCadences: DirectoryScheduleAllowedCadence[],
    ): Promise<SourceValidationSettingsDto> {
        const directory = await this.directoryRepository.findById(directoryId);
        if (!directory) {
            throw new NotFoundException(`Directory ${directoryId} not found`);
        }

        const cadence = dto.cadence ?? directory.sourceValidationCadence ?? null;

        if (
            cadence &&
            allowedCadences.length > 0 &&
            !allowedCadences.some((a) => a.cadence === cadence)
        ) {
            throw new BadRequestException(
                `Cadence '${cadence}' is not allowed by your subscription plan`,
            );
        }

        const nextRunAt =
            dto.enabled && cadence ? this.scheduleService.calculateNextRun(cadence) : null;

        await this.directoryRepository.update(directory.id, {
            sourceValidationEnabled: dto.enabled,
            sourceValidationCadence: cadence,
            sourceValidationNextRunAt: nextRunAt,
        });

        return {
            enabled: dto.enabled,
            cadence,
            nextRunAt: nextRunAt?.toISOString() ?? null,
            lastRunAt: directory.sourceValidationLastRunAt?.toISOString() ?? null,
            allowedCadences,
        };
    }
}
