import { logger, schedules } from '@trigger.dev/sdk';
import { MemoryFactSweepService } from '@ever-works/agent/services';
import { runMemoryFactGcJob } from '@ever-works/agent/tasks';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * AW-07 — the nightly memory-fact sweep.
 *
 * One pass does three things, in order (see `MemoryFactSweepService`):
 *
 *  1. purges facts forgotten more than 30 days ago — the only place a fact
 *     is ever deleted, and the end of its restore window;
 *  2. embeds facts that were saved while no job runtime, AI provider or
 *     vector store was available — how meaning-based search catches up on
 *     its own once a provider appears;
 *  3. re-embeds facts whose vector came from a model, dimension or store
 *     that is no longer the current one, capped per pass.
 *
 * `13 4 * * *` — offset off the hour per the sweeper-family rationale and
 * clear of the other daily crons in this folder (`task-branch-gc` 04:41,
 * `kb-reconcile` 03:42, `terminal-transcript-gc` and
 * `anonymous-user-cleanup` 03:17, `digest-dispatcher` 07:15,
 * `memory-consolidation-tick` 08:37, `credits-daily-grant` 00:05).
 *
 * The real service lives in the API; the worker calls `sweep()` over the
 * internal RPC channel.
 *
 * ## On runtimes other than Trigger.dev
 *
 * This is the Trigger.dev registration of the sweep, matching every other
 * cron in this folder. When Trigger.dev is not the configured runtime, the
 * API runs the same pass itself — `MemoryFactGcCronService` in
 * `apps/api/src/memory-facts/`, gated on `!config.trigger.shouldUseTrigger()`
 * and distributed-locked, the established fallback
 * `WorkScheduleDispatcherCronService` uses — so forgotten facts are still
 * purged at the end of their restore window on every install.
 */
export const memoryFactGcTask = schedules.task({
    // Literals, read at module load where Trigger.dev indexes them;
    // `memory-fact-tasks.spec.ts` pins both equal to the shared
    // MEMORY_FACT_GC_JOB_ID / MEMORY_FACT_GC_CRON the API fallback uses.
    id: 'memory-fact-gc',
    cron: '13 4 * * *',
    run: async () => {
        return withWorkerContext(
            'MemoryFactGc',
            async (appContext) => {
                const svc = appContext.get(MemoryFactSweepService);
                const summary = await runMemoryFactGcJob(svc);
                // Quiet when there is nothing to say.
                if (
                    summary.purged > 0 ||
                    summary.embedded > 0 ||
                    summary.reembedded > 0 ||
                    summary.embedStoppedReason
                ) {
                    logger.info('memory-fact-gc pass', { ...summary });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
