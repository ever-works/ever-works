import { logger, schedules } from '@trigger.dev/sdk';
import { FleetCloudSweepService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Minute 17 of every hour. A literal, read at module load where Trigger.dev
 * indexes it; it equals the shared `FLEET_CLOUD_RECONCILE_CRON` in
 * `@ever-works/contracts` the API fallback cron uses.
 */
export const FLEET_CLOUD_RECONCILE_CRON = '17 * * * *';

/**
 * Cloud computers (FL-17, plan §10, spec FR-29, U6) — reconciliation.
 *
 * For every cloud computer with a machine, ask its provider (through the
 * machine-provider facade) for the machine: one the provider no longer knows
 * reads `gone` — cost stops accruing and "Remove from Fleet" becomes available
 * (CONTRACTS R-36); a running / off machine updates the power state and
 * settles a pending power act. One provider call per machine; writes only on a
 * change. A disabled plugin is skipped (spec U5).
 *
 * The real `FleetCloudService` lives in the API; the worker reaches it through
 * the two-member facade (`FleetCloudSweepService`) over the internal RPC
 * channel. When Trigger.dev is not the runtime the API runs the same pass
 * itself (`FleetCloudSweepCronService`). Does nothing while
 * `FLEET_CLOUD_ENABLED` is off (the facade reads it).
 */
export const fleetCloudReconcileTask = schedules.task({
    id: 'fleet-cloud-reconcile',
    cron: FLEET_CLOUD_RECONCILE_CRON,
    run: async () => {
        // NOTE the third argument: the default worker module does NOT register
        // the FleetCloudSweepService remote proxy.
        return withWorkerContext(
            'FleetCloudReconcile',
            async (appContext) => {
                const svc = appContext.get(FleetCloudSweepService);
                const summary = await svc.reconcile();
                if (summary.changed > 0) {
                    logger.info('fleet.cloud.reconcile.completed', summary);
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
