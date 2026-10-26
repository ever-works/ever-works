import { logger, schedules } from '@trigger.dev/sdk';
import { FleetCloudSweepService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/** Every ten minutes at :05, :15, … — equals the shared `FLEET_CLOUD_IDLE_CRON` in `@ever-works/contracts`. */
export const FLEET_CLOUD_IDLE_CRON = '5-55/10 * * * *';

/**
 * Cloud computers (FL-17 P2, plan §10, spec FR-25 – FR-28) — the idle policy.
 *
 * For every cloud computer: idle means no Session working (or needing you),
 * no job leased or running and the CPU under 5 % in every health sample, for
 * the whole window; a powered-off or still-enrolling machine is never idle.
 * Once per window the policy acts: "tell me" files one Inbox notice (the
 * `cloud-idle` item is computed on read), "power off" powers the machine off
 * and audits `node.cloud.power` with `requestedBy: system:idle-policy`. It
 * NEVER destroys anything.
 *
 * Reaches `FleetCloudService` through `FleetCloudSweepService.evaluateIdle()`
 * over the internal RPC channel; the API runs the same pass itself when
 * Trigger.dev is not the runtime. Does nothing while `FLEET_CLOUD_ENABLED` is off.
 */
export const fleetCloudIdleTask = schedules.task({
    id: 'fleet-cloud-idle',
    cron: FLEET_CLOUD_IDLE_CRON,
    run: async () => {
        return withWorkerContext(
            'FleetCloudIdle',
            async (appContext) => {
                const svc = appContext.get(FleetCloudSweepService);
                const summary = await svc.evaluateIdle();
                if (summary.acted > 0) {
                    logger.info('fleet.cloud.idle.completed', summary);
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
