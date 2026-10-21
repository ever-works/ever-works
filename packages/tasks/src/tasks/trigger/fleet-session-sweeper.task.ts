import { logger, schedules } from '@trigger.dev/sdk';
import { FleetSessionSweepService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Every five minutes at :04, :09, … A literal, read at module load where
 * Trigger.dev indexes it; it equals the shared `FLEET_SESSION_SWEEP_CRON` in
 * `@ever-works/contracts` the API fallback cron uses.
 */
export const FLEET_SESSION_SWEEP_CRON = '4-59/5 * * * *';

/**
 * Sessions on computers (FL-04, plan §10, T-30) — the session sweeper.
 *
 * Owner sessions still `starting` a minute after they were asked for are
 * ended `timeout`, outcome `unconfirmed`. Sessions on an offline computer are
 * NEVER ended here — its session daemon may still hold them, and the node
 * reports their fate when it returns (`session.list`). Idempotent: every end
 * is a conditional `UPDATE … WHERE state <> 'ended'`, so an overlapping or
 * retried fire changes nothing.
 *
 * The real `FleetSessionService` lives in the API (repositories wired there);
 * the worker reaches it through a one-member facade
 * (`FleetSessionSweepService.sweepStale()`) over the internal RPC channel —
 * the shape of `fleet-health-rollup`. When Trigger.dev is not the runtime the
 * API runs the same pass itself (`FleetSessionSweepCronService`).
 */
export const fleetSessionSweeperTask = schedules.task({
    id: 'fleet-session-sweeper',
    cron: FLEET_SESSION_SWEEP_CRON,
    run: async () => {
        // NOTE the third argument: the default worker module does NOT register
        // the FleetSessionSweepService remote proxy.
        return withWorkerContext(
            'FleetSessionSweeper',
            async (appContext) => {
                const svc = appContext.get(FleetSessionSweepService);
                const summary = await svc.sweepStale();
                if (summary.ended > 0) {
                    logger.info('fleet.session.sweep.completed', { ended: summary.ended });
                }
                return { status: 'completed' as const, ...summary };
            },
            TriggerInternalModule,
        );
    },
});
