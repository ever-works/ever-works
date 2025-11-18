import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
    DirectorySchedule,
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
} from '@src/entities/directory-schedule.entity';
import { DirectoryScheduleRepository } from '@src/database/repositories/directory-schedule.repository';
import { DirectoryRepository } from '@src/database/repositories/directory.repository';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { SubscriptionService } from '@src/subscriptions/subscription.service';
import {
    DirectoryScheduleDto,
    DirectoryScheduleAllowedCadence,
    UpdateDirectoryScheduleDto,
} from '@src/dto';
import { User } from '@src/entities/user.entity';
import { config } from '@src/config';
import { GenerateStatusType } from '@src/entities/types';
import { UsageLedgerService } from '@src/subscriptions/usage-ledger.service';
import { UsageLedgerTriggerType } from '@src/entities/usage-ledger-entry.entity';

@Injectable()
export class DirectoryScheduleService {
    private readonly logger = new Logger(DirectoryScheduleService.name);

    constructor(
        private readonly scheduleRepository: DirectoryScheduleRepository,
        private readonly directoryRepository: DirectoryRepository,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly subscriptionService: SubscriptionService,
        private readonly usageLedgerService: UsageLedgerService,
    ) {}

    async getSchedule(
        directoryId: string,
        user: User,
    ): Promise<{ schedule: DirectoryScheduleDto; directoryId: string }> {
        const directory = await this.ownershipService.ensure(directoryId, user.id);

        if (directory.generateStatus?.status !== GenerateStatusType.GENERATED) {
            throw new BadRequestException(
                'Run a successful manual generation before enabling scheduled updates.',
            );
        }

        const [schedule, allowances, plan] = await Promise.all([
            this.scheduleRepository.findByDirectoryId(directory.id),
            this.subscriptionService.getCadenceAllowances(user),
            this.subscriptionService.resolvePlanForUser(user),
        ]);

        return {
            directoryId: directory.id,
            schedule: this.toDto(schedule, allowances, plan.code),
        };
    }

    async getScheduleEntity(directoryId: string, user: User): Promise<DirectorySchedule> {
        const directory = await this.ownershipService.ensure(directoryId, user.id);
        const schedule = await this.scheduleRepository.findByDirectoryId(directory.id);

        if (!schedule) {
            throw new NotFoundException('Schedule not found');
        }

        return schedule as DirectorySchedule;
    }

