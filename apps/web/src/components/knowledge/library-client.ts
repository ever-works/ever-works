import { browserApiFetch } from '@/lib/api/browser-api';
import {
    KNOWLEDGE_LIBRARY_BFF,
    type KbLibraryDocumentDto,
    type KbLibraryFileResultDto,
    type KbLibraryListDto,
    type KbLibraryListQuery,
    type KbLibraryTreeDto,
    type KbLibraryUnarchiveResultDto,
} from '@/lib/api/knowledge-library-types';

/**
 * Knowledge library — browser transport for the Library view and the
 * workbench shelf controls.
 *
 * Every call goes through `browserApiFetch`, never a bare `fetch`: the BFF
 * routes are workspace-scoped and answer 400 without the per-tab selector,
 * and a request that lost it would read another scope's shelf.
 */

/** A failed library request, carrying the API's status and error `code`. */
export class LibraryRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string | null,
        message: string,
    ) {
        super(message);
        this.name = 'LibraryRequestError';
    }
}

/** A shared folder as the folder routes return it. */
export interface SharedFolderRow {
    id: string;
    name: string;
    path: string;
    parentId: string | null;
}

async function toRequestError(res: Response): Promise<LibraryRequestError> {
    let code: string | null = null;
    let message = `HTTP ${res.status}`;
    try {
        const body = (await res.json()) as { code?: unknown; message?: unknown } | null;
        if (typeof body?.code === 'string') code = body.code;
        if (typeof body?.message === 'string') message = body.message;
        else if (Array.isArray(body?.message)) message = body.message.join(', ');
    } catch {
        // Non-JSON error body — keep the status-only message.
    }
    return new LibraryRequestError(res.status, code, message);
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await browserApiFetch(url, { cache: 'no-store', ...init, headers });
    if (!res.ok) throw await toRequestError(res);
    return (await res.json()) as T;
}

/** `attachment; filename="voice.md"` → `voice.md`, stripped of path characters. */
export function filenameFromDisposition(disposition: string | null, fallback: string): string {
    const match = disposition
        ? /filename\*?=(?:UTF-8'')?(?:"([^"]+)"|([^;\s]+))/i.exec(disposition)
        : null;
    const raw = match?.[1] ?? match?.[2];
    let name = fallback;
    if (raw) {
        try {
            name = decodeURIComponent(raw);
        } catch {
            name = raw;
        }
    }
    // Strip path separators and control characters from a header-supplied name.
    return name.replace(/[/\\?\x00-\x1f]/g, '_').slice(0, 255) || fallback;
}

export const knowledgeLibraryClient = {
    list(query: KbLibraryListQuery, signal?: AbortSignal): Promise<KbLibraryListDto> {
        return requestJson<KbLibraryListDto>(KNOWLEDGE_LIBRARY_BFF.library(query), { signal });
    },

    tree(signal?: AbortSignal): Promise<KbLibraryTreeDto> {
        return requestJson<KbLibraryTreeDto>(KNOWLEDGE_LIBRARY_BFF.tree, { signal });
    },

    getDocument(docId: string, signal?: AbortSignal): Promise<KbLibraryDocumentDto> {
        return requestJson<KbLibraryDocumentDto>(KNOWLEDGE_LIBRARY_BFF.document(docId), {
            signal,
        });
    },

    file(documentIds: string[], folderId: string | null): Promise<KbLibraryFileResultDto> {
        return requestJson<KbLibraryFileResultDto>(KNOWLEDGE_LIBRARY_BFF.file, {
            method: 'PATCH',
            body: JSON.stringify({ documentIds, folderId }),
        });
    },

    archive(docId: string): Promise<KbLibraryDocumentDto> {
        return requestJson<KbLibraryDocumentDto>(KNOWLEDGE_LIBRARY_BFF.archive(docId), {
            method: 'POST',
        });
    },

    unarchive(docId: string): Promise<KbLibraryUnarchiveResultDto> {
        return requestJson<KbLibraryUnarchiveResultDto>(KNOWLEDGE_LIBRARY_BFF.unarchive(docId), {
            method: 'POST',
        });
    },

    createFolder(name: string, parentId: string | null): Promise<SharedFolderRow> {
        const body: Record<string, string> = { name, scope: 'organization' };
        if (parentId) body.parentId = parentId;
        return requestJson<SharedFolderRow>(KNOWLEDGE_LIBRARY_BFF.createSharedFolder, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    renameFolder(folderId: string, name: string): Promise<SharedFolderRow> {
        return requestJson<SharedFolderRow>(KNOWLEDGE_LIBRARY_BFF.sharedFolder(folderId), {
            method: 'PATCH',
            body: JSON.stringify({ name }),
        });
    },

    deleteFolder(folderId: string): Promise<{ deletedFolders: number; unfiledDocuments: number }> {
        return requestJson(KNOWLEDGE_LIBRARY_BFF.sharedFolder(folderId), { method: 'DELETE' });
    },

    /**
     * Download one document as `<slug>.md`. Fetched (so the scope header
     * travels and a failure can be reported) and handed to the browser's
     * save dialog through a transient object URL.
     */
    async exportMarkdown(docId: string, fallbackName = 'document.md'): Promise<void> {
        const res = await browserApiFetch(KNOWLEDGE_LIBRARY_BFF.exportMarkdown(docId), {
            cache: 'no-store',
        });
        if (!res.ok) throw await toRequestError(res);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        try {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filenameFromDisposition(
                res.headers.get('content-disposition'),
                fallbackName,
            );
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } finally {
            // Let the browser start the download before revoking the blob URL.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    },
};

/** i18n leaf (under `dashboard.memoryPage.library`) for a failed folder write. */
export type FolderErrorKey =
    | 'folderDepthLimit'
    | 'folderNameDuplicate'
    | 'folderNameLength'
    | 'folderCycleRejected'
    | 'folderLimitReached'
    | 'noManageFolders'
    | 'folderFailed';

export function folderErrorKey(error: unknown): FolderErrorKey {
    if (!(error instanceof LibraryRequestError)) return 'folderFailed';
    switch (error.code) {
        case 'FolderDepthLimit':
            return 'folderDepthLimit';
        case 'FolderNameDuplicate':
            return 'folderNameDuplicate';
        case 'FolderCycle':
            return 'folderCycleRejected';
        case 'FolderLimitReached':
            return 'folderLimitReached';
        default:
            break;
    }
    if (error.status === 409) return 'folderNameDuplicate';
    if (error.status === 403) return 'noManageFolders';
    if (error.status === 400 && /name/i.test(error.message)) return 'folderNameLength';
    return 'folderFailed';
}
