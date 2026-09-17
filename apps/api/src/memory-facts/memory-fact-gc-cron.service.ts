import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { MemoryFactSweepService } from '@ever-works/agent/services';
import { MEMORY_FACT_GC_CRON, runMemoryFactGcJob } from '@ever-works/agent/tasks';

const MEMORY_FACT_GC_LOCK_KEY = 'memory-facts:gc';

/**
 * AW-07 — the nightly memory-fact sweep when Trigger.dev is not the runtime.
 *
 * On a Trigger.dev install the `memory-fact-gc` scheduled task fires the
 * pass (and RPCs `sweep()` back into this process). Every other install —
 * a different job-runtime plugin, or none at all — would otherwise never
 * purge a forgotten fact at the end of its restore window, and never
 * backfill the embeddings of facts saved while nothing could embed them.
 *
 * This is the established fallback shape, not a new mechanism: exactly what
 * `WorkScheduleDispatcherCronService` and `ScheduledReRunService` do for
 * their own Trigger.dev crons — a Nest `@Cron` gated on
 * `!config.trigger.shouldUseTrigger()` so the two never both run, wrapped in
 * `DistributedTaskLockService` so only one API replica runs a pass.
 *
 * Same cron (`MEMORY_FACT_GC_CRON`) and the same runtime-neutral handler
 * (`runMemoryFactGcJob`) the Trigger.dev task uses, so the pass is identical
 * whichever scheduler fires it.
 */
@Injectable()
export class MemoryFactGcCronService {
    private readonly logger = new Logger(MemoryFactGcCronService.name);

    constructor(
        private readonly sweeper: MemoryFactSweepService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(MEMORY_FACT_GC_CRON)
    async runNightlySweep(): Promise<void> {
        if (config.trigger.shouldUseTrigger()) {
            // The `memory-fact-gc` Trigger.dev schedule owns the pass.
            return;
        }

        await this.taskLockService.runExclusive(
            MEMORY_FACT_GC_LOCK_KEY,
            async () => {
                try {
                    const summary = await runMemoryFactGcJob(this.sweeper);
                    if (
                        summary.purged > 0 ||
                        summary.embedded > 0 ||
                        summary.reembedded > 0 ||
                        summary.embedStoppedReason
                    ) {
                        this.logger.log(
                            `memory-fact-gc pass: ${summary.purged} purged, ${summary.embedded} embedded, ` +
                                `${summary.reembedded} re-embedded` +
                                (summary.embedStoppedReason
                                    ? ` (embedding stopped: ${summary.embedStoppedReason})`
                                    : ''),
                        );
                    }
                } catch (error) {
                    const stack = error instanceof Error ? error.stack : String(error);
                    this.logger.error('memory-fact-gc pass failed', stack);
                }
            },
            {
                // A pass is bounded (capped re-embed batch), an hour is ample.
                ttlMs: 60 * 60 * 1000,
                onLocked: () =>
                    this.logger.debug(
                        'Skipping memory-fact-gc pass because another instance holds the task lock',
                    ),
            },
        );
    }
}
