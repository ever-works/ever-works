import { logger, schedules } from '@trigger.dev/sdk';
import { WorkflowRunSweeperService } from '@ever-works/agent/services';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerWorkflowRunSweeperModule } from '../../trigger/worker/modules/trigger-workflow-run-sweeper.module';

/**
 * Stuck-row sweep for `workflow_runs` (judgment layer G5).
 *
 * The `workflow-run` task's `onFailure` hook is the PRIMARY recovery path and
 * handles every failure the runtime can report. This is the backstop for the
 * ones it cannot: a hard OOM, a node eviction, a `release-trigger-prod` deploy
 * landing mid-walk, or `maxDuration` expiry. In each of those the process is
 * gone before `onFailure` can run, and because the task declares
 * `maxAttempts: 1` there is no redelivery either — so without this the row
 * reads `queued`/`running` forever, with `finishedAt` and `durationMs` NULL
 * and no cancel route to clear it.
 *
 * `agent_runs` has had this pair (an `onFailure` write plus
 * `agent-run-sweeper`) since the sweeper was added for it, and
 * `agent-run.repository.ts` records why: those rows are "abandoned by a worker
 * that died without reaching any checkpoint — OOM, node eviction, deploy,
 * Trigger.dev teardown. Nothing else reaps them." `workflow_runs` shipped with
 * neither half.
 *
 * Its own schedule rather than a pass inside another task, per the
 * `agent-run-sweeper` / `kb-reconcile` rationale: a reap is a signal that
 * something upstream died, and buried inside another task's run history it is
 * invisible. Cron offset off the hour so it does not collide with the
 * per-minute dispatchers or the other sweeps — `agent-run-sweeper` runs at
 * minute 23 of every second hour, `task-branch-gc` daily at 04:41. Hourly
 * against a 90-minute cutoff bounds detection lag to `cutoff + 1h`.
 */
export const workflowRunSweeperTask = schedules.task({
    id: 'workflow-run-sweeper',
    cron: '37 * * * *',
    run: async () => {
        // NOTE the third argument. `withWorkerContext` defaults to
        // `TriggerWorkerModule`, which provides neither
        // `WorkflowRunSweeperService` nor `WorkflowRunRepository` — omitting it
        // fails at runtime, on every fire, silently, forever.
        return withWorkerContext(
            'WorkflowRunSweeper',
            async (appContext) => {
                const sweeper = appContext.get(WorkflowRunSweeperService);
                const summary = await sweeper.sweepStuckRuns();

                if (!summary.enabled) {
                    logger.log('workflow-run-sweeper disabled by kill switch');
                    return summary;
                }

                // Only speak when something was reaped. A reap means a worker
                // died; an empty tick is the normal case and logging it hourly
                // would bury the signal.
                if (summary.swept.length > 0) {
                    logger.warn('workflow-run-sweeper reaped abandoned runs', {
                        runIds: summary.swept,
                        scanned: summary.scanned,
                        cutoffMinutes: summary.cutoffMinutes,
                    });
                }

                return summary;
            },
            TriggerWorkflowRunSweeperModule,
        );
    },
});
