/**
 * EW-628 Phase 8 — canonical telemetry counter / histogram names for
 * the data-repo instant-sync surface.
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` §8.
 *
 * Naming is locked here so every emitter (webhook handler, dispatcher
 * task, DataSyncService, force-sync controller) uses the same labels
 * the PostHog / Sentry dashboards will pivot on. Counter names live as
 * string constants — readable in logs, greppable across the codebase,
 * and impossible to typo at call sites that import them.
 *
 * The wire-up of these counters into `packages/monitoring`
 * (PostHog/Sentry) lands in the Phase 8 follow-up alongside the runtime
 * gate logic for `runDataSync` — the names ship first so dependent
 * phases can import them without a forward declaration.
 */

export const DATA_SYNC_METRICS = {
    /** Successful sync runs. Labels: {source}. */
    successTotal: 'data_sync_success_total',
    /** Skipped sync attempts (any gate reason). Labels: {reason, source}. */
    skippedTotal: 'data_sync_skipped_total',
    /** Failed sync runs (render or push exception). Labels: {errorClass, source}. */
    failedTotal: 'data_sync_failed_total',
    /** Wall-clock duration of a successful sync run in ms. Histogram. */
    durationMs: 'data_sync_duration_ms',
    /** Lock contention — runExclusive returned acquired:false. No labels. */
    lockContentionTotal: 'data_sync_lock_contention_total',
} as const;

export type DataSyncMetricName = (typeof DATA_SYNC_METRICS)[keyof typeof DATA_SYNC_METRICS];

/** All five metric names — useful for dashboard validation tests. */
export const DATA_SYNC_METRIC_NAMES: readonly DataSyncMetricName[] = Object.freeze(
    Object.values(DATA_SYNC_METRICS),
);
