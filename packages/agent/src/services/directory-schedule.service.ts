import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { DirectorySchedule } from '@src/entities/directory-schedule.entity';
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
import {
    DirectoryScheduleBillingMode,
    DirectoryScheduleCadence,
    DirectoryScheduleStatus,
    GenerateStatusType,
} from '@src/entities/types';
import type { ProvidersDto } from '@ever-works/contracts/api';
import { SELECTABLE_PROVIDER_CATEGORIES } from '@ever-works/plugin';
import { UsageLedgerService } from '@src/subscriptions/usage-ledger.service';
import { UsageLedgerTriggerType } from '@src/entities/usage-ledger-entry.entity';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { Directory } from '@src/entities/directory.entity';
import { NotificationService } from '@src/notifications/notification.service';
import type { ScheduleRunOutcome } from './types/trigger-context.types';

@Injectable()
export class DirectoryScheduleService {
    private readonly logger = new Logger(DirectoryScheduleService.name);
    private readonly RETRY_DELAY_MINUTES = 15;
    private readonly IDEMPOTENT_WINDOW_MINUTES = 5;

    constructor(
        private readonly scheduleRepository: DirectoryScheduleRepository,
        private readonly directoryRepository: DirectoryRepository,
        private readonly ownershipService: DirectoryOwnershipService,
        private readonly subscriptionService: SubscriptionService,
        private readonly usageLedgerService: UsageLedgerService,
        private readonly dataGeneratorService: DataGeneratorService,
        private readonly pluginRegistry: PluginRegistryService,
        @Optional()
        private readonly notificationService?: NotificationService,
    ) {}

    async getSchedule(
        directoryId: string,
        user: User,
    ): Promise<{ schedule: DirectoryScheduleDto; directoryId: string }> {
        this.ensureSchedulingEnabled();

        // Any access level can view schedule
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);
        const subscriptionsEnabled = this.subscriptionService.isEnabled();

        await this.ensureDirectoryConfigReady(directory, user);

        const [schedule, allowances, plan] = await Promise.all([
            this.scheduleRepository.findByDirectoryId(directory.id),
            this.subscriptionService.getCadenceAllowances(user),
            this.subscriptionService.resolvePlanForUser(user),
        ]);

