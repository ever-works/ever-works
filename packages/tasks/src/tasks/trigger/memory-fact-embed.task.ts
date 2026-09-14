import { logger, task } from '@trigger.dev/sdk';
import { runMemoryFactEmbedJob, type MemoryFactEmbedPayload } from '@ever-works/agent/tasks';
import { MemoryFactEmbedService } from '@ever-works/agent/services';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
// Security: validate payload ids before they cross the RPC channel.
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

/**
 * AW-07 — embed one memory fact.
 *
 * Enqueued by `MemoryFactService` after a fact is created, its body is
 * edited, a forgotten fact is restored, or a proposal is accepted. The real
 * `MemoryFactEmbedService` lives in the API — the AI provider plugins that
 * embed and the vector-store plugins that hold the vector are loaded there —
 * so the worker only forwards `embedFact(factId)` over the internal RPC
 * channel, the same shape as `terminal-transcript-gc` and
 * `memory-consolidation-tick`.
 *
 * Idempotent: an already-embedded body is skipped and a vector upsert
 * replaces, so a retry or a double enqueue never spends twice or writes a
 * second vector.
 *
 * The queue bounds concurrency so a bulk import of facts cannot saturate the
 * runtime or the embedding provider's rate limit.
 *
 * "No provider / no vector store" is NOT a failure: the service returns an
 * `unavailable` outcome, the task acks, and the nightly `memory-fact-gc`
 * sweep embeds the fact once both exist. Retrying here would only burn
 * attempts against a configuration that has not changed.
 *
 * The job body is the runtime-neutral `runMemoryFactEmbedJob` from
 * `@ever-works/agent/tasks`; this file is only the Trigger.dev registration
 * of it. Other job-runtime providers register the same handler under
 * `MEMORY_FACT_EMBED_JOB_ID` with their own worker host. The id stays a
 * literal here (read at module load, where Trigger.dev indexes it);
 * `memory-fact-tasks.spec.ts` pins it equal to the shared constant.
 */
export const memoryFactEmbedTask = task<'memory-fact-embed', MemoryFactEmbedPayload>({
    id: 'memory-fact-embed',
    // One re-read, one embedding call, one vector upsert, one row update.
    maxDuration: 120,
    queue: {
        name: 'memory-fact-embed',
        concurrencyLimit: 4,
    },
    retry: {
        maxAttempts: 3,
    },
    run: async (payload) => {
        const factId = assertUuid(payload?.factId, 'payload.factId');
        return withWorkerContext(
            'MemoryFactEmbed',
            async (appContext) => {
                const svc = appContext.get(MemoryFactEmbedService);
                const outcome = await runMemoryFactEmbedJob(
                    { factId, userId: payload?.userId },
                    svc,
                );
                if (outcome.status === 'unavailable') {
                    logger.info('memory-fact-embed deferred to the sweep', { factId });
                }
                return outcome;
            },
            TriggerInternalModule,
        );
    },
});
