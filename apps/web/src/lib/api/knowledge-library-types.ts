/**
 * Knowledge library — client-safe wire types, empty payloads and URL
 * builders for the organization shelf over the Knowledge Base.
 *
 * Kept `server-only`-FREE so the server component (`knowledge-library.ts`,
 * which wraps `serverFetch`) and the client panel (which calls the
 * same-origin BFF under `/api/knowledge`) share one definition. The DTOs are
 * the shared contracts, so the web and the API cannot drift on a field.
 */

import type {
    KbLibraryDocumentDto,
    KbLibraryFileResultDto,
    KbLibraryFolderNodeDto,
    KbLibraryListDto,
    KbLibraryListQuery,
    KbLibraryTreeDto,
    KbLibraryUnarchiveResultDto,
} from '@ever-works/contracts';

export type {
    KbLibraryDocumentDto,
    KbLibraryFileResultDto,
    KbLibraryFolderNodeDto,
    KbLibraryListDto,
    KbLibraryListQuery,
    KbLibraryTreeDto,
    KbLibraryUnarchiveResultDto,
};

/** The shelf of a session with no active Organization, or a failed read. */
export const EMPTY_LIBRARY_LIST: KbLibraryListDto = {
    documents: [],
    nextCursor: null,
    total: 0,
    unreadCount: 0,
};

/** The folder rail of a session with no active Organization, or a failed read. */
export const EMPTY_LIBRARY_TREE: KbLibraryTreeDto = {
    folders: [],
    unfiled: { documentCount: 0, hasUnread: false },
    documentCount: 0,
    archivedCount: 0,
    hasUnread: false,
    folderCount: 0,
    canManageFolders: false,
};

/** Server-rendered first paint of the Library view (`/memory?view=library`). */
export interface KnowledgeLibraryInitialData {
    list: KbLibraryListDto;
    tree: KbLibraryTreeDto;
    /** `true` when either read failed, so the panel can offer a retry. */
    loadFailed: boolean;
}

/**
 * Query string for `GET /api/knowledge/library`. Only set fields are
 * written, so an empty query yields `''` and the API applies its defaults
 * (archived excluded, sorted by the last substantive change, 50 per page).
 * Classes repeat (`?class=a&class=b`), which the API DTO accepts.
 */
export function buildLibraryQuery(query: KbLibraryListQuery = {}): string {
    const params = new URLSearchParams();
    if (query.folderId) params.set('folderId', query.folderId);
    if (query.archived) params.set('archived', query.archived);
    const q = query.q?.trim();
    if (q) params.set('q', q);
    for (const cls of query.classes ?? []) params.append('class', cls);
    if (query.workId) params.set('workId', query.workId);
    if (query.sort) params.set('sort', query.sort);
    if (typeof query.limit === 'number') params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}

/**
 * Same-origin BFF paths. Shared folders are written through the existing
 * folder surface (`/api/memory/files/folders`) with the organization scope —
 * there is one folder API, not a second one for the library.
 */
export const KNOWLEDGE_LIBRARY_BFF = {
    library: (query?: KbLibraryListQuery) => `/api/knowledge/library${buildLibraryQuery(query)}`,
    tree: '/api/knowledge/tree',
    document: (docId: string) => `/api/knowledge/documents/${encodeURIComponent(docId)}`,
    file: '/api/knowledge/documents/file',
    archive: (docId: string) => `/api/knowledge/documents/${encodeURIComponent(docId)}/archive`,
    unarchive: (docId: string) => `/api/knowledge/documents/${encodeURIComponent(docId)}/unarchive`,
    exportMarkdown: (docId: string) =>
        `/api/knowledge/documents/${encodeURIComponent(docId)}/export?format=md`,
    createSharedFolder: '/api/memory/files/folders',
    sharedFolder: (folderId: string) =>
        `/api/memory/files/folders/${encodeURIComponent(folderId)}?scope=organization`,
} as const;

/** One folder of the tree, flattened with its nesting depth (1-based). */
export interface FlatLibraryFolder {
    id: string;
    name: string;
    path: string;
    parentId: string | null;
    depth: number;
    documentCount: number;
    subtreeDocumentCount: number;
    hasChildren: boolean;
}

/** Depth-first flattening of the folder tree, parents before children. */
export function flattenLibraryFolders(nodes: KbLibraryFolderNodeDto[]): FlatLibraryFolder[] {
    const out: FlatLibraryFolder[] = [];
    const walk = (list: KbLibraryFolderNodeDto[]) => {
        for (const node of list) {
            out.push({
                id: node.id,
                name: node.name,
                path: node.path,
                parentId: node.parentId,
                depth: node.depth,
                documentCount: node.documentCount,
                subtreeDocumentCount: node.subtreeDocumentCount,
                hasChildren: node.children.length > 0,
            });
            walk(node.children);
        }
    };
    walk(nodes);
    return out;
}

/** `/Playbooks/Support` → `Playbooks / Support`; `null` stays `null`. */
export function formatFolderPath(path: string | null | undefined): string | null {
    if (!path) return null;
    const segments = path.split('/').filter(Boolean);
    return segments.length > 0 ? segments.join(' / ') : null;
}
