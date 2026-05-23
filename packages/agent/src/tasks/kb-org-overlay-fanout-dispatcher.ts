import type { KbOrgOverlayFanoutPayload } from './kb-org-overlay-fanout.types';

/**
 * EW-641 Phase 2/e row 37 — producer-side dispatcher interface
 * implemented by the Trigger.dev `TriggerService` (in
 * `packages/tasks/src/trigger/trigger.service.ts`).
 *
 * `KnowledgeBaseService` (row 37b, follow-up) calls
 * `dispatchKbOrgOverlayFanout(...)` from `createDocument` /
 * `updateDocument` / `deleteDocument` when the affected row is an
 * org-scope document (`workId === null && organizationId !== null`),
 * after resolving the target Work ids for the org.
 *
 * Returning `null` means the dispatcher could not enqueue (Trigger.dev
 * not configured, transport error). The KB service treats that as a
 * deferred sync: the org doc still persists, the overlay materialization
 * lags, and the Phase 3 reconciliation job (spec §9.6) eventually
 * catches Works that drift permanently.
 */
export interface KbOrgOverlayFanoutDispatcher {
    dispatchKbOrgOverlayFanout(payload: KbOrgOverlayFanoutPayload): Promise<string | null>;
}

export const KB_ORG_OVERLAY_FANOUT_DISPATCHER = Symbol('KB_ORG_OVERLAY_FANOUT_DISPATCHER');
