import { logger, schedules } from '@trigger.dev/sdk';
import { FleetCloudSweepService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/** Every minute — equals the shared `FLEET_CLOUD_BOOTSTRAP_WATCH_CRON` in `@ever-works/contracts`. */
export const FLEET_CLOUD_BOOTSTRAP_WATCH_CRON = '* * * * *';

/**
 * Cloud computers (FL-17, plan §10, spec FR-11, U3) — the bootstrap watch.
 *
 * Settles what is in flight: a create the provider never answered within 10
 * minutes becomes `failed` (nothing is known to exist); a booted machine the
 * provider reports running moves to `installing`; a pending power-off /
 * power-on settles from the provider's state. The "never came online and is
 * billing $x/h" item is computed on read by the `cloud-idle` producer from
 * the same row, so it needs no write here and cannot be raised twice.
 *
 * Reaches `FleetCloudService` through `FleetCloudSweepService.watchBootstrap()`
 * over the internal RPC channel; the API runs the same pass itself when
 * Trigger.dev is not the runtime. Does nothing while `FLEET_CLOUD_ENABLED` is off.
 */
export const fleetCloudBootstrapWatchTask = schedules.task({
    id: 'fleet-cloud-bootstrap-watch',
    cron: FLEET_CLOUD_BOOTSTRAP_WATCH_CRON,
    run: async () => {
        return withWorkerContext(
            'FleetCloudBootstrapWatch',
            async (appContext) => {
                const svc = appContext.get(FleetCloudSweepService);
                const summary = await svc.watchBootstrap();
                if (summary.changed > 0) {
                    logger.info('fleet.cloud.bootstrap-watch.completed', summary);
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
