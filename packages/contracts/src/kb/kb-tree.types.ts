import type { KbDocumentClass, KbDocumentStatus } from './kb-document-class.js';

export interface KbTreeNode {
	type: 'folder' | 'document';
	path: string;
	name: string;
	documentId?: string;
	class?: KbDocumentClass;
	status?: KbDocumentStatus;
	locked?: boolean;
	children?: KbTreeNode[];
}