    async updateSchedule(directoryId: string, dto: UpdateDirectoryScheduleDto, user: User) {
        const directory = await this.ownershipService.ensure(directoryId, user.id);
        const existing = await this.scheduleRepository.findByDirectoryId(directory.id);
        const plan = await this.subscriptionService.resolvePlanForUser(user);
        const allowances = await this.subscriptionService.getCadenceAllowances(user);

        const enable =
            dto.enable !== undefined
                ? dto.enable
                : existing
                  ? existing.status === DirectoryScheduleStatus.ACTIVE
                  : true;

        const cadence =
            dto.cadence || existing?.cadence || this.subscriptionService.getDefaultCadence(plan);

        if (!cadence) {
            throw new BadRequestException('Cadence is required to enable scheduled updates');
        }

        const billingMode =
            dto.billingMode || existing?.billingMode || DirectoryScheduleBillingMode.SUBSCRIPTION;

        if (this.subscriptionService.requiresUsageBilling(cadence, plan, billingMode)) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'Selected cadence is not available on your plan. Switch to pay-per-use to continue.',
            });
        }

        const status = enable ? DirectoryScheduleStatus.ACTIVE : DirectoryScheduleStatus.PAUSED;

        const nextRunAt =
            status === DirectoryScheduleStatus.ACTIVE
                ? this.calculateNextRun(cadence)
                : (existing?.nextRunAt ?? null);

        const subscription = await this.subscriptionService.getActiveSubscription(user.id);

        const schedule = await this.scheduleRepository.upsert(directory.id, {
            userId: user.id,
            cadence,
            billingMode,
            status,
            maxFailureBeforePause:
                dto.maxFailureBeforePause ??
                existing?.maxFailureBeforePause ??
                config.subscriptions.getMaxFailureBeforePause(),
            nextRunAt,
            initiatedBySubscriptionId: subscription?.id ?? null,
        });

        await this.syncDirectory(directory.id, schedule);

        return this.toDto(schedule, allowances, plan.code);
    }

    async cancelSchedule(directoryId: string, user: User) {
        const directory = await this.ownershipService.ensure(directoryId, user.id);
        const schedule = await this.scheduleRepository.findByDirectoryId(directory.id);

        if (!schedule) {
            throw new NotFoundException('Schedule not found');
        }

        const updated = await this.scheduleRepository.upsert(directory.id, {
            status: DirectoryScheduleStatus.CANCELED,
            cadence: null,
            nextRunAt: null,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
        });

        await this.syncDirectory(directory.id, updated);

        const [allowances, plan] = await Promise.all([
            this.subscriptionService.getCadenceAllowances(user),
            this.subscriptionService.resolvePlanForUser(user),
        ]);

        return this.toDto(updated, allowances, plan.code);
    }

    async markRunDispatched(scheduleId: string): Promise<DirectorySchedule | null> {
        const schedule = await this.scheduleRepository.findById(scheduleId);
        if (!schedule) {
            return null;
        }

        await this.scheduleRepository.updateById(schedule.id, {
            lastRunStatus: GenerateStatusType.GENERATING,
            nextRunAt: null,
        });

        await this.syncDirectory(schedule.directoryId, {
            ...schedule,
            nextRunAt: null,
            lastRunStatus: GenerateStatusType.GENERATING,
        });

        return schedule;
    }

    async markRunCompleted(options: {
        scheduleId: string;
        historyId?: string;
        status: GenerateStatusType;
    }) {
        const schedule = await this.scheduleRepository.findById(options.scheduleId);
        if (!schedule) {
            return;
        }

        const nextRunAt =
            schedule.status === DirectoryScheduleStatus.ACTIVE && schedule.cadence
                ? this.calculateNextRun(schedule.cadence)
                : null;

        await this.scheduleRepository.updateById(schedule.id, {
            lastRunStatus: options.status,
            lastRunAt: new Date(),
            nextRunAt,
            failureCount: 0,
        });

        await this.syncDirectory(schedule.directoryId, {
            ...schedule,
            nextRunAt,
            lastRunStatus: options.status,
        });

        await this.usageLedgerService.recordUsage({
            userId: schedule.userId,
            directoryId: schedule.directoryId,
            schedule,
            triggerType: UsageLedgerTriggerType.SCHEDULED,
            billingMode: schedule.billingMode,
            generationHistoryId: options.historyId,
        });
    }

    async markRunFailed(scheduleId: string, reason?: string) {
        const schedule = await this.scheduleRepository.findById(scheduleId);
        if (!schedule) {
            return;
        }

        const failureCount = (schedule.failureCount || 0) + 1;
        const maxFailures =
            schedule.maxFailureBeforePause || config.subscriptions.getMaxFailureBeforePause();
        const reachedLimit = failureCount >= maxFailures;

        await this.scheduleRepository.updateById(schedule.id, {
            failureCount,
            lastRunStatus: GenerateStatusType.ERROR,
            lastRunAt: new Date(),
            status: reachedLimit ? DirectoryScheduleStatus.PAUSED : schedule.status,
            nextRunAt: reachedLimit
                ? null
                : schedule.cadence
                  ? this.calculateNextRun(schedule.cadence, 15)
                  : null,
        });

        await this.syncDirectory(schedule.directoryId, {
            ...schedule,
            failureCount,
            status: reachedLimit ? DirectoryScheduleStatus.PAUSED : schedule.status,
            lastRunStatus: GenerateStatusType.ERROR,
        });

        if (reachedLimit) {
            this.logger.warn(
                `Schedule ${schedule.id} paused after ${failureCount} failures${reason ? `: ${reason}` : ''}`,
            );
        }
    }

    calculateNextRun(
        cadence: DirectoryScheduleCadence,
        delayMinutes = 0,
        fromDate = new Date(),
    ): Date {
        const next = new Date(fromDate);
        if (delayMinutes) {
            next.setMinutes(next.getMinutes() + delayMinutes);
        }

        switch (cadence) {
            case DirectoryScheduleCadence.HOURLY:
                next.setHours(next.getHours() + 1);
                break;
            case DirectoryScheduleCadence.DAILY:
                next.setDate(next.getDate() + 1);
                break;
            case DirectoryScheduleCadence.WEEKLY:
                next.setDate(next.getDate() + 7);
                break;
            case DirectoryScheduleCadence.MONTHLY:
                next.setMonth(next.getMonth() + 1);
                break;
        }

        return next;
    }

    private toDto(
        schedule: DirectorySchedule | null,
        allowances: DirectoryScheduleAllowedCadence[],
        planCode: string,
    ): DirectoryScheduleDto {
        return {
            status: schedule?.status ?? DirectoryScheduleStatus.DISABLED,
            cadence: schedule?.cadence ?? null,
            billingMode: schedule?.billingMode ?? DirectoryScheduleBillingMode.SUBSCRIPTION,
            nextRunAt: schedule?.nextRunAt ? schedule.nextRunAt.toISOString() : null,
            lastRunAt: schedule?.lastRunAt ? schedule.lastRunAt.toISOString() : null,
            lastRunStatus: schedule?.lastRunStatus ?? null,
            failureCount: schedule?.failureCount ?? 0,
            maxFailureBeforePause:
                schedule?.maxFailureBeforePause ?? config.subscriptions.getMaxFailureBeforePause(),
            allowedCadences: allowances,
            planCode,
        };
    }

    private async syncDirectory(directoryId: string, schedule: Partial<DirectorySchedule> | null) {
        await this.directoryRepository.update(directoryId, {
            scheduledUpdatesEnabled:
                Boolean(schedule) && schedule.status === DirectoryScheduleStatus.ACTIVE,
            scheduledCadence: schedule?.cadence ?? null,
            scheduledNextRunAt: schedule?.nextRunAt ?? null,
            scheduledStatus: schedule?.status ?? DirectoryScheduleStatus.DISABLED,
        });
    }
}
