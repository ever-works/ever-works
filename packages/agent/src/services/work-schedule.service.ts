import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkSchedule } from '@src/entities/work-schedule.entity';
import { WorkScheduleRepository } from '@src/database/repositories/work-schedule.repository';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { WorkOwnershipService } from './work-ownership.service';
import { SubscriptionService } from '@src/subscriptions/subscription.service';
import {
    WorkScheduleDto,
    WorkScheduleAllowedCadence,
    UpdateWorkScheduleDto,
} from '@src/dto';
import { User } from '@src/entities/user.entity';
import { config } from '@src/config';
import {
    WorkScheduleBillingMode,
    WorkScheduleCadence,
    WorkScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { SELECTABLE_PROVIDER_CATEGORIES } from '@ever-works/plugin';
import { UsageLedgerService } from '@src/subscriptions/usage-ledger.service';
import { UsageLedgerTriggerType } from '@src/entities/usage-ledger-entry.entity';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { Work } from '@src/entities/work.entity';
import { NotificationService } from '@src/notifications/notification.service';
import type { ScheduleRunOutcome } from './types/trigger-context.types';
import { WorksConfigSyncRequestedEvent, type WorksConfigSyncReason } from '@src/events';
import { supportsWorkSourceSync } from '@src/import/source-sync-support';

type WorkScheduleReadiness = {
    featureEnabled: boolean;
    canEnable: boolean;
    blockingCode?:
        | 'SCHEDULED_UPDATES_DISABLED'
        | 'INITIAL_WORK_SETUP_REQUIRED'
        | 'CONFIG_UNAVAILABLE';
    blockingReason?: string;
};

@Injectable()
export class WorkScheduleService {
    private readonly logger = new Logger(WorkScheduleService.name);
    private readonly RETRY_DELAY_MINUTES = 15;
    private readonly IDEMPOTENT_WINDOW_MINUTES = 5;

    constructor(
        private readonly scheduleRepository: WorkScheduleRepository,
        private readonly workRepository: WorkRepository,
        private readonly ownershipService: WorkOwnershipService,
        private readonly subscriptionService: SubscriptionService,
        private readonly usageLedgerService: UsageLedgerService,
        private readonly dataGeneratorService: DataGeneratorService,
        private readonly pluginRegistry: PluginRegistryService,
        @Optional()
        private readonly notificationService?: NotificationService,
        @Optional()
        private readonly eventEmitter?: EventEmitter2,
    ) {}

    async getSchedule(
        workId: string,
        user: User,
    ): Promise<{ schedule: WorkScheduleDto; workId: string }> {
        // Any access level can view schedule
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);
        const subscriptionsEnabled = this.subscriptionService.isEnabled();

        const [schedule, allowances, plan, readiness] = await Promise.all([
            this.scheduleRepository.findByWorkId(work.id),
            this.subscriptionService.getCadenceAllowances(user),
            this.subscriptionService.resolvePlanForUser(user),
            this.getScheduleReadiness(work, user),
        ]);

        return {
            workId: work.id,
            schedule: this.toDto(schedule, allowances, plan.code, subscriptionsEnabled, readiness),
        };
    }

    async getScheduleEntity(workId: string, user: User): Promise<WorkSchedule> {
        this.ensureSchedulingEnabled();
        // Any access level can view schedule
        const { work } = await this.ownershipService.ensureCanView(workId, user.id);
        const schedule = await this.scheduleRepository.findByWorkId(work.id);

        if (!schedule) {
            throw new NotFoundException('Schedule not found');
        }

        return schedule as WorkSchedule;
    }

    async updateSchedule(workId: string, dto: UpdateWorkScheduleDto, user: User) {
        this.ensureSchedulingEnabled();
        // Require editor role to update schedule
        const { work } = await this.ownershipService.ensureCanEdit(workId, user.id);
        const subscriptionsEnabled = this.subscriptionService.isEnabled();
        const existing = await this.scheduleRepository.findByWorkId(work.id);
        const plan = await this.subscriptionService.resolvePlanForUser(user);
        const allowances = await this.subscriptionService.getCadenceAllowances(user);

        const enable = this.resolveRequestedEnabledState(dto, existing);

        const cadence =
            dto.cadence || existing?.cadence || this.subscriptionService.getDefaultCadence(plan);

        if (!cadence) {
            throw new BadRequestException('Cadence is required to enable scheduled updates');
        }

        const billingMode =
            dto.billingMode || existing?.billingMode || WorkScheduleBillingMode.SUBSCRIPTION;

        if (this.subscriptionService.requiresUsageBilling(cadence, plan, billingMode)) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'Selected cadence is not available on your plan. Switch to pay-per-use to continue.',
            });
        }

        const maxFailureBeforePause =
            dto.maxFailureBeforePause ??
            existing?.maxFailureBeforePause ??
            config.subscriptions.getMaxFailureBeforePause();

        if (maxFailureBeforePause < 1 || maxFailureBeforePause > 10) {
            throw new BadRequestException('maxFailureBeforePause must be between 1 and 10');
        }

        const alwaysCreatePullRequest =
            dto.alwaysCreatePullRequest ?? existing?.alwaysCreatePullRequest ?? false;

        const importedProviderOverrides =
            work.sourceRepository?.worksConfig?.providers ?? null;

        const providerOverrides =
            dto.providerOverrides !== undefined
                ? dto.providerOverrides
                : (existing?.providerOverrides ?? importedProviderOverrides);

        if (providerOverrides) {
            this.validateProviderOverrides(providerOverrides);
        }

        const creatingOrActivating =
            enable && (!existing || existing.status !== WorkScheduleStatus.ACTIVE);

        if (enable) {
            await this.ensureWorkConfigReady(work, user);
        }

        if (subscriptionsEnabled && creatingOrActivating) {
            const activeScheduleCount = await this.scheduleRepository.countActiveByUser(user.id);
            if (activeScheduleCount >= plan.maxWorks) {
                throw new BadRequestException({
                    status: 'error',
                    code: 'PLAN_LIMIT_EXCEEDED',
                    message: `Your ${plan.displayName} plan allows up to ${plan.maxWorks} scheduled works.`,
                });
            }
        }

        const status = enable ? WorkScheduleStatus.ACTIVE : WorkScheduleStatus.PAUSED;

        const shouldRecalculateNextRun =
            status === WorkScheduleStatus.ACTIVE &&
            (!existing ||
                existing.status !== WorkScheduleStatus.ACTIVE ||
                existing.cadence !== cadence);

        const nextRunAt = this.resolveNextRunAfterScheduleUpdate({
            status,
            cadence,
            existing,
            shouldRecalculateNextRun,
        });

        const schedule = await this.scheduleRepository.upsert(work.id, {
            userId: user.id,
            cadence,
            billingMode,
            status,
            maxFailureBeforePause,
            alwaysCreatePullRequest,
            providerOverrides,
            nextRunAt,
        });

        await this.syncWork(work.id, schedule);
        this.requestWorksConfigSync(work.id, user.id, 'schedule_updated');

        const readiness = await this.getScheduleReadiness(work, user);
        return this.toDto(schedule, allowances, plan.code, subscriptionsEnabled, readiness);
    }

    async cancelSchedule(workId: string, user: User) {
        this.ensureSchedulingEnabled();
        // Require editor role to cancel schedule
        const { work } = await this.ownershipService.ensureCanEdit(workId, user.id);
        const subscriptionsEnabled = this.subscriptionService.isEnabled();
        const schedule = await this.scheduleRepository.findByWorkId(work.id);

        if (!schedule) {
            throw new NotFoundException('Schedule not found');
        }

        const updated = await this.scheduleRepository.upsert(work.id, {
            status: WorkScheduleStatus.CANCELED,
            cadence: null,
            nextRunAt: null,
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            alwaysCreatePullRequest: false,
            providerOverrides: null,
        });

        await this.syncWork(work.id, updated);
        this.requestWorksConfigSync(work.id, user.id, 'schedule_cancelled');

        const [allowances, plan] = await Promise.all([
            this.subscriptionService.getCadenceAllowances(user),
            this.subscriptionService.resolvePlanForUser(user),
        ]);

        const readiness = await this.getScheduleReadiness(work, user);
        return this.toDto(updated, allowances, plan.code, subscriptionsEnabled, readiness);
    }

    async pauseSchedule(scheduleId: string) {
        this.ensureSchedulingEnabled();
        const schedule = await this.scheduleRepository.findById(scheduleId);
        if (!schedule) {
            return;
        }

        await this.scheduleRepository.updateById(scheduleId, {
            status: WorkScheduleStatus.PAUSED,
            nextRunAt: null,
        });

        await this.syncWork(schedule.workId, {
            ...schedule,
            status: WorkScheduleStatus.PAUSED,
            nextRunAt: null,
        });
    }

    async markRunDispatched(scheduleId: string): Promise<WorkSchedule | null> {
        const updated = await this.scheduleRepository.tryMarkDispatched(scheduleId);
        if (!updated) {
            return null;
        }

        const schedule = await this.scheduleRepository.findById(scheduleId);
        if (!schedule) {
            return null;
        }

        await this.syncWork(schedule.workId, {
            ...schedule,
            nextRunAt: null,
            lastRunStatus: GenerateStatusType.GENERATING,
        });

        return schedule;
    }

    /**
     * Single entry point for finalizing a schedule run.
     * Idempotent — safe to call multiple times for the same run.
     */
    async finalizeScheduleRun(scheduleId: string, outcome: ScheduleRunOutcome): Promise<void> {
        switch (outcome.status) {
            case 'completed':
                await this.markRunCompleted({
                    scheduleId,
                    historyId: outcome.historyId,
                    status: GenerateStatusType.GENERATED,
                });
                break;
            case 'failed':
                await this.markRunFailed(scheduleId, outcome.reason);
                break;
            case 'skipped':
                await this.markRunSkipped(scheduleId, outcome.reason);
                break;
        }
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

        // Use the preserved scheduledFor as anchor for drift prevention.
        // scheduledFor is set by tryMarkDispatched before clearing nextRunAt.
        const anchorDate = this.resolveAnchorDate(schedule);

        const preserveExistingNextRun = this.isManualRunAheadOfSchedule(schedule);
        const nextRunAt = this.resolveNextRunAfterCompletedRun(
            schedule,
            anchorDate,
            preserveExistingNextRun,
        );

        await this.scheduleRepository.updateById(schedule.id, {
            lastRunStatus: options.status,
            lastRunAt: new Date(),
            nextRunAt,
            failureCount: 0,
            scheduledFor: null,
        });

        await this.syncWork(schedule.workId, {
            ...schedule,
            nextRunAt,
            lastRunStatus: options.status,
        });

        await this.usageLedgerService.recordUsage({
            userId: schedule.userId,
            workId: schedule.workId,
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

        // Idempotent guard: if already marked as ERROR recently, skip the increment.
        // This prevents double-counting when multiple error handlers fire for the same run.
        if (this.isAlreadyMarkedFailed(schedule)) {
            return;
        }

        const preserveExistingNextRun = this.isManualRunAheadOfSchedule(schedule);
        const failureCount = preserveExistingNextRun
            ? schedule.failureCount || 0
            : (schedule.failureCount || 0) + 1;
        const maxFailures =
            schedule.maxFailureBeforePause || config.subscriptions.getMaxFailureBeforePause();
        const reachedLimit = !preserveExistingNextRun && failureCount >= maxFailures;

        const anchorDate = this.resolveAnchorDate(schedule);
        const nextRunAt = this.resolveNextRunAfterFailedRun({
            schedule,
            anchorDate,
            preserveExistingNextRun,
            reachedLimit,
        });
        const lastRunStatus = preserveExistingNextRun ? null : GenerateStatusType.ERROR;

        await this.scheduleRepository.updateById(schedule.id, {
            failureCount,
            lastRunStatus,
            lastRunAt: new Date(),
            status: reachedLimit ? WorkScheduleStatus.PAUSED : schedule.status,
            scheduledFor: null,
            nextRunAt,
        });

        await this.syncWork(schedule.workId, {
            ...schedule,
            failureCount,
            status: reachedLimit ? WorkScheduleStatus.PAUSED : schedule.status,
            lastRunStatus,
            nextRunAt,
        });

        if (reachedLimit) {
            this.logger.warn(
                `Schedule ${schedule.id} paused after ${failureCount} failures${reason ? `: ${reason}` : ''}`,
            );

            const work = await this.workRepository.findById(schedule.workId);
            if (work && this.notificationService) {
                await this.notificationService.notifySchedulePaused(
                    schedule.userId,
                    schedule.workId,
                    work.name,
                    reason || `Paused after ${failureCount} consecutive failures`,
                );
            }
        }
    }

    /**
     * Mark a run as skipped (e.g. work was already generating).
     * Does NOT increment failureCount — this isn't a real failure.
     */
    private async markRunSkipped(scheduleId: string, reason: string) {
        const schedule = await this.scheduleRepository.findById(scheduleId);
        if (!schedule) {
            return;
        }

        this.logger.warn(`Schedule ${schedule.id} skipped: ${reason}`);

        // Reschedule using the original cadence — don't penalize the schedule.
        // If the anchor is in the past, use now() to avoid a rapid retry loop.
        const preserveExistingNextRun = this.isManualRunAheadOfSchedule(schedule);
        const anchorDate = this.resolveAnchorDate(schedule);
        const baseDate = anchorDate.getTime() > Date.now() ? anchorDate : new Date();
        const nextRunAt = this.resolveNextRunAfterSkippedRun(
            schedule,
            baseDate,
            preserveExistingNextRun,
        );

        await this.scheduleRepository.updateById(schedule.id, {
            lastRunStatus: null,
            lastRunAt: new Date(),
            nextRunAt,
            scheduledFor: null,
        });

        await this.syncWork(schedule.workId, {
            ...schedule,
            nextRunAt,
            lastRunStatus: null,
        });
    }

    async recoverStuckSchedules() {
        const timeoutMinutes = config.subscriptions.getScheduleStuckTimeoutMinutes();
        const threshold = new Date(Date.now() - timeoutMinutes * 60 * 1000);
        const stuckSchedules = await this.scheduleRepository.findStuckGenerating(threshold);

        if (stuckSchedules.length === 0) {
            return 0;
        }

        this.logger.warn(`Found ${stuckSchedules.length} stuck schedules. Recovering...`);

        for (const schedule of stuckSchedules) {
            await this.markRunFailed(
                schedule.id,
                `Stuck in GENERATING state for > ${timeoutMinutes} minutes`,
            );
        }

        return stuckSchedules.length;
    }

    /**
     * Resolve the anchor date for next-run calculation.
     * Uses scheduledFor (the original intended execution time) to prevent drift.
     */
    private resolveAnchorDate(schedule: WorkSchedule): Date {
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

        // Prefer scheduledFor — the original nextRunAt preserved at dispatch time
        if (schedule.scheduledFor && schedule.scheduledFor.getTime() > oneDayAgo) {
            return schedule.scheduledFor;
        }

        // Fallback to nextRunAt (for non-dispatched paths like manual pause/resume)
        if (schedule.nextRunAt && schedule.nextRunAt.getTime() > oneDayAgo) {
            return schedule.nextRunAt;
        }

        return new Date();
    }

    private resolveRequestedEnabledState(
        dto: UpdateWorkScheduleDto,
        existing: WorkSchedule | null,
    ): boolean {
        if (dto.enable !== undefined) {
            return dto.enable;
        }

        if (!existing) {
            return true;
        }

        return existing.status === WorkScheduleStatus.ACTIVE;
    }

    private resolveNextRunAfterScheduleUpdate(options: {
        status: WorkScheduleStatus;
        cadence: WorkScheduleCadence;
        existing: WorkSchedule | null;
        shouldRecalculateNextRun: boolean;
    }): Date | null {
        if (options.status !== WorkScheduleStatus.ACTIVE) {
            return options.existing?.nextRunAt ?? null;
        }

        if (options.shouldRecalculateNextRun) {
            return this.calculateNextRun(options.cadence);
        }

        return options.existing?.nextRunAt ?? null;
    }

    private resolveNextRunAfterCompletedRun(
        schedule: WorkSchedule,
        anchorDate: Date,
        preserveExistingNextRun: boolean,
    ): Date | null {
        if (preserveExistingNextRun) {
            return schedule.nextRunAt ?? null;
        }

        if (schedule.status !== WorkScheduleStatus.ACTIVE || !schedule.cadence) {
            return null;
        }

        return this.calculateNextRun(schedule.cadence, 0, anchorDate);
    }

    private resolveNextRunAfterFailedRun(options: {
        schedule: WorkSchedule;
        anchorDate: Date;
        preserveExistingNextRun: boolean;
        reachedLimit: boolean;
    }): Date | null {
        if (options.preserveExistingNextRun) {
            return options.schedule.nextRunAt ?? null;
        }

        if (options.reachedLimit || !options.schedule.cadence) {
            return null;
        }

        return new Date(options.anchorDate.getTime() + this.RETRY_DELAY_MINUTES * 60 * 1000);
    }

    private resolveNextRunAfterSkippedRun(
        schedule: WorkSchedule,
        baseDate: Date,
        preserveExistingNextRun: boolean,
    ): Date | null {
        if (preserveExistingNextRun) {
            return schedule.nextRunAt ?? null;
        }

        if (schedule.status !== WorkScheduleStatus.ACTIVE || !schedule.cadence) {
            return null;
        }

        return new Date(baseDate.getTime() + this.RETRY_DELAY_MINUTES * 60 * 1000);
    }

    /**
     * Manual "run now" requests can execute before the scheduled slot is due.
     * In that case, preserve the existing nextRunAt so we don't skip the upcoming run.
     */
    private isManualRunAheadOfSchedule(schedule: WorkSchedule): boolean {
        return Boolean(
            !schedule.scheduledFor &&
            schedule.nextRunAt &&
            schedule.nextRunAt.getTime() > Date.now(),
        );
    }

    private isAlreadyMarkedFailed(schedule: WorkSchedule): boolean {
        if (schedule.lastRunStatus !== GenerateStatusType.ERROR) {
            return false;
        }
        if (!schedule.lastRunAt) {
            return false;
        }
        const windowMs = this.IDEMPOTENT_WINDOW_MINUTES * 60 * 1000;
        return schedule.lastRunAt.getTime() > Date.now() - windowMs;
    }

    async validateRunEntitlement(schedule: WorkSchedule, user: User): Promise<boolean> {
        if (!this.subscriptionService.isEnabled()) {
            return true;
        }

        // If pay-per-use, no plan limits to check (assuming they can pay)
        if (schedule.billingMode === WorkScheduleBillingMode.USAGE) {
            return true;
        }

        const plan = await this.subscriptionService.resolvePlanForUser(user);
        const activeCount = await this.scheduleRepository.countActiveByUser(user.id);

        // If they are over the limit, we must pause this schedule
        // Note: This is a "lazy" enforcement. It happens when the schedule tries to run.
        // Since we are currently "in" a run (conceptually), checking activeCount includes this one.
        // If activeCount > plan.maxWorks, they are over limit.
        if (activeCount > plan.maxWorks) {
            this.logger.warn(
                `Pausing schedule ${schedule.id} for user ${user.id}. Plan limit exceeded (${activeCount}/${plan.maxWorks}).`,
            );

            await this.scheduleRepository.updateById(schedule.id, {
                status: WorkScheduleStatus.PAUSED,
                nextRunAt: null,
            });

            await this.syncWork(schedule.workId, {
                ...schedule,
                status: WorkScheduleStatus.PAUSED,
                nextRunAt: null,
            });

            // Publish notification for schedule paused due to plan limit
            const work = await this.workRepository.findById(schedule.workId);
            if (work && this.notificationService) {
                await this.notificationService.notifySchedulePaused(
                    schedule.userId,
                    schedule.workId,
                    work.name,
                    `Plan limit exceeded. Your ${plan.displayName} plan allows ${plan.maxWorks} active schedules.`,
                );
            }

            return false;
        }

        // Also check if the specific cadence is still allowed on their plan
        const allowances = await this.subscriptionService.getCadenceAllowances(user);
        const cadenceAllowed = allowances.find((a) => a.cadence === schedule.cadence)?.allowed;

        if (!cadenceAllowed) {
            this.logger.warn(
                `Pausing schedule ${schedule.id} for user ${user.id}. Cadence ${schedule.cadence} no longer allowed on plan.`,
            );
            await this.scheduleRepository.updateById(schedule.id, {
                status: WorkScheduleStatus.PAUSED,
                nextRunAt: null,
            });
            await this.syncWork(schedule.workId, {
                ...schedule,
                status: WorkScheduleStatus.PAUSED,
                nextRunAt: null,
            });
            return false;
        }

        return true;
    }

    calculateNextRun(
        cadence: WorkScheduleCadence,
        delayMinutes = 0,
        fromDate = new Date(),
    ): Date {
        const next = new Date(fromDate);
        if (delayMinutes) {
            next.setMinutes(next.getMinutes() + delayMinutes);
        }

        switch (cadence) {
            case WorkScheduleCadence.HOURLY:
                // Snap to the start of the current hour, then advance by one hour.
                // This prevents drift when generation time varies and keeps runs
                // aligned to clean hour boundaries (e.g. 14:00, 15:00, 16:00).
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 1);
                break;
            case WorkScheduleCadence.EVERY_3_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 3);
                break;
            case WorkScheduleCadence.EVERY_8_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 8);
                break;
            case WorkScheduleCadence.EVERY_12_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 12);
                break;
            case WorkScheduleCadence.DAILY:
                next.setDate(next.getDate() + 1);
                break;
            case WorkScheduleCadence.WEEKLY:
                next.setDate(next.getDate() + 7);
                break;
            case WorkScheduleCadence.MONTHLY:
                next.setMonth(next.getMonth() + 1);
                break;
        }

        return next;
    }

    private toDto(
        schedule: WorkSchedule | null,
        allowances: WorkScheduleAllowedCadence[],
        planCode: string,
        subscriptionsEnabled: boolean,
        readiness: WorkScheduleReadiness,
    ): WorkScheduleDto {
        return {
            status: schedule?.status ?? WorkScheduleStatus.DISABLED,
            featureEnabled: readiness.featureEnabled,
            canEnable: readiness.canEnable,
            blockingCode: readiness.blockingCode,
            blockingReason: readiness.blockingReason,
            cadence: schedule?.cadence ?? null,
            billingMode: schedule?.billingMode ?? WorkScheduleBillingMode.SUBSCRIPTION,
            nextRunAt: schedule?.nextRunAt ? schedule.nextRunAt.toISOString() : null,
            lastRunAt: schedule?.lastRunAt ? schedule.lastRunAt.toISOString() : null,
            lastRunStatus: schedule?.lastRunStatus ?? null,
            failureCount: schedule?.failureCount ?? 0,
            maxFailureBeforePause:
                schedule?.maxFailureBeforePause ?? config.subscriptions.getMaxFailureBeforePause(),
            alwaysCreatePullRequest: schedule?.alwaysCreatePullRequest ?? false,
            allowedCadences: allowances,
            planCode: subscriptionsEnabled ? planCode : undefined,
            subscriptionsEnabled,
            providerOverrides: schedule?.providerOverrides ?? null,
        };
    }

    private async syncWork(workId: string, schedule: Partial<WorkSchedule> | null) {
        await this.workRepository.update(workId, {
            scheduledUpdatesEnabled:
                Boolean(schedule) && schedule.status === WorkScheduleStatus.ACTIVE,
            scheduledCadence: schedule?.cadence ?? null,
            scheduledNextRunAt: schedule?.nextRunAt ?? null,
            scheduledStatus: schedule?.status ?? WorkScheduleStatus.DISABLED,
        });
    }

    private requestWorksConfigSync(
        workId: string,
        userId: string,
        reason: WorksConfigSyncReason,
    ): void {
        this.eventEmitter?.emit(
            WorksConfigSyncRequestedEvent.EVENT_NAME,
            new WorksConfigSyncRequestedEvent(workId, userId, reason),
        );
    }

    private async getScheduleReadiness(
        work: Work,
        user: User,
    ): Promise<WorkScheduleReadiness> {
        if (!config.subscriptions.scheduledUpdatesEnabled()) {
            return {
                featureEnabled: false,
                canEnable: false,
                blockingCode: 'SCHEDULED_UPDATES_DISABLED',
                blockingReason: 'Scheduled updates are currently disabled.',
            };
        }

        if (work.sourceRepository) {
            if (supportsWorkSourceSync(work.sourceRepository.type)) {
                // Import-backed sync works do not rely on saved generation request data.
                return {
                    featureEnabled: true,
                    canEnable: true,
                };
            }
        }

        const blockingReason =
            'Complete an initial work setup before enabling scheduled updates.';
        const unavailableReason =
            'Schedule readiness could not be checked right now. Try again in a moment.';

        try {
            const generatorConfig = await this.dataGeneratorService.getConfig(work, user);

            if (!generatorConfig?.metadata?.last_request_data) {
                return {
                    featureEnabled: true,
                    canEnable: false,
                    blockingCode: 'INITIAL_WORK_SETUP_REQUIRED',
                    blockingReason,
                };
            }

            return {
                featureEnabled: true,
                canEnable: true,
            };
        } catch (error) {
            this.logger.warn(
                `Failed to inspect schedule readiness for work ${work.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return {
                featureEnabled: true,
                canEnable: false,
                blockingCode: 'CONFIG_UNAVAILABLE',
                blockingReason: unavailableReason,
            };
        }
    }

    private async ensureWorkConfigReady(work: Work, user: User) {
        const readiness = await this.getScheduleReadiness(work, user);

        if (readiness.canEnable) {
            return;
        }

        throw new BadRequestException({
            status: 'error',
            code: readiness.blockingCode ?? 'SCHEDULE_NOT_READY',
            message:
                readiness.blockingReason ??
                'Complete an initial work setup before enabling scheduled updates.',
        });
    }

    private validateProviderOverrides(overrides: ProvidersDto): void {
        const dtoFields = (
            Object.values(SELECTABLE_PROVIDER_CATEGORIES) as Array<{
                uiKey: keyof ProvidersDto;
            }>
        ).map((category) => category.uiKey);
        for (const field of dtoFields) {
            const pluginId = overrides[field];
            if (pluginId) {
                const registered = this.pluginRegistry.get(pluginId);
                if (!registered) {
                    throw new BadRequestException(
                        `Provider plugin "${pluginId}" for ${field} is not installed`,
                    );
                }
                if (registered.state !== 'loaded') {
                    throw new BadRequestException(
                        `Provider plugin "${pluginId}" for ${field} is not enabled`,
                    );
                }
            }
        }
    }

    private ensureSchedulingEnabled() {
        if (!config.subscriptions.scheduledUpdatesEnabled()) {
            throw new BadRequestException({
                status: 'error',
                message: 'Scheduled updates are currently disabled.',
            });
        }
    }
}
