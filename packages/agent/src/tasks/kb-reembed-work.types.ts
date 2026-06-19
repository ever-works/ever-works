/**
 * EW-642 D7 — payload contract for the `kb-reembed-work` Trigger.dev
 * task.
 *
 * This task is dispatched on-demand (NOT cron-scheduled) when the
 * platform detects that the embedding model — or its dimensionality —
 * has flipped for a Work and the existing chunks need to be re-embedded
 * against the new model so retrieval doesn't run against a mixed
 * vector space.
 *
 * Typical dispatcher: a `pgvector` plugin settings-change hook (see
 * the TODO in `packages/plugins/pgvector/src/pgvector.plugin.ts`),
 * which fires `dispatchKbReembedWork({ workId, previousModel,
 * newModel, newDims })` after the operator flips `embeddingModel` in
 * the plugin's settings UI. The task itself is unconditional once
 * fired — idempotency lives in `KnowledgeBaseReembedService`, which
 * skips coordinates already on `newModel`.
 *
 * Spec: `docs/specs/features/knowledge-base/phase-2-vector-plugin-design.md` D7.
 */
export interface KbReembedWorkPayload {
    /** Work whose coordinate rows must be re-embedded. */
    readonly workId: string;
    /**
     * Model the coordinate rows currently report — used for logging /
     * activity event details so the operator can audit the flip. Not
     * load-bearing for the sweep itself (the service filters on `!=
     * newModel`, not `== previousModel`, so a partially-migrated Work
     * still finishes the migration in one run).
     */
    readonly previousModel: string;
    /** Model every coordinate row should end up on after the sweep. */
    readonly newModel: string;
    /**
     * Vector dimension associated with `newModel`. Persisted on each
     * updated coordinate row alongside the new `embedding_model` so
     * `(vector_store_id, embedding_model, embedding_dims)` stay
     * mutually consistent (a same-name model that bumps default dims
     * is still detected by a future sweep).
     */
    readonly newDims: number;

    /**
     * EW-742 P3.2 T22 — enqueue-site tenant-runtime binding capture.
     * See `KbEmbedDocumentPayload` (the PoC dispatcher) for the full
     * contract; the same null/null fail-open semantics apply.
     */
    readonly providerId?: string | null;
    readonly credentialVersion?: number | null;
}
