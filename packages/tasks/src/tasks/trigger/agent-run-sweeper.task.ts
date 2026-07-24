import { logger, schedules } from '@trigger.dev/sdk';
import { AgentRunSweeperService } from '@ever-works/agent/agents';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Stuck-run sweep for `agent_runs`.
 *
 * A worker killed without reaching any checkpoint — OOM, node eviction,
 * deploy, Trigger.dev teardown — leaves its row in `queued`/`running` forever.
 * Nothing reaped it: `AgentScheduleDispatcherService.recoverStuckRunning()`
 * sweeps `agents` rows only. The stranded row then keeps
 * `findInFlightForTaskAgent` reporting an in-flight run, which permanently
 * suppresses dispatch for that task-agent pair.
 *
 * Its own schedule rather than a step inside the heartbeat dispatcher, mirroring
 * `kb-reconcile` (the same job for a different table). Three reasons:
 *
 *   1. The dispatcher runs every minute against a multi-hour cutoff — ~360x
 *      more often than useful.
 *   2. `agent-heartbeat-dispatcher` has no upper clamp on its interval, so a
 *      large `AGENT_DISPATCH_INTERVAL_MINUTES` would silently disable a
 *      piggybacked sweep.
 *   3. A reap is a signal that something upstream died. Buried inside one of
 *      ~1440 daily dispatcher ticks it is invisible; with its own task id it
 *      has its own run history.
 *
 * It also keeps firing when `AGENTS_DISPATCHER_ENABLED=false`, which is exactly
 * when rows are most likely to be stranded.
 *
 * Cron offset off the hour, per the `kb-reconcile` rationale, so it does not
 * collide with `anonymous-user-cleanup` (03:17) or the per-minute crons. Every
 * 2h against a multi-hour cutoff bounds detection lag to `cutoff + 2h`.
 */
export const agentRunSweeperTask = schedules.task({
    id: 'agent-run-sweeper',
    cron: '23 */2 * * *',
    run: async () => {
        // NOTE the third argument. `withWorkerContext` defaults to
        // `TriggerWorkerModule`, which does NOT register the
        // AgentRunSweeperService remote proxy — omitting it fails at runtime
        // on every fire, silently, forever.
        return withWorkerContext(
            'AgentRunSweeper',
            async (appContext) => {
                const svc = appContext.get(AgentRunSweeperService);
                const summary = await svc.sweepStuckRuns();

                if (summary.swept > 0) {
                    logger.warn('agent-run-sweeper reaped stuck runs', {
                        swept: summary.swept,
                        scanned: summary.scanned,
                        cutoffMinutes: summary.cutoffMinutes,
                        oldestAgeMs: summary.oldestAgeMs,
                        byKind: summary.byKind,
                        batchLimitReached: summary.batchLimitReached,
                    });
                } else {
                    logger.info('agent-run-sweeper found nothing stuck', {
                        enabled: summary.enabled,
                        cutoffMinutes: summary.cutoffMinutes,
                    });
                }

                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