        return {
            directoryId: directory.id,
            schedule: this.toDto(schedule, allowances, plan.code, subscriptionsEnabled),
        };
    }

    async getScheduleEntity(directoryId: string, user: User): Promise<DirectorySchedule> {
        this.ensureSchedulingEnabled();
        // Any access level can view schedule
        const { directory } = await this.ownershipService.ensureCanView(directoryId, user.id);
        const schedule = await this.scheduleRepository.findByDirectoryId(directory.id);

        if (!schedule) {
            throw new NotFoundException('Schedule not found');
        }

        return schedule as DirectorySchedule;
    }

    async updateSchedule(directoryId: string, dto: UpdateDirectoryScheduleDto, user: User) {
        this.ensureSchedulingEnabled();
        // Require editor role to update schedule
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);
        const subscriptionsEnabled = this.subscriptionService.isEnabled();
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

        const maxFailureBeforePause =
            dto.maxFailureBeforePause ??
            existing?.maxFailureBeforePause ??
            config.subscriptions.getMaxFailureBeforePause();

        if (maxFailureBeforePause < 1 || maxFailureBeforePause > 10) {
            throw new BadRequestException('maxFailureBeforePause must be between 1 and 10');
        }

        const alwaysCreatePullRequest =
            dto.alwaysCreatePullRequest ?? existing?.alwaysCreatePullRequest ?? false;

        const providerOverrides =
            dto.providerOverrides !== undefined
                ? dto.providerOverrides
                : (existing?.providerOverrides ?? null);

        if (providerOverrides) {
            this.validateProviderOverrides(providerOverrides);
        }

        const creatingOrActivating =
            enable && (!existing || existing.status !== DirectoryScheduleStatus.ACTIVE);

        if (enable) {
            await this.ensureDirectoryConfigReady(directory, user);
        }

        if (subscriptionsEnabled && creatingOrActivating) {
            const activeScheduleCount = await this.scheduleRepository.countActiveByUser(user.id);
            if (activeScheduleCount >= plan.maxDirectories) {
                throw new BadRequestException({
                    status: 'error',
                    code: 'PLAN_LIMIT_EXCEEDED',
                    message: `Your ${plan.displayName} plan allows up to ${plan.maxDirectories} scheduled directories.`,
                });
            }
        }

        const status = enable ? DirectoryScheduleStatus.ACTIVE : DirectoryScheduleStatus.PAUSED;

        const shouldRecalculateNextRun =
            status === DirectoryScheduleStatus.ACTIVE &&
            (!existing ||
                existing.status !== DirectoryScheduleStatus.ACTIVE ||
                existing.cadence !== cadence);

        const nextRunAt =
            status === DirectoryScheduleStatus.ACTIVE
                ? shouldRecalculateNextRun
                    ? this.calculateNextRun(cadence)
                    : (existing?.nextRunAt ?? null)
                : (existing?.nextRunAt ?? null);

        const schedule = await this.scheduleRepository.upsert(directory.id, {
            userId: user.id,
            cadence,
            billingMode,
            status,
            maxFailureBeforePause,
            alwaysCreatePullRequest,
            providerOverrides,
            nextRunAt,
        });

        await this.syncDirectory(directory.id, schedule);

        return this.toDto(schedule, allowances, plan.code, subscriptionsEnabled);
    }

    async cancelSchedule(directoryId: string, user: User) {
        this.ensureSchedulingEnabled();
        // Require editor role to cancel schedule
        const { directory } = await this.ownershipService.ensureCanEdit(directoryId, user.id);
        const subscriptionsEnabled = this.subscriptionService.isEnabled();
        const schedule = await this.scheduleRepository.findByDirectoryId(directory.id);

        if (!schedule) {
            throw new NotFoundException('Schedule not found');
        }

        const updated = await this.scheduleRepository.upsert(directory.id, {
            status: DirectoryScheduleStatus.CANCELED,
            cadence: null,
            nextRunAt: null,
            billingMode: DirectoryScheduleBillingMode.SUBSCRIPTION,
            alwaysCreatePullRequest: false,
            providerOverrides: null,
        });

        await this.syncDirectory(directory.id, updated);

        const [allowances, plan] = await Promise.all([
            this.subscriptionService.getCadenceAllowances(user),
            this.subscriptionService.resolvePlanForUser(user),
        ]);

        return this.toDto(updated, allowances, plan.code, subscriptionsEnabled);
    }

    async pauseSchedule(scheduleId: string) {
        this.ensureSchedulingEnabled();
        const schedule = await this.scheduleRepository.findById(scheduleId);
        if (!schedule) {
            return;
        }

        await this.scheduleRepository.updateById(scheduleId, {
            status: DirectoryScheduleStatus.PAUSED,
            nextRunAt: null,
        });

        await this.syncDirectory(schedule.directoryId, {
            ...schedule,
            status: DirectoryScheduleStatus.PAUSED,
            nextRunAt: null,
        });
    }

    async markRunDispatched(scheduleId: string): Promise<DirectorySchedule | null> {
        const updated = await this.scheduleRepository.tryMarkDispatched(scheduleId);
        if (!updated) {
            return null;
        }

        const schedule = await this.scheduleRepository.findById(scheduleId);
        if (!schedule) {
            return null;
        }

        await this.syncDirectory(schedule.directoryId, {
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
        const nextRunAt = preserveExistingNextRun
            ? (schedule.nextRunAt ?? null)
            : schedule.status === DirectoryScheduleStatus.ACTIVE && schedule.cadence
              ? this.calculateNextRun(schedule.cadence, 0, anchorDate)
              : null;

        await this.scheduleRepository.updateById(schedule.id, {
            lastRunStatus: options.status,
            lastRunAt: new Date(),
            nextRunAt,
            failureCount: 0,
            scheduledFor: null,
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
        const nextRunAt = preserveExistingNextRun
            ? (schedule.nextRunAt ?? null)
            : reachedLimit
              ? null
              : schedule.cadence
                ? new Date(anchorDate.getTime() + this.RETRY_DELAY_MINUTES * 60 * 1000)
                : null;
        const lastRunStatus = preserveExistingNextRun ? null : GenerateStatusType.ERROR;

        await this.scheduleRepository.updateById(schedule.id, {
            failureCount,
            lastRunStatus,
            lastRunAt: new Date(),
            status: reachedLimit ? DirectoryScheduleStatus.PAUSED : schedule.status,
            scheduledFor: null,
            nextRunAt,
        });

        await this.syncDirectory(schedule.directoryId, {
            ...schedule,
            failureCount,
            status: reachedLimit ? DirectoryScheduleStatus.PAUSED : schedule.status,
            lastRunStatus,
            nextRunAt,
        });

        if (reachedLimit) {
            this.logger.warn(
                `Schedule ${schedule.id} paused after ${failureCount} failures${reason ? `: ${reason}` : ''}`,
            );

            const directory = await this.directoryRepository.findById(schedule.directoryId);
            if (directory && this.notificationService) {
                await this.notificationService.notifySchedulePaused(
                    schedule.userId,
                    schedule.directoryId,
                    directory.name,
                    reason || `Paused after ${failureCount} consecutive failures`,
                );
            }
        }
    }

    /**
     * Mark a run as skipped (e.g. directory was already generating).
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
        const nextRunAt = preserveExistingNextRun
            ? (schedule.nextRunAt ?? null)
            : schedule.status === DirectoryScheduleStatus.ACTIVE && schedule.cadence
              ? new Date(baseDate.getTime() + this.RETRY_DELAY_MINUTES * 60 * 1000)
              : null;

        await this.scheduleRepository.updateById(schedule.id, {
            lastRunStatus: null,
            lastRunAt: new Date(),
            nextRunAt,
            scheduledFor: null,
        });

        await this.syncDirectory(schedule.directoryId, {
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
    private resolveAnchorDate(schedule: DirectorySchedule): Date {
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

    /**
     * Manual "run now" requests can execute before the scheduled slot is due.
     * In that case, preserve the existing nextRunAt so we don't skip the upcoming run.
     */
    private isManualRunAheadOfSchedule(schedule: DirectorySchedule): boolean {
        return Boolean(
            !schedule.scheduledFor &&
            schedule.nextRunAt &&
            schedule.nextRunAt.getTime() > Date.now(),
        );
    }

    private isAlreadyMarkedFailed(schedule: DirectorySchedule): boolean {
        if (schedule.lastRunStatus !== GenerateStatusType.ERROR) {
            return false;
        }
        if (!schedule.lastRunAt) {
            return false;
        }
        const windowMs = this.IDEMPOTENT_WINDOW_MINUTES * 60 * 1000;
        return schedule.lastRunAt.getTime() > Date.now() - windowMs;
    }

    async validateRunEntitlement(schedule: DirectorySchedule, user: User): Promise<boolean> {
        if (!this.subscriptionService.isEnabled()) {
            return true;
        }

        // If pay-per-use, no plan limits to check (assuming they can pay)
        if (schedule.billingMode === DirectoryScheduleBillingMode.USAGE) {
            return true;
        }

        const plan = await this.subscriptionService.resolvePlanForUser(user);
        const activeCount = await this.scheduleRepository.countActiveByUser(user.id);

        // If they are over the limit, we must pause this schedule
        // Note: This is a "lazy" enforcement. It happens when the schedule tries to run.
        // Since we are currently "in" a run (conceptually), checking activeCount includes this one.
        // If activeCount > plan.maxDirectories, they are over limit.
        if (activeCount > plan.maxDirectories) {
            this.logger.warn(
                `Pausing schedule ${schedule.id} for user ${user.id}. Plan limit exceeded (${activeCount}/${plan.maxDirectories}).`,
            );

            await this.scheduleRepository.updateById(schedule.id, {
                status: DirectoryScheduleStatus.PAUSED,
                nextRunAt: null,
            });

            await this.syncDirectory(schedule.directoryId, {
                ...schedule,
                status: DirectoryScheduleStatus.PAUSED,
                nextRunAt: null,
            });

            // Publish notification for schedule paused due to plan limit
            const directory = await this.directoryRepository.findById(schedule.directoryId);
            if (directory && this.notificationService) {
                await this.notificationService.notifySchedulePaused(
                    schedule.userId,
                    schedule.directoryId,
                    directory.name,
                    `Plan limit exceeded. Your ${plan.displayName} plan allows ${plan.maxDirectories} active schedules.`,
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
                status: DirectoryScheduleStatus.PAUSED,
                nextRunAt: null,
            });
            await this.syncDirectory(schedule.directoryId, {
                ...schedule,
                status: DirectoryScheduleStatus.PAUSED,
                nextRunAt: null,
            });
            return false;
        }

        return true;
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
                // Snap to the start of the current hour, then advance by one hour.
                // This prevents drift when generation time varies and keeps runs
                // aligned to clean hour boundaries (e.g. 14:00, 15:00, 16:00).
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 1);
                break;
            case DirectoryScheduleCadence.EVERY_3_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 3);
                break;
            case DirectoryScheduleCadence.EVERY_8_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 8);
                break;
            case DirectoryScheduleCadence.EVERY_12_HOURS:
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 12);
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
        subscriptionsEnabled: boolean,
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
            alwaysCreatePullRequest: schedule?.alwaysCreatePullRequest ?? false,
            allowedCadences: allowances,
            planCode: subscriptionsEnabled ? planCode : undefined,
            subscriptionsEnabled,
            providerOverrides: schedule?.providerOverrides ?? null,
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

    private async ensureDirectoryConfigReady(directory: Directory, user: User) {
        // Skip validation for sync directories (they don't need AI config)
        // Sync directories have a sourceRepository and sync from external source
        if (directory.sourceRepository) {
            return;
        }

        try {
            const config = await this.dataGeneratorService
                .getConfig(directory, user)
                .catch(() => null);

            if (!config?.metadata?.last_request_data) {
                throw new BadRequestException({
                    status: 'error',
                    message:
                        'Complete an initial directory setup before enabling scheduled updates.',
                });
            }
        } catch (error) {
            if (error instanceof BadRequestException) {
                throw error;
            }

            throw new BadRequestException({
                status: 'error',
                message: 'Complete an initial directory setup before enabling scheduled updates.',
            });
        }
    }

    private validateProviderOverrides(overrides: ProvidersDto): void {
        const dtoFields = Object.entries(SELECTABLE_PROVIDER_CATEGORIES).map(
            ([, def]) => def.uiKey,
        );
        for (const field of dtoFields) {
            const pluginId = overrides[field as keyof ProvidersDto];
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
