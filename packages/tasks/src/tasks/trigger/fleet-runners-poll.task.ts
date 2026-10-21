import { logger, schedules } from '@trigger.dev/sdk';
import { FleetActionsRunnersPollService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Every five minutes at :01, :06, … A literal, read at module load where
 * Trigger.dev indexes it; it equals the shared `FLEET_ACTIONS_RUNNERS_POLL_CRON`
 * in `@ever-works/contracts` the API fallback cron uses.
 */
export const FLEET_RUNNERS_POLL_CRON = '1/5 * * * *';

/**
 * Actions runners on computers (FL-18, plan §10, T-18) — the off-page refresh.
 *
 * For every owner with runners: GitHub's runner list per repository or
 * organisation (conditional, backing off to GitHub's reset time while it is
 * rate-limiting), and every online computer's `runner.list` over its node link;
 * the two are merged (GitHub wins when read, a disagreement reads `unknown`
 * with the reason). The `runner-stopped` "needs a look" item is computed from
 * the rows this keeps fresh. Writes only on a change, so two overlapping fires
 * change nothing twice.
 *
 * The real `FleetActionsRunnersService` lives in the API (GitHub App, the
 * repositories and the node link wired there); the worker reaches it through
 * the one-member facade (`FleetActionsRunnersPollService.reconcile()`) over the
 * internal RPC channel — the `fleet-virtual-reconcile` shape. When Trigger.dev
 * is not the runtime the API runs the same pass itself
 * (`FleetActionsRunnersPollCronService`). Does nothing while
 * `FLEET_ACTIONS_RUNNERS_ENABLED` is off (the facade reads it).
 */
export const fleetRunnersPollTask = schedules.task({
    id: 'fleet-runners-poll',
    cron: FLEET_RUNNERS_POLL_CRON,
    run: async () => {
        // NOTE the third argument: the default worker module does NOT register
        // the FleetActionsRunnersPollService remote proxy.
        return withWorkerContext(
            'FleetActionsRunnersPoll',
            async (appContext) => {
                const svc = appContext.get(FleetActionsRunnersPollService);
                const summary = await svc.reconcile();
                if (summary.changed > 0) {
                    logger.info('fleet.runners.poll.completed', summary);
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
