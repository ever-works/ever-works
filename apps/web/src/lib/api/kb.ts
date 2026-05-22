import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    KbDocumentBodyDto,
    KbDocumentDto,
    KbDocumentListFilter,
    KbLockMode,
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
};
