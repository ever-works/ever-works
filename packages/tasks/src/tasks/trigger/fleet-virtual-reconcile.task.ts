import { logger, schedules } from '@trigger.dev/sdk';
import { FleetVirtualReconcileService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Every five minutes at :04, :09, … A literal, read at module load where
 * Trigger.dev indexes it; it equals the shared `FLEET_VIRTUAL_RECONCILE_CRON`
 * in `@ever-works/contracts` the API fallback cron uses.
 */
export const FLEET_VIRTUAL_RECONCILE_CRON = '4/5 * * * *';

/**
 * Virtual computers (FL-16, plan §10, T-24) — the reconcile sweep.
 *
 * For each online host with children, `vm.list` over its node link: a child
 * whose machine is gone on the host reads `gone` (and may then be removed,
 * spec FR-30) within one cycle; a running / stopped machine updates the row. A
 * guest that asked for its enrolment token more than 20 minutes ago and never
 * heartbeated reads `not-enrolled` (U10). Writes only on a change, so two
 * overlapping fires change nothing twice.
 *
 * The real `FleetVirtualService` lives in the API (repositories and the node
 * link wired there); the worker reaches it through the one-member facade
 * (`FleetVirtualReconcileService.reconcile()`) over the internal RPC channel —
 * the `fleet-checkout-reconcile` shape. When Trigger.dev is not the runtime the
 * API runs the same pass itself (`FleetVirtualReconcileCronService`). Does
 * nothing while `FLEET_VIRTUAL_ENABLED` is off (the facade reads it).
 */
export const fleetVirtualReconcileTask = schedules.task({
    id: 'fleet-virtual-reconcile',
    cron: FLEET_VIRTUAL_RECONCILE_CRON,
    run: async () => {
        // NOTE the third argument: the default worker module does NOT register
        // the FleetVirtualReconcileService remote proxy.
        return withWorkerContext(
            'FleetVirtualReconcile',
            async (appContext) => {
                const svc = appContext.get(FleetVirtualReconcileService);
                const summary = await svc.reconcile();
                if (summary.changed > 0) {
                    logger.info('fleet.virtual.reconcile.completed', summary);
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
