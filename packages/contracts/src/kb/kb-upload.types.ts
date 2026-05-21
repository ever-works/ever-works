import type { KbUploadExtractionStatus } from './kb-document-class.js';

export interface KbUploadDto {
	id: string;
	workId: string;
	storageProvider: string;
	storagePath: string;
	originalFilename: string;
	mimeType: string;
	fileSize: number;
	sha256: string;
	normalizedFormat: string | null;
	extractionStatus: KbUploadExtractionStatus;
	extractionPluginId: string | null;
	extractionError: string | null;
	extractedDocumentId: string | null;
	uploadedById: string | null;
	tags: string[];
	categories: string[];
	createdAt: string;
	updatedAt: string;
}
