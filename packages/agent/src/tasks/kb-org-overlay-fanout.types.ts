/**
 * EW-641 Phase 2/e row 37 — payload contract for the Trigger.dev
 * `kb-org-overlay-fanout` task.
 *
 * When an org-scope KB document (`organizationId !== null`,
 * `workId === null`) is created / updated / deleted, this task
 * fans the materialization out across every target Work in the
 * org: each target Work's data repo gets the doc written under
 * `.content/kb/.org/<class>/<slug>.{yml,md}` (or those files
 * removed on a `delete`).
 *
 * The platform spec §7.6 places the overlay under a `.org/` first
 * segment so a Work owner can always tell which docs are inherited
 * from the org vs which they own locally — they live in distinct
 * directories on disk.
 *
 * **`workIds` is supplied by the caller**, not computed inside the
 * task. The row-37b enqueue site (in `KnowledgeBaseService.{create,
 * update,delete}Document` for org-scope docs) resolves the target
 * list from the organization → works membership before dispatching.
 * Keeping that lookup outside the task keeps the worker free of DB
 * pagination logic + makes it trivially testable with a fixed
 * `workIds` array.
 *
 * **`organizationId`** scopes the org doc lookup inside each Work's
 * materialization step. The task verifies the doc still belongs to
 * the org before writing — guards against a race where the org doc
 * is moved to a different org or hard-deleted between enqueue and
 * run.
 */
export interface KbOrgOverlayFanoutPayload {
    /** Org owning the doc. Used for the `findOrgById` lookup. */
    readonly organizationId: string;

    /** UUID of the org-scope `work_knowledge_documents` row. On
     *  delete the row is gone — `path` + `class` carry the
     *  resolution forward (mirrors the row 1B/a `kb-mirror-document`
     *  task's delete contract). */
    readonly documentId: string;

    /** Target Works (already resolved by the enqueue site) to which
     *  the org overlay must be materialized. Resolved server-side
     *  per the org → works membership table. */
    readonly workIds: ReadonlyArray<string>;

    /** Whether to upsert the overlay files or remove them. */
    readonly operation: 'upsert' | 'delete';

    /** Path within `.content/kb/` (e.g. `brand/voice.md`) — required
     *  on delete (the DB row is gone) and supplied on upsert for
     *  sanity. Mirrors the row 1B/a per-Work mirror task's contract. */
    readonly path: string;

    /** `kbDocumentClass` value (`brand`, `legal`, ...). Required on
     *  delete for symmetry with `path`. */
    readonly class: string;
}
