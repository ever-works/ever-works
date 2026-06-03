import type { KbNormalizeMediaPayload } from './kb-normalize-media.types';

/**
 * Producer-side interface implemented by `TriggerService` in
 * `packages/tasks/src/trigger/trigger.service.ts`. `KnowledgeBaseService`
 * calls `dispatchKbNormalizeMedia(...)` from the upload acceptance path
 * for any audio/* or video/* family upload, when `KB_MEDIA_NORMALIZE`
 * is enabled.
 *
 * Returning `null` means Trigger.dev is disabled or the dispatch threw.
 * The KB service handles `null` by marking the upload `extractionStatus
 * = 'SKIPPED'` with `extractionError = 'media normalization disabled'`
 * — same shape as the existing extract-step graceful skip so consumers
 * (workbench, reconcile job) don't need a new code path.
 */
export interface KbNormalizeMediaDispatcher {
    dispatchKbNormalizeMedia(payload: KbNormalizeMediaPayload): Promise<string | null>;
}

export const KB_NORMALIZE_MEDIA_DISPATCHER = Symbol('KB_NORMALIZE_MEDIA_DISPATCHER');
