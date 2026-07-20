import { Injectable, Logger, Optional } from '@nestjs/common';
import { config } from '@src/config';
import { WorkScheduleRepository } from '@src/database/repositories/work-schedule.repository';
import { ActivityLogService } from '@src/activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '@src/entities/activity-log.types';
import { WorkGenerationService } from './work-generation.service';
import { WorkScheduleService } from './work-schedule.service';
import type { WorkSchedule } from '@src/entities/work-schedule.entity';

export interface WorkScheduleDispatchEntry {
    scheduleId: string;
    workId: string;
    workName: string;
    workSlug: string;
    workOwner: string;
    scheduledFor: string | null;
    outcome: 'dispatched' | 'skipped' | 'failed';
    message?: string;
    historyId?: string;
}

export interface WorkScheduleDispatchSummary {
    limit: number;
    dueCount: number;
    dispatched: number;
    skipped: number;
    failed: number;
    entries: WorkScheduleDispatchEntry[];
}

/**
 * Per-tick dispatcher for scheduled work-generation runs.
 *
 * Lifecycle of a single `dispatchDue()` call:
 * 1. **Feature gate.** When
 *    {@link config.subscriptions.scheduledUpdatesEnabled} is `false`,
 *    return an empty summary immediately. No error — the caller (a
 *    cron job) can keep ticking harmlessly.
 * 2. **Zombie cleanup.** {@link WorkScheduleService.recoverStuckSchedules}
 *    repairs schedules that a previous worker marked "dispatched"
 *    but never finalised (process crash mid-run). Runs BEFORE the
 *    main loop so an unrecoverable crash from the previous tick
 *    doesn't permanently block the row.
 * 3. **Distributed claim.** For each due schedule,
 *    `markRunDispatched(id)` is the **atomic lock** — it returns
 *    `null` when another worker has already claimed the row, in
 *    which case we count `skipped` and move on. Multiple dispatchers
 *    running concurrently is safe; the race resolves at the DB.
 * 4. **Delegate.** {@link WorkGenerationService.runScheduledUpdate}
 *    actually runs the generation. The dispatcher only counts
 *    outcomes; it does NOT call `markRunFailed` itself because the
 *    inner finalisation paths (`finalizeGeneration`,
 *    `handleSyncFailure`, `updateItemsGenerator` early-exit) own
 *    that already. Catching here would double-count.
 *
 * Default batch size comes from
 * `config.subscriptions.getMaxBatch()` — sized to fit the longest
 * runtime budget of a single tick. The caller can override but
 * raising it without re-budgeting risks the tick exceeding its
 * worker timeout.
 */
@Injectable()
export class WorkScheduleDispatcherService {
    private readonly logger = new Logger(WorkScheduleDispatcherService.name);

