import type { KbMirrorDocumentPayload } from './kb-mirror-document.types';

/**
 * Producer-side interface implemented by the Trigger.dev `TriggerService`
 * (in `packages/tasks/src/trigger/trigger.service.ts`).
 *
 * `KnowledgeBaseService` calls `dispatchKbMirrorDocument(...)` after
 * every Work-scoped document mutation (create / update / delete) so the
 * sidecar `.yml` + body `.md` pair in the Work's Git data repo stays
 * in sync with the DB.
 *
 * Returning `null` means the dispatcher could not enqueue (Trigger.dev
 * not configured, transport error). The KB service treats `null` as a
 * deferred sync: the document row still persists, `lastCommitSha`
 * remains stale, and the next successful mutation re-enqueues. The
 * Phase 3 reconciliation job (`docs/specs/features/knowledge-base/`
 * §9.6) is what eventually catches Works that drift permanently.
 */
export interface KbMirrorDocumentDispatcher {
    dispatchKbMirrorDocument(payload: KbMirrorDocumentPayload): Promise<string | null>;
}

export const KB_MIRROR_DOCUMENT_DISPATCHER = Symbol('KB_MIRROR_DOCUMENT_DISPATCHER');
