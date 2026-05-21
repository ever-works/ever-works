import { Injectable, Logger } from '@nestjs/common';
import { WorkRepository } from '@ever-works/agent/database';
import { config } from '@ever-works/agent/config';
import { DataSyncService } from './data-sync.service';
import type { DataSyncOutcome, SyncSource } from './data-sync.types';

/**
 * Outcome of a single Work being dispatched on this tick. Mirrors the
 * shape `WorkScheduleDispatcherService.dispatchDue` uses so the trigger
 * run history surfaces a consistent envelope across the two
 * dispatchers.
 */
export interface DataSyncDispatchEntry {
    workId: string;
    source: SyncSource;
    outcome: 'dispatched' | 'skipped' | 'failed';
    /** Terminal `DataSyncOutcome` shape when `outcome === 'dispatched'`. */
    syncOutcome?: DataSyncOutcome;
    /** Short human-readable reason for skipped / failed rows. */
    message?: string;
}

export interface DataSyncDispatchSummary {
    /** Cap applied per path (`SCHEDULED_UPDATES_MAX_BATCH` env, default 25). */
    limit: number;
    /** Total candidate Works across both paths. */
    dueCount: number;
    dispatched: number;
    skipped: number;
    failed: number;
    entries: DataSyncDispatchEntry[];
}

/**
 * EW-628 dispatcher — fans out due Works to {@link DataSyncService.runDataSync}
 * on each cron tick. Spec: `docs/specs/features/data-repo-instant-sync/spec.md`
 * §5.3 + plan §3/§4.
 *
 * Two paths, executed serially on the same tick:
 *
 *  - **Path A — webhook flush**: Works where the GitHub App `push`
 *    handler set `pendingSyncRequestedAt` and the 30 s debounce window
 *    has elapsed. Dispatcher calls `runDataSync(workId, 'webhook')`.
 *    A successful sync inside the three-gate body clears
 *    `pendingSyncRequestedAt`.
 *
 *  - **Path B — poller fallback**: Works without the App installed,
 *    whose `lastPolledAt` is older than `syncIntervalMinutes` minutes.
 *    Dispatcher calls `runDataSync(workId, 'poll')`. The underlying
 *    `syncFromDataRepo` (G5) captures the data-repo HEAD SHA AFTER
 *    render — comparing against `lastSyncedDataRepoSha` happens there.
 *    A future optimisation can pre-check HEAD via `ls-remote` before
 *    fanning out to avoid an unnecessary clone, but the render itself
 *    is idempotent (identical files = empty git diff = no push).
 *
 * Both paths gate on `subscriptions.dataSync.dispatcherEnabled` — when
 * `false` the dispatcher returns an empty summary so the cron stays
 * registered but the system stays inert.
 *
 * `DataSyncService.runDataSync` never throws — the dispatcher's
 * try/catch is defence-in-depth for the rare case where the lock
 * service itself blows up (DB outage, etc.); the per-Work failure
 * surfaces in the summary so the trigger run history reflects it.
 */
@Injectable()
export class DataSyncDispatcherService {
    private readonly logger = new Logger(DataSyncDispatcherService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly dataSyncService: DataSyncService,
    ) {}

    async dispatchDue(limit?: number): Promise<DataSyncDispatchSummary> {
        const summary: DataSyncDispatchSummary = {
            limit: limit ?? config.subscriptions.getMaxBatch(),
            dueCount: 0,
            dispatched: 0,
            skipped: 0,
            failed: 0,
            entries: [],
        };

        if (!config.subscriptions.dataSync.dispatcherEnabled()) {
            this.logger.debug(
                'Data-sync dispatcher disabled (subscriptions.dataSync.dispatcherEnabled=false); skipping tick',
            );
            return summary;
        }

        const debounceMs = config.subscriptions.dataSync.getDebounceMs();
        const [webhookDue, pollerDue] = await Promise.all([
            this.workRepository.findWebhookFlushDueWorks(debounceMs, summary.limit),
            this.workRepository.findPollerDueWorks(summary.limit),
        ]);

        summary.dueCount = webhookDue.length + pollerDue.length;

        // Path A — webhook flush
        for (const work of webhookDue) {
            await this.runOne(work.id, 'webhook', summary);
        }

        // Path B — poller. Use `lastPolledAt` as a denominator so a
        // failed run still resets the cadence — without it a broken
        // Work would hot-loop every tick. The successful render gate
        // ALSO sets `lastPolledAt` (G3), so the timestamp is
        // representative of the actual poll moment regardless of
        // outcome.
        for (const work of pollerDue) {
            try {
                await this.workRepository.update(work.id, { lastPolledAt: new Date() });
            } catch (err) {
                this.logger.warn(
                    `Data-sync poller: failed to stamp lastPolledAt for work=${work.id}: ${(err as Error).message ?? err}`,
                );
            }
            await this.runOne(work.id, 'poll', summary);
        }

        if (summary.dueCount > 0) {
            this.logger.debug(
                `Data-sync dispatch tick — webhook=${webhookDue.length} poller=${pollerDue.length} dispatched=${summary.dispatched} skipped=${summary.skipped} failed=${summary.failed}`,
            );
        }
        return summary;
    }

    /**
     * Run one Work through `DataSyncService.runDataSync` and account
     * the outcome into the summary. Defensive try/catch — `runDataSync`
     * never throws by contract, but a bug or unforeseen IO failure
     * shouldn't take down the whole dispatch loop.
     */
    private async runOne(
        workId: string,
        source: SyncSource,
        summary: DataSyncDispatchSummary,
    ): Promise<void> {
        try {
            const outcome = await this.dataSyncService.runDataSync(workId, source);
            if (outcome.status === 'success') {
                summary.dispatched += 1;
                summary.entries.push({
                    workId,
                    source,
                    outcome: 'dispatched',
                    syncOutcome: outcome,
                });
            } else if (outcome.status === 'skipped') {
                summary.skipped += 1;
                summary.entries.push({
                    workId,
                    source,
                    outcome: 'skipped',
                    syncOutcome: outcome,
                    message: outcome.reason,
                });
            } else {
                summary.failed += 1;
                summary.entries.push({
                    workId,
                    source,
                    outcome: 'failed',
                    syncOutcome: outcome,
                    message: outcome.errorClass,
                });
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `Data-sync dispatcher: runDataSync(${workId}, ${source}) threw: ${message}`,
            );
            summary.failed += 1;
            summary.entries.push({
                workId,
                source,
                outcome: 'failed',
                message,
            });
        }
    }
}
