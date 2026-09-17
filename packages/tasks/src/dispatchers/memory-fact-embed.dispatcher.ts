import { Logger } from '@nestjs/common';
import { tasks } from '@trigger.dev/sdk';
import type { MemoryFactEmbedDispatcher, MemoryFactEmbedPayload } from '@ever-works/agent/tasks';

/**
 * A Nest logger, NOT `logger` from `@trigger.dev/sdk`: this adapter only ever
 * runs in the API process, where the SDK's run-scoped logger discards every
 * call (see `workflow-run.dispatcher.ts` for the incident that taught this).
 */
const logger = new Logger('MemoryFactEmbedDispatcher');

/**
 * AW-07 — production dispatcher adapter that hands one memory fact to the
 * `memory-fact-embed` task.
 *
 * Bound to `MEMORY_FACT_EMBED_DISPATCHER` by the API-side
 * `MemoryFactsApiModule`, which keeps the runtime SDK out of the
 * `@ever-works/agent` dependency graph — the same shape as
 * `workflowRunTriggerAdapter`.
 *
 * ## No idempotency key, deliberately
 *
 * The unit of work is "embed whatever this fact's body is NOW", not "embed
 * this fact once". Keying on the fact id would collapse the embed an edit
 * enqueues into the one its creation enqueued, leaving the edited fact
 * matched by words until the nightly sweep. The task itself is idempotent —
 * an already-embedded body is skipped and an upsert replaces — so a double
 * enqueue costs a no-op, never a duplicate vector.
 *
 * ## Returning `null`
 *
 * Errors are logged and reported as `null`, matching the dispatcher
 * contract: the fact is already saved, and the sweep embeds it later. An
 * unconfigured install (dev, e2e) takes the same path.
 */
export const memoryFactEmbedTriggerAdapter: MemoryFactEmbedDispatcher = {
    async dispatchMemoryFactEmbed(payload: MemoryFactEmbedPayload): Promise<string | null> {
        try {
            const handle = await tasks.trigger<
                typeof import('../tasks/trigger/memory-fact-embed.task').memoryFactEmbedTask
            >('memory-fact-embed', {
                factId: payload.factId,
                userId: payload.userId,
            } satisfies MemoryFactEmbedPayload);
            return handle.id;
        } catch (err) {
            logger.warn(
                `memory-fact-embed dispatch failed (factId=${payload.factId}): ` +
                    (err instanceof Error ? err.message : String(err)),
            );
            return null;
        }
    },
};
