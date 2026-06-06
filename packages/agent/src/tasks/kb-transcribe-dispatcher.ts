import type { KbTranscribePayload } from './kb-transcribe.types';

/**
 * Producer-side interface for the `kb-transcribe` task. Implemented by
 * `TriggerService` in `packages/tasks/src/trigger/trigger.service.ts`.
 *
 * Returns the Trigger.dev run id, or `null` when Trigger.dev is
 * disabled / disposed / the dispatch threw. `null` is a soft failure:
 * the upload row stays in its current state and the Phase 3
 * reconciliation job (slice 5) catches drift.
 */
export interface KbTranscribeDispatcher {
    dispatchKbTranscribe(payload: KbTranscribePayload): Promise<string | null>;
}

export const KB_TRANSCRIBE_DISPATCHER = Symbol('KB_TRANSCRIBE_DISPATCHER');
