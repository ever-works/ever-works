import type { KbEmbedDocumentPayload } from './kb-embed-document.types';

/**
 * Producer-side interface implemented by the Trigger.dev `TriggerService`
 * (in `packages/tasks/src/trigger/trigger.service.ts`).
 *
 * `KnowledgeBaseService` will call `dispatchKbEmbedDocument(...)` after
 * every Work-scoped text-document mutation once row 29c wires the
 * enqueue. The task (row 29b2) re-fetches the doc body, chunks, embeds,
 * and persists via `WorkKnowledgeChunkRepository.replaceForDocument`
 * (row 29a).
 *
 * Returning `null` means the dispatcher could not enqueue (Trigger.dev
 * not configured, transport error). The KB service should treat `null`
 * as a deferred embed: chunks remain stale, retrieval still falls back
 * to lexical search (row 30 RRF fuses lexical + semantic and weights
 * gracefully when semantic returns empty). The Phase 3 reconciliation
 * job will eventually catch docs whose `lastEmbeddedAt` falls behind.
 *
 * Mirrors `KbMirrorDocumentDispatcher` (row 1B/a). Same shape so consumers
 * (`KnowledgeBaseService`, tests) recognise the pattern at a glance.
 */
export interface KbEmbedDocumentDispatcher {
    dispatchKbEmbedDocument(payload: KbEmbedDocumentPayload): Promise<string | null>;
}

export const KB_EMBED_DOCUMENT_DISPATCHER = Symbol('KB_EMBED_DOCUMENT_DISPATCHER');
