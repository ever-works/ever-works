import { logger, schedules } from '@trigger.dev/sdk';
import { EventIngestService } from '@ever-works/agent/ingest';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Event-ingest spine (Wave 6) — processor tick.
 *
 * Every 5 minutes, drain a batch of unprocessed `ingested_events`
 * rows through the fan-out (Activity log + best-effort Memory, each
 * carrying `sourceUrl` provenance). The real `EventIngestService`
 * lives in the API (repositories + ActivityLogService + the
 * agent-memory facade are wired there); the worker only calls
 * `processBatch()` over the internal RPC channel — same shape as the
 * task-branch-gc / mission-tick crons.
 *
 * 5 minutes is deliberate: ingest is not latency-sensitive (feed +
 * Memory freshness, not user-facing request paths), rows that fail
 * their Activity write stay unprocessed and retry next tick, and the
 * batch cap keeps each run bounded regardless of connector volume.
 */
export const eventIngestTickTask = schedules.task({
    id: 'event-ingest-tick',
    cron: '*/5 * * * *',
    run: async () => {
        return withWorkerContext(
            'EventIngestTick',
            async (appContext) => {
                const svc = appContext.get(EventIngestService);
                const limit = Number(process.env.EVENT_INGEST_BATCH_LIMIT) || 50;
                const summary = await svc.processBatch(limit);
                if (summary.processed > 0 || summary.failed > 0) {
                    logger.info('event-ingest-tick drained ingested events', {
                        ...summary,
                        limit,
                    });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