    constructor(
        private readonly scheduleRepository: WorkScheduleRepository,
        private readonly workGenerationService: WorkGenerationService,
        private readonly workScheduleService: WorkScheduleService,
        // Schedules P2 — automated-run activity coverage. `@Optional()` so
        // the hand-rolled unit-test constructors (which omit it) keep
        // booting; production DI provides it via `ActivityLogModule`
        // (imported by `WorkModule`). The manual "Run now" endpoint already
        // emits `schedule_executed` from `works.controller.ts`; this closes
        // the gap for CRON-fired scheduled updates so they surface in the
        // Activity (Log) feed too.
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    async dispatchDue(
        limit = config.subscriptions.getMaxBatch(),
    ): Promise<WorkScheduleDispatchSummary> {
        if (!config.subscriptions.scheduledUpdatesEnabled()) {
            this.logger.warn('Scheduled updates disabled, skipping dispatch');
            return {
                limit,
                dueCount: 0,
                dispatched: 0,
                skipped: 0,
                failed: 0,
                entries: [],
            };
        }

        // Step 0: Cleanup zombies
        await this.workScheduleService.recoverStuckSchedules();

        const schedules = await this.scheduleRepository.findDue(limit);
        let summary: WorkScheduleDispatchSummary = {
            limit,
            dueCount: schedules.length,
            dispatched: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        for (const schedule of schedules) {
            try {
                const reservedSchedule =
                    (await this.workScheduleService.markRunDispatched(schedule.id)) || null;

                if (!reservedSchedule) {
                    this.logger.warn(`Schedule ${schedule.id} was already dispatched, skipping`);
                    summary.skipped += 1;
                    summary.entries.push(
                        this.buildEntry(schedule, {
                            outcome: 'skipped',
                            message: 'Schedule was already dispatched by another worker',
                        }),
                    );
                    continue;
                }

                // A worker owns this run now (the claim above is the atomic
                // fence). Record the fire in the Activity feed BEFORE running
                // — best-effort, so a logging hiccup never blocks the actual
                // generation — mirroring how the manual endpoint emits then
                // dispatches. Automated runs were previously invisible in the
                // feed (only WorkGenerationHistory captured them).
                void this.emitScheduleExecuted(reservedSchedule);

                const result =
                    await this.workGenerationService.runScheduledUpdate(reservedSchedule);
                const resultData = result && typeof result === 'object' ? result : null;

                if (resultData?.status === 'skipped') {
                    summary.skipped += 1;
                    summary.entries.push(
                        this.buildEntry(reservedSchedule, {
                            outcome: 'skipped',
                            message: resultData.message,
                            historyId: resultData.historyId,
                        }),
                    );
                    continue;
                }

                summary.dispatched += 1;
                summary.entries.push(
                    this.buildEntry(reservedSchedule, {
                        outcome: 'dispatched',
                        message: resultData?.message,
                        historyId: resultData?.historyId,
                    }),
                );
            } catch (error) {
                // Schedule finalization (markRunFailed) is handled by the inner methods:
                // - finalizeGeneration (for generation errors)
                // - handleSyncFailure (for sync errors)
                // - updateItemsGenerator early-exit (for config errors)
                // We only log here to avoid double-counting failures.
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(
                    `Failed to dispatch scheduled update for work ${schedule.workId}`,
                    error as Error,
                );
                summary.failed += 1;
                summary.entries.push(
                    this.buildEntry(schedule, {
                        outcome: 'failed',
                        message,
                    }),
                );
            }
        }

        return summary;
    }

    /**
     * Emit a `schedule_executed` ActivityLog row for an automated
     * (cron-fired) scheduled update. User-scoped to the schedule owner
     * so it lands in that user's Activity feed. Best-effort: the emit is
     * wrapped so a logging failure can never fail the dispatch loop.
     */
    private async emitScheduleExecuted(schedule: WorkSchedule): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: schedule.userId,
                workId: schedule.workId,
                actionType: ActivityActionType.SCHEDULE_EXECUTED,
                action: 'schedule.executed',
                status: ActivityStatus.COMPLETED,
                summary: 'Scheduled update ran automatically',
                details: {
                    scheduleId: schedule.id,
                    trigger: 'cron',
                    cadence: schedule.cadence ?? null,
                    scheduledFor:
                        schedule.scheduledFor?.toISOString() ??
                        schedule.nextRunAt?.toISOString() ??
                        null,
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Failed to emit schedule_executed activity for schedule ${schedule.id}: ${message}`,
            );
        }
    }

    private buildEntry(
        schedule: WorkSchedule,
        details: Pick<WorkScheduleDispatchEntry, 'outcome' | 'message' | 'historyId'>,
    ): WorkScheduleDispatchEntry {
        const work = schedule.work;

        return {
            scheduleId: schedule.id,
            workId: schedule.workId,
            workName: work?.name ?? schedule.workId,
            workSlug: work?.slug ?? '',
            workOwner: work?.getRepoOwner?.() ?? work?.owner ?? '',
            scheduledFor:
                schedule.scheduledFor?.toISOString() ?? schedule.nextRunAt?.toISOString() ?? null,
            outcome: details.outcome,
            message: details.message,
            historyId: details.historyId,
        };
    }
}
