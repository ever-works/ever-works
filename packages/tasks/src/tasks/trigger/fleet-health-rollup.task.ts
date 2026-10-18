import { logger, schedules } from '@trigger.dev/sdk';
import { FleetNodeHealthService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Hourly at :07. A literal, read at module load where Trigger.dev indexes
 * it; `fleet-health-rollup.task.spec.ts` pins it equal to the shared
 * `FLEET_HEALTH_ROLLUP_CRON` in `@ever-works/contracts` the API fallback uses.
 */
export const FLEET_HEALTH_ROLLUP_CRON = '7 * * * *';

/**
 * Computer health (FL-03) — the hourly roll-up and retention of
 * `fleet_node_health_samples` (CONTRACTS §4.5, FR-19).
 *
 * Every completed hour not yet rolled up becomes one `hourly` row per node
 * (the hour's means, plus `cpuMax` / `memMax` / `diskMax`); then raw rows
 * past 7 days and hourly rows past 90 days are deleted. Idempotent: a re-run
 * inserts nothing (unique `(nodeId, resolution, at)`) and deletes nothing
 * more, so an overlapping or retried fire is harmless. Retention runs here and
 * only here — never on a read.
 *
 * The real `FleetNodeHealthService` lives in the API (repositories wired
 * there); the worker only calls `rollupAndPrune()` over the internal RPC
 * channel — the same shape as `fleet-job-lease-sweeper`. With
 * `FLEET_HEALTH_HISTORY_ENABLED` off the call rolls nothing and reports
 * `enabled: false`, but still ages out rows written before the history was
 * switched off.
 *
 * ## On runtimes other than Trigger.dev
 *
 * When Trigger.dev is not the configured runtime, the API runs the same pass
 * itself — `FleetHealthRollupCronService` in `apps/api/src/fleet/`, gated on
 * `!config.trigger.shouldUseTrigger()` and distributed-locked, the fallback
 * shape `SkillReadinessSweepCronService` uses — so the history is bounded on
 * every install.
 */
export const fleetHealthRollupTask = schedules.task({
    id: 'fleet-health-rollup',
    cron: FLEET_HEALTH_ROLLUP_CRON,
    run: async () => {
        // NOTE the third argument: the default worker module does NOT register
        // the FleetNodeHealthService remote proxy — omitting it would fail on
        // every fire, silently.
        return withWorkerContext(
            'FleetHealthRollup',
            async (appContext) => {
                const svc = appContext.get(FleetNodeHealthService);
                const summary = await svc.rollupAndPrune();
                // Counters only, and quiet when there was nothing to do.
                if (summary.rolledHours > 0 || summary.prunedRaw > 0 || summary.prunedHourly > 0) {
                    logger.info('fleet.health.rollup.completed', {
                        rolledHours: summary.rolledHours,
                        hourlyRows: summary.hourlyRows,
                        prunedRaw: summary.prunedRaw,
                        prunedHourly: summary.prunedHourly,
                    });
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
