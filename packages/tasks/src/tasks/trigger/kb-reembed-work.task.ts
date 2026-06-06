import { logger, task } from '@trigger.dev/sdk';
import { KbReembedWorkPayload } from '@ever-works/agent/tasks';
import { KnowledgeBaseReembedService } from '@ever-works/agent/services';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';

/**
 * EW-642 D7 — on-demand re-embed sweep for a single Work.
 *
 * Fired (NOT scheduled) when the platform detects that the embedding
 * model — or its dimensionality — has flipped for a Work and the
 * existing chunks need to be re-embedded against the new model so
 * retrieval doesn't run against a mixed vector space.
 *
 * The canonical dispatcher is the pgvector plugin's settings-change
 * hook (see the TODO marker left in
 * `packages/plugins/pgvector/src/pgvector.plugin.ts` — the wiring
 * lands in a small follow-up slice). Other vector-store plugins that
 * own their model setting are expected to dispatch the same payload
 * shape.
 *
 * Why on-demand and not a cron sweep? The trigger event ("embedding
 * model just flipped") is a deliberate operator action, and the
 * activity-log + workbench banner UX wants the sweep observable
 * from the moment of the flip — not on an undefined cron lag. A
 * companion reconciliation cron (slice 5) catches drift from missed
 * dispatch events.
 *
 * `maxDuration: 1800` — 30 minutes. KBs can be big and the embed
 * batch is one network round-trip per document. Concurrency is keyed
 * on `workId` via the dispatcher (the service serialises per-Work
 * inside one run already; cross-Work parallelism is bounded by the
 * default queue's concurrency limit).
 *
 * Retries: Trigger.dev's default exponential backoff. A transient
 * embedder 429 / 5xx gets retried; the service's `KB_REEMBED_FAILED`
 * activity event is the durable signal even when the underlying error
 * is recoverable.
 */
export const kbReembedWorkTask = task<'kb-reembed-work', KbReembedWorkPayload>({
    id: 'kb-reembed-work',
    maxDuration: 1800,
    run: async (payload) => {
        return withWorkerContext('KbReembedWork', async (appContext) => {
            await appContext.get(TriggerPluginHydratorService).initialize();
            const svc = appContext.get(KnowledgeBaseReembedService);
            logger.info('kb-reembed-work starting', {
                workId: payload.workId,
                previousModel: payload.previousModel,
                newModel: payload.newModel,
                newDims: payload.newDims,
            });
            const result = await svc.reembedWork(payload);
            return {
                status: 'completed' as const,
                workId: result.workId,
                documentsReembedded: result.documentsReembedded,
                documentsSkipped: result.documentsSkipped,
                chunksReembedded: result.chunksReembedded,
                fromModel: result.fromModel,
                toModel: result.toModel,
                durationMs: result.durationMs,
            };
        });
    },
});
