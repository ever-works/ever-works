import type { KbReembedWorkPayload } from './kb-reembed-work.types';

/**
 * Producer-side interface for the `kb-reembed-work` Trigger.dev task.
 * Implemented by `TriggerService` (or an inline `useFactory` in
 * `apps/api/src/works/works.module.ts`) — same wiring pattern the
 * EW-643 Phase 3 slice 2c `KbTranscribeDispatcher` /
 * `KbNormalizeMediaDispatcher` use.
 *
 * Returns the Trigger.dev run id on a successful dispatch. Unlike the
 * KB media dispatchers (which return `string | null` and treat a null
 * as a soft failure the reconciliation job catches), the re-embed
 * sweep MUST be observable end-to-end — a silent drop would leave a
 * Work permanently on the old embedding model with no operator signal.
 * Callers therefore propagate dispatch errors instead of swallowing
 * them.
 */
export interface KbReembedWorkDispatcher {
    dispatchKbReembedWork(payload: KbReembedWorkPayload): Promise<string>;
}

export const KB_REEMBED_WORK_DISPATCHER = Symbol('KB_REEMBED_WORK_DISPATCHER');
