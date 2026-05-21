import type { KbDocumentClass } from './kb-document-class.js';

export interface KbSearchHit {
	documentId: string;
	path: string;
	title: string;
	class: KbDocumentClass;
	snippet: string;
	score: number;
	chunkIndex?: number;
	chunkRange?: { start: number; end: number };
}

export interface KbSearchResult {
	hits: KbSearchHit[];
	total: number;
}
