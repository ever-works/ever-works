import { logger, schedules } from '@trigger.dev/sdk';
import { TerminalTranscriptService } from '@ever-works/agent/agents';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Terminal transcript retention sweep (streaming-terminal M9 / founder
 * decision D1).
 *
 * D1 made retention a **plan-tier lever**: "forever" on top plans,
 * bounded windows on cheap ones. That promise needs a pruner, so this
 * cron runs beside the `task-branch-gc` sweeper (03:17 UTC — offset off
 * the hour per the sweeper-family rationale, and clear of both
 * `task-branch-gc` at 04:41 and `credits-daily-grant` at 00:05).
 *
 * The sweep resolves EACH RUN's owner plan, not a single global window:
 *
 *   -1 → skipped entirely (forever)
 *    0 → every chunk for that run is deleted
 *    N → chunks older than N days are deleted
 *
 * Per-run resolution is what makes a plan downgrade take effect: the
 * next nightly pass shortens an already-stored transcript to the new
 * tier's window. A tier lookup that fails leaves the data alone —
 * retention must never delete on a lookup error.
 *
 * The real `TerminalTranscriptService` lives in the API (chunk
 * repository + plan entitlements are wired there); the worker only calls
 * `sweepExpired()` over the internal RPC channel — same shape as the
 * credits-daily-grant / task-branch-gc crons.
 */
export const terminalTranscriptGcTask = schedules.task({
    id: 'terminal-transcript-gc',
    cron: '17 3 * * *',
    run: async () => {
        return withWorkerContext(
            'TerminalTranscriptGc',
            async (appContext) => {
                const svc = appContext.get(TerminalTranscriptService);
                const summary = await svc.sweepExpired();
                if (summary.deletedChunks > 0 || summary.prunedRuns > 0) {
                    logger.info('terminal-transcript-gc pruned expired transcripts', {
                        ...summary,
                    });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
