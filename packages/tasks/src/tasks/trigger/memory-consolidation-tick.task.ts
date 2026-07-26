import { logger, schedules } from '@trigger.dev/sdk';
import { MemoryConsolidationScheduleService } from '@ever-works/agent/services';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Memory consolidation cadence (memory upgrades M9).
 *
 * Runs the EXISTING `MemoryConsolidationService` on a schedule instead
 * of only when somebody presses the button on the Memory page. What it
 * does NOT do is as important as what it does:
 *
 *  - it only touches organizations that explicitly opted in
 *    (`organizations.memory_consolidation.enabled === true`),
 *  - the pass is **dry-run by default** — it computes the report and
 *    persists nothing unless the org chose `mode: 'propose'`,
 *  - even in `propose` mode nothing is auto-applied: synthesized
 *    documents land as `reviewState: 'proposed'`, excluded from every
 *    prompt until a human accepts them in the review queue, and
 *    duplicates are MARKED superseded rather than deleted.
 *
 * The cron fires DAILY; the per-org cadence (`daily` / `weekly` /
 * `monthly`) is enforced inside the service against `lastRunAt`, so one
 * schedule serves every cadence and a weekly org is not consolidated
 * seven times a week. Offset off the hour per the sweeper-family
 * rationale (see agent-run-sweeper) and placed after the digest window
 * so a morning digest never races a consolidation write.
 *
 * The real service lives in the API (org + tenant repositories, the AI
 * facade and the notifications producer are wired there); the worker
 * only calls `dispatchDue()` over the internal RPC channel — same shape
 * as digest-dispatcher / event-ingest-tick / mission-tick. On a local
 * install the same task runs on whatever job-runtime plugin is
 * configured: cadence is a job, not a cloud feature.
 */
export const memoryConsolidationTickTask = schedules.task({
    id: 'memory-consolidation-tick',
    cron: '37 8 * * *',
    run: async () => {
        return withWorkerContext(
            'MemoryConsolidationTick',
            async (appContext) => {
                const svc = appContext.get(MemoryConsolidationScheduleService);
                const summary = await svc.dispatchDue();
                // Quiet when there is nothing to say — a daily "0 orgs"
                // line is log noise that trains people to skim.
                if (summary.ran > 0 || summary.skipped.failed > 0) {
                    logger.info('memory-consolidation-tick pass', { ...summary });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
