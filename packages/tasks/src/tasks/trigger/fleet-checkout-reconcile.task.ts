import { logger, schedules } from '@trigger.dev/sdk';
import { FleetCheckoutReconcileService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Every ten minutes at :07, :17, … A literal, read at module load where
 * Trigger.dev indexes it; it equals the shared `FLEET_CHECKOUT_RECONCILE_CRON`
 * in `@ever-works/contracts` the API fallback cron uses.
 */
export const FLEET_CHECKOUT_RECONCILE_CRON = '7-59/10 * * * *';

/**
 * Checkouts on computers (FL-14, plan §10, T-15) — the reconcile sweep.
 *
 * Rows left `creating` for ten minutes become `missing` with
 * `lastCommand.exitCode = -1` (never a phantom `creating`, spec §6), and
 * connected computers whose checkout list is older than ten minutes are asked
 * for it again (spec FR-11), so a folder removed by hand reads `missing`
 * within ten minutes. Idempotent: every write is a compare-and-set on
 * `updatedAt`, so an overlapping or retried fire changes nothing.
 *
 * The real `FleetCheckoutService` lives in the API (repositories and the node
 * link wired there); the worker reaches it through a one-member facade
 * (`FleetCheckoutReconcileService.reconcile()`) over the internal RPC channel
 * — the shape of `fleet-session-sweeper`. When Trigger.dev is not the runtime
 * the API runs the same pass itself (`FleetCheckoutReconcileCronService`).
 * Does nothing while `FLEET_CHECKOUTS_ENABLED` is off (the facade reads it).
 */
export const fleetCheckoutReconcileTask = schedules.task({
    id: 'fleet-checkout-reconcile',
    cron: FLEET_CHECKOUT_RECONCILE_CRON,
    run: async () => {
        // NOTE the third argument: the default worker module does NOT register
        // the FleetCheckoutReconcileService remote proxy.
        return withWorkerContext(
            'FleetCheckoutReconcile',
            async (appContext) => {
                const svc = appContext.get(FleetCheckoutReconcileService);
                const summary = await svc.reconcile();
                if (summary.swept > 0 || summary.asked > 0) {
                    logger.info('fleet.checkout.reconcile.completed', summary);
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
