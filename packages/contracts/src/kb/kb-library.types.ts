/**
 * Knowledge library — the reading and curation layer over the Knowledge
 * Base: one organization-wide shelf of documents, shared folders, archive
 * and restore, and a single-document Markdown export.
 *
 * Wire types and limits live here so Web, API and CLI agree on one set of
 * numbers. The agent package owns the runtime behaviour; nothing in this
 * file is persisted on its own.
 */

import type { KbDocumentDto } from './kb-document.types.js';
import type { KbDocumentClass } from './kb-document-class.js';

// ─── Limits ────────────────────────────────────────────────────────────────

/** Default page size of the library list. */
export const KB_LIBRARY_PAGE_SIZE_DEFAULT = 50;

/** Largest page size the library list accepts. */
export const KB_LIBRARY_PAGE_SIZE_MAX = 200;

/** Shared folders nest at most this many levels deep. */
export const KB_LIBRARY_FOLDER_MAX_DEPTH = 5;

/** Longest shared-folder name, in characters. */
export const KB_LIBRARY_FOLDER_NAME_MAX = 120;

/** Most shared folders one Organization may hold. */
export const KB_LIBRARY_FOLDERS_MAX_PER_ORG = 500;

/** Most documents one person may pin. */
export const KB_LIBRARY_PINS_MAX_PER_USER = 20;

/** Most documents one filing action may move. */
export const KB_LIBRARY_FILE_BATCH_MAX = 100;

/** How long a document body must stay on screen before it counts as read. */
export const KB_LIBRARY_READ_DWELL_MS = 2000;

/** Longest a per-person unread rollup may be served from cache. */
export const KB_LIBRARY_ROLLUP_CACHE_MS = 30_000;

/** Most documents the `#` reference picker returns. */
export const KB_REFERENCE_PICKER_LIMIT = 8;

/** Debounce applied to the `#` reference picker's query. */
export const KB_REFERENCE_PICKER_DEBOUNCE_MS = 150;

/** Most referenced documents injected into one message. */
export const KB_REFERENCE_MAX_PER_MESSAGE = 5;

/** Token budget shared by the explicit references of one message. */
export const KB_REFERENCE_TOKEN_BUDGET = 6000;

/** Largest export delivered synchronously; bigger exports run in the background. */
export const KB_EXPORT_SYNC_MAX_DOCS = 25;

/** Most documents one export may include. */
export const KB_EXPORT_MAX_DOCS = 2000;

/** Largest archive one export may produce. */
export const KB_EXPORT_MAX_BYTES = 200 * 1024 * 1024;

/** How long a background export's download link stays valid. */
export const KB_EXPORT_LINK_TTL_HOURS = 24;

/** Most characters the free-text library search accepts. */
export const KB_LIBRARY_QUERY_MAX = 128;

// ─── Enumerations ──────────────────────────────────────────────────────────

/** Per-person read state of one document. */
export const KB_READ_STATES = ['new', 'updated', 'read'] as const;
export type KbReadState = (typeof KB_READ_STATES)[number];

/** Library list orderings. `recent` sorts by the last substantive change. */
export const KB_LIBRARY_SORTS = ['recent', 'title', 'unread'] as const;
export type KbLibrarySort = (typeof KB_LIBRARY_SORTS)[number];

/** Whether archived documents are left out, shown alone, or mixed in. */
export const KB_LIBRARY_ARCHIVED_FILTERS = ['exclude', 'only', 'include'] as const;
export type KbLibraryArchivedFilter = (typeof KB_LIBRARY_ARCHIVED_FILTERS)[number];

/** Folder filter value that selects documents in no folder. */
export const KB_LIBRARY_UNFILED = 'unfiled';

/** Export formats. Markdown ships first; PDF needs a rendering plugin. */
export const KB_EXPORT_FORMATS = ['md', 'pdf'] as const;
export type KbExportFormat = (typeof KB_EXPORT_FORMATS)[number];

// ─── Wire types ────────────────────────────────────────────────────────────

