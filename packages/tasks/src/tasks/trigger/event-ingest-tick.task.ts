import { logger, schedules } from '@trigger.dev/sdk';
import { EventIngestService, EventSourcePullService } from '@ever-works/agent/ingest';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Event-ingest spine (Wave 6, pull path Wave 8) — processor tick.
 *
 * Every 5 minutes:
 *
 *   1. PULL — `EventSourcePullService.pullSources()` sweeps every
 *      loaded event-source plugin for every user who enabled it,
 *      calling `pullEvents` with the persisted per-(user, plugin)
 *      watermark + continuation cursor (`ingest_cursors`) and landing
 *      the envelopes through the dedupe insert. A failed pull never
 *      blocks the drain below (and inside the pull, one broken
 *      source/user never stops the rest of the batch).
 *   2. DRAIN — `EventIngestService.processBatch()` fans a batch of
 *      unprocessed `ingested_events` rows out to the Activity log +
 *      best-effort Memory, each carrying `sourceUrl` provenance.
 *
 * Both real services live in the API (plugin registry, repositories,
 * ActivityLogService and the agent-memory facade are wired there); the
 * worker only calls them over the internal RPC channel — same shape as
 * the task-branch-gc / mission-tick crons.
 *
 * 5 minutes is deliberate: ingest is not latency-sensitive (feed +
 * Memory freshness, not user-facing request paths), rows that fail
 * their Activity write stay unprocessed and retry next tick, sweeps
 * that outrun the per-tick page budget resume from their cursor next
 * tick, and the batch caps keep each run bounded regardless of
 * connector volume.
 */
export const eventIngestTickTask = schedules.task({
    id: 'event-ingest-tick',
    cron: '*/5 * * * *',
    run: async () => {
        return withWorkerContext(
            'EventIngestTick',
            async (appContext) => {
                // 1. Pull event-source plugins → dedupe-insert. Best-effort:
                // a pull-path failure must never block draining rows that
                // already landed (webhook pushes, earlier pulls).
                let pull;
                try {
                    const pullSvc = appContext.get(EventSourcePullService);
                    pull = await pullSvc.pullSources();
                    if (pull.pulled > 0 || pull.errors > 0) {
                        logger.info('event-ingest-tick pulled event sources', { ...pull });
                    }
                } catch (error) {
                    logger.warn('event-ingest-tick source pull failed', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }

                // 2. Drain unprocessed rows through the processor fan-out.
                const svc = appContext.get(EventIngestService);
                const limit = Number(process.env.EVENT_INGEST_BATCH_LIMIT) || 50;
                const summary = await svc.processBatch(limit);
                if (summary.processed > 0 || summary.failed > 0) {
                    logger.info('event-ingest-tick drained ingested events', {
                        ...summary,
                        limit,
                    });
                }
                return { ...summary, pull };
            },
            TriggerInternalModule,
        );
    },
});
