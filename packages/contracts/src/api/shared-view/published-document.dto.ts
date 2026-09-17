/**
 * Shared view — the published knowledge library.
 *
 * Declared with the rest of the published contract so the shape is settled
 * once; the knowledge section itself stays off (and its endpoints answer the
 * not-active response) until it ships. Closed types, like the board's.
 *
 * Never published: git history, citations, the retrieval trail, embedding
 * state, uploads and original source files.
 */

export interface PublishedDocumentSummaryDto {
	/** An opaque, per-view document reference — never the stored document id. */
	ref: string;
	title: string;
	documentClass: string;
	wordCount: number;
	/** ISO timestamp. */
	updatedAt: string;
}

export interface PublishedDocumentDto extends PublishedDocumentSummaryDto {
	/** The rendered document text. */
	body: string;
}