/** One row of the library list. */
export interface KbLibraryDocumentDto extends KbDocumentDto {
	/** Shared folder the document is filed in; `null` = Unfiled. */
	folderId: string | null;
	/** Materialized folder path (`/Playbooks/Support`); `null` when unfiled. */
	folderPath: string | null;
	/** Display name of the Work the document belongs to; `null` for organization documents. */
	workName: string | null;
	/** Substantive-change counter; starts at 1. */
	revision: number;
	/** When `revision` last moved. Bookkeeping writes never move it. */
	revisionAt: string | null;
	archivedAt: string | null;
	archivedById: string | null;
	/** Per-person read state. */
	readState: KbReadState;
	/** Non-null when the caller pinned the document. */
	pinnedAt: string | null;
	/** Whether the caller may file, archive or restore the document. */
	canEdit: boolean;
}

/** Cursor-paginated library page. */
export interface KbLibraryListDto {
	documents: KbLibraryDocumentDto[];
	/** Opaque cursor for the next page; `null` on the last page. */
	nextCursor: string | null;
	/** Rows matching the filters, across every page. */
	total: number;
	/** Exact library-wide unread count for the header. */
	unreadCount: number;
}

/** One shared folder in the library tree. */
export interface KbLibraryFolderNodeDto {
	id: string;
	name: string;
	/** Materialized path, e.g. `/Playbooks/Support`. */
	path: string;
	parentId: string | null;
	/** 1 for a top-level folder, up to `KB_LIBRARY_FOLDER_MAX_DEPTH`. */
	depth: number;
	/** Non-archived documents filed directly in this folder. */
	documentCount: number;
	/** Non-archived documents anywhere in this folder's subtree. */
	subtreeDocumentCount: number;
	/** True when something in the subtree is unread for the caller. */
	hasUnread: boolean;
	children: KbLibraryFolderNodeDto[];
}

/** The library folder rail. */
export interface KbLibraryTreeDto {
	folders: KbLibraryFolderNodeDto[];
	unfiled: { documentCount: number; hasUnread: boolean };
	/** Every non-archived document in the library. */
	documentCount: number;
	archivedCount: number;
	/** Library-wide unread dot for the navigation entry. */
	hasUnread: boolean;
	/** Shared folders the Organization holds, against `KB_LIBRARY_FOLDERS_MAX_PER_ORG`. */
	folderCount: number;
	/** Whether the caller may create, rename, move or delete shared folders. */
	canManageFolders: boolean;
}

/** Query of the library list. */
export interface KbLibraryListQuery {
	/** A folder id, or `KB_LIBRARY_UNFILED`. Omitted = every folder. */
	folderId?: string;
	archived?: KbLibraryArchivedFilter;
	q?: string;
	classes?: KbDocumentClass[];
	workId?: string;
	sort?: KbLibrarySort;
	limit?: number;
	cursor?: string;
}

/** Body of the filing action. `folderId: null` unfiles the documents. */
export interface KbLibraryFileRequestDto {
	documentIds: string[];
	folderId: string | null;
}

/** Result of the filing action. */
export interface KbLibraryFileResultDto {
	filed: number;
	folderId: string | null;
}

/** Result of restoring a document from the archive. */
export interface KbLibraryUnarchiveResultDto {
	document: KbLibraryDocumentDto;
	/** `true` when the folder it was archived from no longer exists. */
	restoredToUnfiled: boolean;
}

/** One row of the `#` reference picker. */
export interface KbDocumentReferenceDto {
	id: string;
	title: string;
	slug: string;
	class: KbDocumentClass;
	workId: string | null;
	workName: string | null;
	folderPath: string | null;
}

/** Request of a folder or selection export. */
export interface KbLibraryExportRequestDto {
	folderId?: string | null;
	documentIds?: string[];
	format: KbExportFormat;
	includeArchived?: boolean;
	includeOriginals?: boolean;
}

/** State of a background export. */
export interface KbLibraryExportJobDto {
	jobId: string;
	status: 'queued' | 'running' | 'ready' | 'failed';
	documentCount: number;
	missingCount: number;
	downloadUrl: string | null;
	expiresAt: string | null;
}

/** What a run receipt shows for one explicit document reference. */
export interface KbResolvedReferenceDto {
	documentId: string | null;
	reference: string;
	title: string | null;
	injectedTokens: number;
	truncated: boolean;
	resolved: boolean;
}
