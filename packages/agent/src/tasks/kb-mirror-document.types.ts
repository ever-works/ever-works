/**
 * EW-641 Phase 1B/a — payload contract between `KnowledgeBaseService`
 * and the Trigger.dev `kb-mirror-document` task.
 *
 * The KB service emits one of these per Work-scoped document mutation
 * (create / update / delete). The task picks it up, clones the Work's
 * Git data repository, writes (or removes) the sidecar `.yml` + body
 * `.md` pair under `.content/kb/<class>/<slug>.{yml,md}`, regenerates
 * `.index.yml`, and pushes a single commit.
 *
 * Delete carries the resolved `path` + `class` because by the time the
 * task runs the DB row is already gone (hard delete) — the task can no
 * longer derive them from the document.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §9.4 (materialize)
 * + §7.2 (folder layout).
 */
export interface KbMirrorDocumentPayload {
    readonly workId: string;
    readonly operation: 'upsert' | 'delete';

    /**
     * UUID of the `work_knowledge_documents` row. Always set; on delete
     * the row no longer exists but the id is preserved for traceability
     * in logs / activity events.
     */
    readonly documentId: string;

    /**
     * Path within `.content/kb/` (e.g. `brand/voice.md`) — required on
     * delete (the DB row is gone) and supplied on upsert for sanity.
     */
    readonly path: string;

    /**
     * `kbDocumentClass` value (`brand`, `legal`, ...). Required on delete
     * for symmetry with `path`; the task does not re-query the DB.
     */
    readonly class: string;
}
