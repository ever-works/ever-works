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

                // Streaming-terminal M6: reap live-claiming sessions with a
                // stale heartbeat, then best-effort publish the pinned exit
                // frame so any attached browser learns the death instead of
                // staring at a frozen pane. Frame publish is fully optional
                // — the DB transition above is the source of truth.
                const terminal = await svc.sweepStaleTerminalSessions();
                if (terminal.swept.length > 0) {
                    logger.warn('agent-run-sweeper reaped stale terminal sessions', {
                        runIds: terminal.swept,
                        cutoffMinutes: terminal.cutoffMinutes,
                    });
                    try {
                        const { TerminalTransportClient } =
                            await import('../../trigger/worker/services/terminal-transport.client.js');
                        const client = new TerminalTransportClient();
                        for (const runId of terminal.swept) {
                            await client.publishExit(runId, -1, 'crashed').catch(() => undefined);
                        }
                    } catch {
                        // No internal API config in this context — DB truth stands.
                    }
                }

                // State-aware sweeper (Wave 4 M6) — SURFACE runs that have
                // been queued past the bound. Deliberately a separate pass
                // from the reap above, because it is the opposite kind of
                // action: nothing is transitioned, nothing is reaped, the
                // run is flagged and its owner is told. Runs on the same
                // 2h cadence — a queued-too-long run is a capacity
                // problem, and capacity problems do not need per-minute
                // detection, they need to stop being invisible.
                const queuedTooLong = await svc.sweepQueuedTooLong();
                if (queuedTooLong.flagged > 0) {
                    logger.warn('agent-run-sweeper flagged queued-too-long runs', {
                        flagged: queuedTooLong.flagged,
                        scanned: queuedTooLong.scanned,
                        notified: queuedTooLong.notified,
                        thresholdMinutes: queuedTooLong.thresholdMinutes,
                    });
                }

                if (summary.swept > 0) {
                    logger.warn('agent-run-sweeper reaped stuck runs', {
                        swept: summary.swept,
                        // M6: of `swept`, how many were checkpoint-and-parked
                        // (resumable) rather than hard-failed.
                        parked: summary.parked,
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

                return { status: 'completed' as const, ...summary, queuedTooLong };
            },
            TriggerInternalModule,
        );
    },
});
