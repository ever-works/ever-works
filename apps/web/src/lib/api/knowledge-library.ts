import 'server-only';
import { serverFetch } from './server-api';
import {
    buildLibraryQuery,
    EMPTY_LIBRARY_LIST,
    EMPTY_LIBRARY_TREE,
    type KbLibraryDocumentDto,
    type KbLibraryListDto,
    type KbLibraryListQuery,
    type KbLibraryTreeDto,
} from './knowledge-library-types';

/**
 * Knowledge library — server-side client for `/api/knowledge`.
 *
 * Used by the Memory page's server component to pre-render the Library view
 * on a `?view=library` deep link. `serverFetch` forwards the tab's workspace
 * as the API scope header, so the Organization is resolved upstream and never
 * passed by id; a personal-scope render gets the API's empty shelf. The
 * client panel re-queries the same-origin BFF proxies for everything after
 * the first paint.
 */
export const knowledgeLibraryAPI = {
    /** `GET /api/knowledge/library` — one page of the shelf. */
    async list(query: KbLibraryListQuery = {}): Promise<KbLibraryListDto> {
        return serverFetch<KbLibraryListDto>(`/knowledge/library${buildLibraryQuery(query)}`, {
            method: 'GET',
        });
    },

    /** `GET /api/knowledge/tree` — the folder rail. */
    async tree(): Promise<KbLibraryTreeDto> {
        return serverFetch<KbLibraryTreeDto>('/knowledge/tree', { method: 'GET' });
    },

    /** `GET /api/knowledge/documents/:docId` — one document as a shelf row. */
    async getDocument(docId: string): Promise<KbLibraryDocumentDto> {
        return serverFetch<KbLibraryDocumentDto>(
            `/knowledge/documents/${encodeURIComponent(docId)}`,
            { method: 'GET' },
        );
    },
};

export { EMPTY_LIBRARY_LIST, EMPTY_LIBRARY_TREE };
export type { KbLibraryDocumentDto, KbLibraryListDto, KbLibraryListQuery, KbLibraryTreeDto };
