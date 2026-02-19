export interface MistralOcrRequest {
	model: string;
	document: {
		type: 'document_url';
		document_url: string;
	};
	pages?: number[];
}

export interface MistralOcrPage {
	index: number;
	markdown: string;
	images: MistralOcrImage[];
	dimensions: {
		width: number;
		height: number;
		dpi: number;
	};
}

export interface MistralOcrImage {
	id: string;
	image_base64?: string;
}

export interface MistralOcrResponse {
	model: string;
	pages: MistralOcrPage[];
	usage_info: {
		pages_processed: number;
		doc_size_bytes?: number;
	};
}

export interface PdfTextResult {
	text: string;
	numPages: number;
	info: Record<string, unknown>;
}
