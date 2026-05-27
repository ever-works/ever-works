import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkScheduleService } from './work-schedule.service';
import { ItemHealthService } from './item-health.service';
import { User } from '@src/entities/user.entity';
import type { WorkScheduleAllowedCadence } from '@ever-works/contracts/api';
import type { SourceValidationSettingsDto } from '@ever-works/contracts/api';
import { UpdateSourceValidationDto } from '@src/dto/update-source-validation.dto';

export type ItemSourceValidationSchedulerResult = {
    processed: number;
    skipped: number;
    itemsChecked: number;
    itemsChanged: number;
    errors: { workId: string; message: string }[];
};

/**
 * Drives the recurring "is this work's items still reachable?" health
 * check. Picks up to `LIMIT` due works per tick, runs each through
 * {@link ItemHealthService.runScheduledCheck}, and reschedules.
 *
 * Behaviours worth surfacing:
 *
 * - **Batch size cap `LIMIT = 50`.** With more than 50 due works,
 *   the leftover ones wait until the next tick. Sized to fit comfortably
 *   inside the scheduler's per-invocation budget; bump it only after
 *   profiling `runScheduledCheck` for the average work.
 *
 * - **Failures retry on the next tick.** When `runScheduledCheck`
 *   throws, the error is logged but `sourceValidationNextRunAt` is
 *   NOT advanced — the row stays "due" and the scheduler will try it
 *   again next tick. This is correct for transient failures
 *   (network blip, upstream 500) but creates a **starvation hazard**:
 *   if more than `LIMIT` works persistently error, the same first 50
 *   monopolise every tick and the rest never run. If this happens,
 *   either fix the underlying error or add a "bumped on error" path
 *   that pushes the run forward by the cadence on failure too.
 *
 * - **Silent skip for missing prerequisites.** A due work without a
 *   loaded `user` relation or without `sourceValidationCadence` set
 *   is counted as `skipped`, not an error — the row simply waits
 *   until the missing field is filled in. No notification or log.
 */
@Injectable()
export class ItemSourceValidationSchedulerService {
    private readonly logger = new Logger(ItemSourceValidationSchedulerService.name);
    private readonly LIMIT = 50;

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly scheduleService: WorkScheduleService,
        private readonly itemHealthService: ItemHealthService,
    ) {}

    async processDueSchedules(): Promise<ItemSourceValidationSchedulerResult> {
        const works = await this.workRepository.findDueSourceValidation(this.LIMIT);

        const result: ItemSourceValidationSchedulerResult = {
            processed: 0,
            skipped: 0,
            itemsChecked: 0,
            itemsChanged: 0,
            errors: [],
        };

        for (const work of works) {
            const user = work.user as User | undefined;

            if (!user || !work.sourceValidationCadence) {
                result.skipped += 1;
                continue;
            }

            try {
                const checkResult = await this.itemHealthService.runScheduledCheck(work, user);
                const nextRunAt = this.scheduleService.calculateNextRun(
                    work.sourceValidationCadence,
                    0,
                    new Date(),
                );
                await this.workRepository.updateSourceValidationRun(work.id, nextRunAt);

                result.processed += 1;
                result.itemsChecked += checkResult.checkedCount;
                result.itemsChanged += checkResult.changedCount;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result.errors.push({ workId: work.id, message });
                this.logger.error(
                    `Source validation failed for work ${work.id}`,
                    error instanceof Error ? error.stack : undefined,
                );
            }
        }

        return result;
    }

    async getSettings(
        workId: string,
        allowedCadences: WorkScheduleAllowedCadence[],
    ): Promise<SourceValidationSettingsDto> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work ${workId} not found`);
        }

        return {
            enabled: work.sourceValidationEnabled,
            cadence: work.sourceValidationCadence ?? null,
            nextRunAt: work.sourceValidationNextRunAt?.toISOString() ?? null,
            lastRunAt: work.sourceValidationLastRunAt?.toISOString() ?? null,
            allowedCadences,
        };
    }

    async updateSettings(
        workId: string,
        dto: UpdateSourceValidationDto,
        allowedCadences: WorkScheduleAllowedCadence[],
    ): Promise<SourceValidationSettingsDto> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work ${workId} not found`);
        }

        const cadence = dto.cadence ?? work.sourceValidationCadence ?? null;

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

        await this.workRepository.update(work.id, {
            sourceValidationEnabled: dto.enabled,
            sourceValidationCadence: cadence,
            sourceValidationNextRunAt: nextRunAt,
        });

        return {
            enabled: dto.enabled,
            cadence,
            nextRunAt: nextRunAt?.toISOString() ?? null,
            lastRunAt: work.sourceValidationLastRunAt?.toISOString() ?? null,
            allowedCadences,
        };
    }
}
