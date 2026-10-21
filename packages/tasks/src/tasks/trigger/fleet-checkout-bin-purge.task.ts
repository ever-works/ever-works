import { logger, schedules } from '@trigger.dev/sdk';
import { FleetCheckoutReconcileService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Daily at 03:23. A literal, read at module load where Trigger.dev indexes it;
 * it equals the shared `FLEET_CHECKOUT_BIN_PURGE_CRON` in `@ever-works/contracts`
 * the API fallback cron uses.
 */
export const FLEET_CHECKOUT_BIN_PURGE_CRON = '23 3 * * *';

/**
 * Checkouts on computers (FL-14 P3, spec FR-33, T-31) — the bin purge.
 *
 * Rows in the bin longer than 30 days whose folder a delete removed are
 * dropped: rows only, never a folder, never on read. Idempotent (a delete by
 * id). The worker reaches the API's `FleetCheckoutService` through the
 * one-member-per-job facade `FleetCheckoutReconcileService.purgeBin()` over
 * the internal RPC channel; when Trigger.dev is not the runtime the API runs
 * the same pass itself (`FleetCheckoutReconcileCronService.runBinPurge`).
 * Does nothing while `FLEET_CHECKOUTS_ENABLED` is off.
 */
export const fleetCheckoutBinPurgeTask = schedules.task({
    id: 'fleet-checkout-bin-purge',
    cron: FLEET_CHECKOUT_BIN_PURGE_CRON,
    run: async () => {
        return withWorkerContext(
            'FleetCheckoutBinPurge',
            async (appContext) => {
                const svc = appContext.get(FleetCheckoutReconcileService);
                const summary = await svc.purgeBin();
                if (summary.purged > 0) logger.info('fleet.checkout.bin-purge.completed', summary);
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
