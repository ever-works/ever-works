import type { MemoryFactEmbedPayload } from './memory-fact-embed.types';

/**
 * Producer-side seam for embedding one memory fact (AW-07).
 *
 * `MemoryFactService` enqueues through this after a fact is created, its
 * body is edited, or a proposal is accepted. The consumer embeds the
 * CURRENT body through the AI facade and writes the vector through the
 * vector-store capability, then records the coordinates on the fact row.
 * Running it twice for the same fact is a no-op: an already-embedded body is
 * skipped, and an upsert replaces rather than appends.
 *
 * Implemented by the job-runtime adapter in
 * `packages/tasks/src/dispatchers/memory-fact-embed.dispatcher.ts` and bound
 * API-side, so `@ever-works/agent` never takes a runtime SDK dependency.
 *
 * ## Returning `null`
 *
 * `null` means the embed could not be enqueued — no job runtime configured
 * (the ordinary case in dev and e2e) or a transport failure. The fact STAYS
 * UNEMBEDDED: it is saved, it is listed, literal search still finds it, and
 * the nightly `memory-fact-gc` sweep embeds it once a runtime and a provider
 * are both available. A missing job runtime must never make a fact
 * un-saveable, so callers treat `null` as deferred work, never as an error.
 */
export interface MemoryFactEmbedDispatcher {
    dispatchMemoryFactEmbed(payload: MemoryFactEmbedPayload): Promise<string | null>;
}

export const MEMORY_FACT_EMBED_DISPATCHER = Symbol('MEMORY_FACT_EMBED_DISPATCHER');
