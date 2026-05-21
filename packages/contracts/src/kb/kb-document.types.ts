import type { KbDocumentClass, KbDocumentSource, KbDocumentStatus, KbLockMode } from './kb-document-class.js';

/**
 * Metadata-only DTO for a KB document.
 *
 * Returned by list endpoints + by mutation endpoints when the caller
 * doesn't need the full Markdown body. Get-by-id returns
 * `KbDocumentBodyDto` (this + `body` + `assets`).
 */
export interface KbDocumentDto {
	id: string;
	workId: string | null;
	organizationId: string | null;
	path: string;
	slug: string;
	title: string;
	description: string | null;
	class: KbDocumentClass;
	tags: string[];
	categories: string[];
	status: KbDocumentStatus;
	locked: boolean;
	lockMode: KbLockMode | null;
	language: string;
	wordCount: number | null;
	tokenCount: number | null;
	source: KbDocumentSource;
	sourceUploadId: string | null;
	sourceUrl: string | null;
	generatedByAgentRunId: string | null;
	createdById: string | null;
	updatedById: string | null;
	createdAt: string;
	updatedAt: string;
	lastCommitSha: string | null;
	lastIndexedAt: string | null;
}

/**
 * Full document including Markdown body + linked asset summaries.
 */
export interface KbDocumentBodyDto extends KbDocumentDto {
	body: string;
	assets: KbAssetSummary[];
}

export interface KbAssetSummary {
	path: string;
	mimeType: string;
	sizeBytes: number;
}

/**
 * Input for creating a new KB document via the API.
 */
export interface CreateKbDocumentInput {
	path: string;
	title: string;
	class: KbDocumentClass;
	body: string;
	description?: string | null;
	tags?: string[];
	categories?: string[];
	language?: string;
	status?: KbDocumentStatus;
}

/**
 * Partial update.
 */
export interface UpdateKbDocumentInput {
	title?: string;
	description?: string | null;
	body?: string;
	tags?: string[];
	categories?: string[];
	language?: string;
	status?: KbDocumentStatus;
}

/**
 * Filter for `GET /api/works/:id/kb/documents`.
 */
export interface KbDocumentListFilter {
	class?: KbDocumentClass | KbDocumentClass[];
	status?: KbDocumentStatus | KbDocumentStatus[];
	tag?: string | string[];
	locked?: boolean;
	language?: string;
	source?: KbDocumentSource;
	/** Lexical search across title + description + body via Postgres FTS. */
	q?: string;
	limit?: number;
	cursor?: string;
}

export interface KbDocumentListResult {
	items: KbDocumentDto[];
	nextCursor: string | null;
	total: number;
}
