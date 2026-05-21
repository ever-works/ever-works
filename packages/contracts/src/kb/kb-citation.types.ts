import type { KbCitationConsumerType } from './kb-document-class.js';

export interface CitationDto {
	id: string;
	documentId: string;
	consumerType: KbCitationConsumerType;
	consumerId: string;
	chunkRange: { start: number; end: number } | null;
	relevanceScore: number | null;
	createdAt: string;
}
