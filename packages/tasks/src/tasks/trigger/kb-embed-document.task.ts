import { logger, task } from '@trigger.dev/sdk';
import { KbEmbedDocumentPayload } from '@ever-works/agent/tasks';

/**
 * EW-641 Phase 2/a row 29b1 — async KB embedding task scaffold.
 *
 * Right now this is a placeholder that LOGS the payload and returns
 * `{ status: 'skipped', reason: 'embedder-not-wired' }`. Row 29b2 fills
 * in the real work:
 *   1. Hydrate plugins via `TriggerPluginHydratorService` (matches the
 *      kb-mirror-document task's bootstrap).
 *   2. Read the doc body via `KnowledgeBaseService.getDocument(workId,
 *      documentId, ...)`.
 *   3. `chunkMarkdown(body)` (row 28).
 *   4. Call the active AI provider's `createEmbedding(...)` (rows 26 +
 *      27) — or short-circuit + persist empty chunks if no embedder is
 *      configured (retrieval still works via lexical fallback in row
 *      30 RRF).
 *   5. `WorkKnowledgeChunkRepository.replaceForDocument(workId,
 *      documentId, chunks)` (row 29a) inside the existing worker
 *      context.
 *
 * Why scaffold first? The agent/tasks barrel test
 * (`packages/agent/src/tasks/tasks.spec.ts`) pins the runtime-symbol
 * count + identity of every dispatcher token. Landing the type +
 * dispatcher + a non-working task in one PR keeps that suite green
 * while making the dispatcher available to row 29c's service wiring.
 *
 * Idempotent: re-running the same payload will re-chunk + re-embed +
 * `replaceForDocument` over the existing chunks (delete-then-insert
 * via row 29a's repo). The Trigger.dev `concurrencyKey` keeps same-Work
 * runs serial; back-to-back saves still produce sensible final state.
 */
export const kbEmbedDocumentTask = task<'kb-embed-document', KbEmbedDocumentPayload>({
    id: 'kb-embed-document',
    // The body fetch + embedding call + chunk insert finish in seconds
    // for typical KB docs (low-hundreds chunks at most). 10-minute cap
    // is the same hard ceiling the kb-mirror-document task uses.
    maxDuration: 600,
    // Per-work serialization: a paragraph edited + saved twice quickly
    // would otherwise race two embed runs that both delete-then-insert.
    // The concurrency key keeps them strictly ordered for THIS workId
    // while letting other works run in parallel.
    queue: {
        name: 'kb-embed',
        concurrencyLimit: 4,
    },
    run: async (payload) => {
        logger.info('kb-embed-document scaffold invoked', {
            workId: payload.workId,
            documentId: payload.documentId,
        });

        // Row 29b2 will replace this with the real chunk + embed +
        // persist sequence. Until then we ack the run cleanly so the
        // service-side enqueue (row 29c) can be wired and tested
        // without triggering a "task implementation missing" failure
        // on every doc save.
        return {
            status: 'skipped',
            reason: 'embedder-not-wired',
            workId: payload.workId,
            documentId: payload.documentId,
        };
    },
});
