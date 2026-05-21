/**
 * EW-641 Phase 1B/a — payload contract between admin endpoints / one-off
 * scripts and the Trigger.dev `kb-backfill-skeleton` task.
 *
 * The task iterates the supplied Works (or every Work, if `workIds` is
 * omitted) and ensures each Work's data repo has a `.content/kb/`
 * skeleton with empty class folders + an empty `.index.yml`. Idempotent
 * and resumable — Works whose skeleton already exists are no-ops.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §18.2 (backfill for
 * existing Works) + acceptance criterion A1.
 */
export interface KbBackfillSkeletonPayload {
    /**
     * Optional whitelist of Work IDs to backfill. When omitted the task
     * iterates every Work the platform owns. Useful for re-running the
     * backfill against a single failed Work without redoing the whole
     * fleet.
     */
    readonly workIds?: readonly string[];
}
