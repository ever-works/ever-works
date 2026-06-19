/**
 * EW-641 Phase 2/a row 29b — payload contract between `KnowledgeBaseService`
 * and the Trigger.dev `kb-embed-document` task.
 *
 * The KB service emits one of these after every text-document mutation
 * (create / update) once embedding is wired (row 29c). The task fetches
 * the doc body, chunks it via `chunkMarkdown` (row 28), embeds each
 * chunk against the operator-pinned AI provider, and persists via the
 * `WorkKnowledgeChunkRepository.replaceForDocument` repo (row 29a).
 *
 * No `delete` operation here: chunk rows are removed by the
 * `onDelete: 'CASCADE'` foreign key on `(document_id)` — when
 * `KnowledgeBaseService.deleteDocument` drops the document row, every
 * chunk owned by it disappears with it in the same transaction. The
 * task only handles upserts.
 *
 * **Why `{ workId, documentId }` and nothing else?** The task is a
 * read-from-DB worker: it fetches the document body, the active AI
 * provider settings, and the chunk repo all via Nest DI at run time.
 * Stuffing the body or settings into the payload would make the queue
 * messages large + stale (Trigger.dev retries replay the original
 * payload — a body diff between enqueue and run would be silently
 * lost). The two ids are enough to re-derive everything fresh.
 *
 * Spec: docs/specs/features/knowledge-base/spec.md §15.2 (chunking) +
 * §15.3 (embedding) + §15.5 (retrieval, downstream consumer).
 */
export interface KbEmbedDocumentPayload {
    readonly workId: string;
    /** UUID of the `work_knowledge_documents` row whose body to (re)embed. */
    readonly documentId: string;

    /**
     * EW-742 P3.2 T22 — enqueue-site tenant-runtime binding capture
     * (PoC; KB-embed is the proof-of-concept dispatcher, the other 11
     * `*_DISPATCHER` symbols adopt the same pair incrementally — see
     * {@link RuntimeBindingStamperService} JSDoc "Scope of THIS PR"
     * note).
     *
     * When present, identifies the tenant-overlay job-runtime that was
     * active at enqueue time. The worker host uses these to resolve
     * THAT exact credential snapshot via
     * {@link CredentialVersionService.resolveSnapshot} even if the
     * tenant rotates the overlay mid-run (ADR-017 §3 graceful drain).
     *
     * Both fields are absent when:
     *   - the KnowledgeBaseService doesn't have RuntimeBindingStamperService
     *     wired (older deployments, isolated unit tests);
     *   - the Work has no tenant context (pre-EW-655 row);
     *   - the tenant has no overlay row, or it's `inherit` / disabled.
     *
     * In every "absent" case the worker host MUST fall back to the
     * instance default (the pre-overlay EW-683 path) — same byte-for-byte
     * code path that existed before T22.
     */
    readonly providerId?: string | null;
    readonly credentialVersion?: number | null;
}
