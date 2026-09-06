import { logger, schedules } from '@trigger.dev/sdk';
import { FleetJobService } from '@ever-works/agent/fleet';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Expired-lease reclaim for `fleet_jobs` (Desktop PRD M4).
 *
 * A fleet lease is a DEADLINE, not a lock: when a node dies mid-job —
 * laptop closed, machine slept, process killed — nothing releases its
 * claim, and the row would otherwise sit `leased`/`running` forever with
 * work nobody is doing.
 *
 * Reclaim already runs INLINE on every `POST /api/fleet/jobs/lease`
 * (owner-scoped, bounded), which covers the common case: a healthy node
 * polls, and its dead sibling's work is re-offered on that same poll.
 * This cron covers the case inline reclaim structurally cannot — a fleet
 * where EVERY node went away. Without it, an owner whose only machine
 * died would come back to a queue frozen at the moment of death.
 *
 * Every 5 minutes, against a lease TTL whose default is 5 minutes: the
 * detection lag a user actually experiences is bounded by
 * `leaseTtl + 5min`, which is the right order of magnitude for "my
 * laptop slept and the build moved to the desktop". Cron offset off the
 * minute boundary per the sweeper-family rationale (see
 * agent-run-sweeper) so it does not collide with the per-minute crons.
 *
 * The same tick runs the QUEUE SLA (`expireQueued`, self-build slice S):
 * a job no eligible runner took within its kind's max queued age is
 * failed with a stable reason so its run settles. Like reclaim it also
 * runs inline on the lease path, and like reclaim this cron is the only
 * path that reaches an owner whose every runner is offline — which is
 * exactly the fleet a job pinned to a closed laptop is waiting on.
 */
export const fleetJobLeaseSweeperTask = schedules.task({
    id: 'fleet-job-lease-sweeper',
    cron: '3/5 * * * *',
    run: async () => {
        // NOTE the third argument. `withWorkerContext` defaults to
        // `TriggerWorkerModule`, which does NOT register the
        // FleetJobService remote proxy — omitting it fails at runtime on
        // every fire, silently, forever.
        return withWorkerContext(
            'FleetJobLeaseSweeper',
            async (appContext) => {
                const svc = appContext.get(FleetJobService);
                // No userId: the cron sweep is global, unlike the
                // owner-scoped inline reclaim on the lease path.
                const summary = await svc.reclaimExpired();
                if (summary.requeued > 0 || summary.failed > 0) {
                    logger.warn('fleet-job-lease-sweeper reclaimed lapsed leases', {
                        requeued: summary.requeued,
                        failed: summary.failed,
                        scanned: summary.scanned,
                    });
                }
                // Global, like the reclaim above (no userId). The method
                // is on `FleetJobService`'s prototype, so the internal
                // RPC allow-list already admits it.
                const expiry = await svc.expireQueued();
                if (expiry.expired > 0) {
                    logger.warn('fleet-job-lease-sweeper failed queued jobs past their max age', {
                        expired: expiry.expired,
                        scanned: expiry.scanned,
                    });
                }
                return {
                    status: 'completed' as const,
                    ...summary,
                    queueScanned: expiry.scanned,
                    queueExpired: expiry.expired,
                };
            },
            TriggerInternalModule,
        );
    },
});
