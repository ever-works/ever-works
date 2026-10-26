import { logger, schedules } from '@trigger.dev/sdk';
import { FleetCloudSweepService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/** Every ten minutes — equals the shared `FLEET_CLOUD_USAGE_CRON` in `@ever-works/contracts`. */
export const FLEET_CLOUD_USAGE_CRON = '*/10 * * * *';

/**
 * Cloud computers (FL-17 P2, plan §10, spec FR-21, FR-23) — the cost refresh.
 *
 * Recomputes every cloud computer's cost snapshot (per hour now, this month,
 * since created, projected month — per second, capped at the monthly price per
 * calendar month) and, where the provider plugin can read it, the provider's
 * own account-wide month-to-date figure (one call per provider and owner). A
 * snapshot computed in the last five minutes is skipped, so overlapping fires
 * write once. Estimates only; never added to model-spend Budgets (FR-24).
 *
 * Reaches `FleetCloudService` through `FleetCloudSweepService.refreshUsage()`
 * over the internal RPC channel; the API runs the same pass itself when
 * Trigger.dev is not the runtime. Does nothing while `FLEET_CLOUD_ENABLED` is off.
 */
export const fleetCloudUsageTask = schedules.task({
    id: 'fleet-cloud-usage',
    cron: FLEET_CLOUD_USAGE_CRON,
    run: async () => {
        return withWorkerContext(
            'FleetCloudUsage',
            async (appContext) => {
                const svc = appContext.get(FleetCloudSweepService);
                const summary = await svc.refreshUsage();
                if (summary.changed > 0) {
                    logger.info('fleet.cloud.usage.completed', summary);
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
