import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    KbDocumentBodyDto,
    KbDocumentDto,
    KbDocumentHistoryResult,
    KbDocumentListFilter,
    KbLockMode,
    KbUploadDto,
    UpdateKbDocumentInput,
} from '@ever-works/contracts';

/**
 * EW-641 Phase 1B/d row 3 — server-only fetch helpers for the Knowledge
 * Base REST surface shipped in Phase 1A (`apps/api/src/works/kb.controller.ts`).
 *
 * The agent service returns `{ items, total }` — no cursor. We re-use
 * the contracts' `KbDocumentDto` shape for the items; `total` is the
 * full filtered count so the UI can show "N documents" headers.
 */
export interface KbDocumentListResponse {
    items: KbDocumentDto[];
    total: number;
}

export const kbAPI = {
    /**
     * `GET /api/works/:id/kb/documents` — paginated metadata list.
     *
     * Tree-panel callers can leave `opts` empty; filtering is applied
     * server-side and the response is small (metadata-only, no body).
     */
    listDocuments: async (
        workId: string,
        opts: KbDocumentListFilter = {},
    ): Promise<KbDocumentListResponse> => {
        const params = new URLSearchParams();
        if (opts.class && !Array.isArray(opts.class)) params.append('class', opts.class);
        if (opts.status && !Array.isArray(opts.status)) params.append('status', opts.status);
        if (opts.tag && !Array.isArray(opts.tag)) params.append('tag', opts.tag);
        if (typeof opts.locked === 'boolean') params.append('locked', String(opts.locked));
        if (opts.language) params.append('language', opts.language);
        if (opts.q) params.append('q', opts.q);
        if (typeof opts.limit === 'number') params.append('limit', String(opts.limit));
        if (opts.cursor) params.append('offset', opts.cursor);
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<KbDocumentListResponse>(`/works/${workId}/kb/documents${query}`);
    },

    /**
     * `GET /api/works/:id/kb/inheritable?orgId=<id>` — resolve the merged
     * set of org-level + Work-override inheritable documents for the
     * legal/style/seo classes (see `apps/api/src/works/org-kb.controller.ts`
     * `resolveInheritable` → `KnowledgeBaseService.resolveInheritableDocuments`).
     *
     * EW-641 Phase 2/e row 38b — the KB page calls this in parallel with
     * `listDocuments` and hands the result to
     * `<KbTreePanel inheritedDocuments={...} />` (row 38a) so the
     * "Inherited from organization" section actually populates.
     *
     * Returns `[]` (no fetch) when `orgId` is null/empty — saves a
     * round-trip for Works whose `organizationId` column (row 37c)
     * hasn't been populated yet. The `orgId` value is URL-encoded so
     * opaque UUIDs survive the query string unchanged. The controller
     * already accepts a falsy `orgId` and short-circuits to `[]`, but
     * skipping the fetch on the client side keeps the network panel
     * and audit log cleaner.
     */
    listInheritableDocuments: async (
        workId: string,
        orgId: string | null | undefined,
    ): Promise<KbDocumentDto[]> => {
        if (!orgId) {
            return [];
        }
        return serverFetch<KbDocumentDto[]>(
            `/works/${workId}/kb/inheritable?orgId=${encodeURIComponent(orgId)}`,
        );
    },

    /**
     * `GET /api/works/:id/kb/documents/:idOrPath` — full document with
     * Markdown body + asset summaries. The backend accepts either a
     * UUID or the canonical `<class>/<slug>.md`-style path; we encode
     * the path so embedded slashes survive the fetch (the API decodes
     * the segment before lookup).
     */
    getDocument: async (workId: string, idOrPath: string): Promise<KbDocumentBodyDto> => {
        return serverFetch<KbDocumentBodyDto>(
            `/works/${workId}/kb/documents/${encodeURIComponent(idOrPath)}`,
        );
    },

    /**
     * `PATCH /api/works/:id/kb/documents/:docId` — partial update.
     *
     * The backend accepts `{ title?, description?, body?, tags?,
     * categories?, language?, status? }`. The editor in row 5 only
     * sends `body`, but the helper is shaped for the broader
     * `UpdateKbDocumentInput` surface so the side-panel (row 13) can
     * reuse it.
     */
    updateDocument: async (
        workId: string,
        docId: string,
        input: UpdateKbDocumentInput,
    ): Promise<KbDocumentBodyDto> => {
        return serverMutation<KbDocumentBodyDto>({
            endpoint: `/works/${workId}/kb/documents/${encodeURIComponent(docId)}`,
            data: input,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    /**
     * `POST /api/works/:id/kb/documents/:docId/lock` — lock the document
     * in the requested mode. `full` blocks all body mutations; the
     * `additions-only` mode lets the API enforce diff-merge semantics
     * (additions OK, deletions/edits rejected). Returns the updated
     * document so the UI can reflect the new lock state without a
     * separate fetch.
     */
    lockDocument: async (
        workId: string,
        docId: string,
        mode: KbLockMode,
    ): Promise<KbDocumentDto> => {
        return serverMutation<KbDocumentDto>({
            endpoint: `/works/${workId}/kb/documents/${encodeURIComponent(docId)}/lock`,
            data: { mode },
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * `POST /api/works/:id/kb/documents/:docId/unlock` — clear the
     * lock. No-op + 200 if the doc is already unlocked.
     */
    unlockDocument: async (workId: string, docId: string): Promise<KbDocumentDto> => {
        return serverMutation<KbDocumentDto>({
            endpoint: `/works/${workId}/kb/documents/${encodeURIComponent(docId)}/unlock`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /**
     * `GET /api/works/:id/kb/uploads/:uploadId` — read a single upload
     * row (metadata only; the persisted bytes live behind the row-21a
     * `/download` route). The doc detail page calls this when the doc
     * has a `sourceUploadId` so the viewer dispatcher (row 21b) can
     * decide whether to mount `KbPdfViewer` / `KbXlsxViewer` /
     * `KbDocxViewer` / image / video / audio based on `upload.mimeType`.
     *
     * Errors propagate as `ApiResponseError` — callers may catch 404 to
     * fall back to the markdown viewer when the upload reference is
     * orphaned.
     */
    getUpload: async (workId: string, uploadId: string): Promise<KbUploadDto> => {
        return serverFetch<KbUploadDto>(
            `/works/${workId}/kb/uploads/${encodeURIComponent(uploadId)}`,
        );
    },

    /**
     * `GET /api/works/:id/kb/documents/:docId/history?limit=N` — list
     * Git commits that touched the doc's sidecar `.md`. Returns
     * `{ items: KbDocumentCommitDto[] }`. Backend (row 18a, PR #943)
     * stubs to `[]` until row 18b lands the real git-log walk; the
     * dialog handles the empty case via its own empty-state copy.
     */
    getDocumentHistory: async (
        workId: string,
        docId: string,
        opts: { limit?: number } = {},
    ): Promise<KbDocumentHistoryResult> => {
        const params = new URLSearchParams();
        if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<KbDocumentHistoryResult>(
            `/works/${workId}/kb/documents/${encodeURIComponent(docId)}/history${query}`,
        );
    },

    /**
     * `POST /api/works/:id/kb/documents/:docId/restore` — restore the
     * doc body to the supplied commit SHA. Already wired in Phase 1A
     * (controller endpoint exists since `restoreDocumentFromHistory`
     * landed with the original mirror service); row 18c just exposes
     * it via the same `kbAPI` surface the dialog uses.
     */
    restoreDocument: async (
        workId: string,
        docId: string,
        commitSha: string,
    ): Promise<KbDocumentBodyDto> => {
        return serverMutation<KbDocumentBodyDto>({
            endpoint: `/works/${workId}/kb/documents/${encodeURIComponent(docId)}/restore`,
            data: { commitSha },
            method: 'POST',
            wrapInData: false,
        });
    },
};
