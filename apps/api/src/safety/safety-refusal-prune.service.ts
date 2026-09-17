import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
    RAIL_REFUSAL_PRUNE_BATCH_SIZE,
    RAIL_REFUSAL_PRUNE_MAX_BATCHES,
    RAIL_REFUSAL_RETENTION_DAYS,
} from '@ever-works/contracts';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { RailRefusalService } from '@ever-works/agent/safety';

/**
 * Safety rails (AW-24) — the nightly retention pass over `rail_refusals`.
 *
 * The refusal log is the evidence behind every guarantee the Safety screen
 * makes, and it is deliberately append-only: nothing edits a row, so the only
 * thing that ever removes one is this. FR-67 fixes the window at
 * {@link RAIL_REFUSAL_RETENTION_DAYS} days and says it is pruned daily.
 *
 * ## Why a cron service and not a queued job
 *
 * This is retention housekeeping over one table, which is exactly what
 * `PluginUsageCleanupService` already is — same `@Cron`, same
 * {@link DistributedTaskLockService} guard, same batched delete. A prune has no
 * payload, no per-item fan-out and nothing to retry individually, so there is
 * no work item for a dispatcher to carry; copying the established retention
 * idiom keeps both passes behaving (and failing) the same way.
 *
 * ## 03:20 UTC
 *
 * Deliberately offset from its neighbours so the nightly passes do not stack
 * on one connection pool: the credits grant runs at 00:05, the terminal
 * transcript sweep at 03:17, the plugin-usage prune at 04:00 and the digest at
 * 07:15.
 *
 * ## The failure posture
 *
 * A prune that fails logs and returns. It never throws: a retention pass is
 * the least important thing this epic does, and an unhandled rejection out of
 * a cron tick is a process-level event. Tomorrow's pass picks up whatever this
 * one left, because the cut-off is computed from `now` rather than from a
 * stored cursor.
 */
@Injectable()
export class SafetyRefusalPruneService {
    private readonly logger = new Logger(SafetyRefusalPruneService.name);

    constructor(
        private readonly refusals: RailRefusalService,
        private readonly taskLock: DistributedTaskLockService,
    ) {}

    @Cron('20 3 * * *')
    async pruneExpiredRefusals(): Promise<void> {
        await this.taskLock.runExclusive(
            'safety-refusals:prune',
            async () => {
                try {
                    const deleted = await this.prune();
                    if (deleted > 0) {
                        this.logger.log(
                            `Safety refusal prune removed ${deleted} row(s) older than ${RAIL_REFUSAL_RETENTION_DAYS} days`,
                        );
                    }
                } catch (error) {
                    this.logger.error('Safety refusal prune failed:', error);
                }
            },
            {
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping the safety refusal prune because another instance holds the task lock',
                    ),
            },
        );
    }

    /**
     * Delete expired rows in bounded batches until a batch comes back short.
     *
     * A short batch means the horizon is clear, so the loop stops on it rather
     * than issuing one more query to prove it. Idempotent by construction:
     * running it twice deletes nothing the second time, because the first pass
     * already moved every row that was past the cut-off.
     */
    async prune(batchSize: number = RAIL_REFUSAL_PRUNE_BATCH_SIZE): Promise<number> {
        let total = 0;
        for (let batch = 0; batch < RAIL_REFUSAL_PRUNE_MAX_BATCHES; batch += 1) {
            const deleted = await this.refusals.prune(RAIL_REFUSAL_RETENTION_DAYS, batchSize);
            total += deleted;
            if (deleted < batchSize) return total;
        }
        this.logger.warn(
            `Safety refusal prune stopped at ${RAIL_REFUSAL_PRUNE_MAX_BATCHES} batches (${total} rows); ` +
                'the remainder is left to the next pass',
        );
        return total;
    }
}
