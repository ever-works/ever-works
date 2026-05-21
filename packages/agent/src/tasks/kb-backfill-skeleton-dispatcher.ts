import type { KbBackfillSkeletonPayload } from './kb-backfill-skeleton.types';

/**
 * Producer-side interface implemented by the Trigger.dev `TriggerService`.
 *
 * Called from admin endpoints / one-off bootstrap scripts when the
 * platform operator wants to populate the empty `.content/kb/`
 * skeleton for Works that pre-date the Knowledge Base feature.
 *
 * Returns the Trigger.dev run id (or `null` if Trigger.dev is not
 * configured — callers may then fall back to invoking the underlying
 * service synchronously).
 */
export interface KbBackfillSkeletonDispatcher {
    dispatchKbBackfillSkeleton(payload: KbBackfillSkeletonPayload): Promise<string | null>;
}

export const KB_BACKFILL_SKELETON_DISPATCHER = Symbol('KB_BACKFILL_SKELETON_DISPATCHER');
