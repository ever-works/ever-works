import axios from 'axios';
import type { MistralOcrRequest, MistralOcrResponse } from './types.js';

const MISTRAL_OCR_API_URL = 'https://api.mistral.ai/v1/ocr';

export interface MistralOcrOptions {
	model?: string;
	pages?: number[];
	timeout?: number;
}

/**
 * Client for the Mistral OCR API — sends PDF URLs for OCR and returns per-page markdown.
 */
export class MistralOcrService {
	async processDocument(url: string, apiKey: string, options: MistralOcrOptions = {}): Promise<MistralOcrResponse> {
		const { model = 'mistral-ocr-latest', pages, timeout = 60000 } = options;

		const requestBody: MistralOcrRequest = {
			model,
			document: {
				type: 'document_url',
				document_url: url
			}
		};

		if (pages && pages.length > 0) {
			requestBody.pages = pages;
		}

		try {
			const response = await axios.post<MistralOcrResponse>(MISTRAL_OCR_API_URL, requestBody, {
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				timeout
			});

			return response.data;
		} catch (error: unknown) {
			if (axios.isAxiosError(error) && error.response) {
				const status = error.response.status;
				if (status === 401) {
					throw new Error('Invalid Mistral API key. Please check your API key configuration.');
				}
				if (status === 400) {
					throw new Error(
						`Bad request to Mistral OCR API: ${error.response.data?.message || 'Invalid document or parameters'}`
					);
				}
				if (status === 429) {
					throw new Error('Mistral OCR API rate limit exceeded. Please try again later.');
				}
				throw new Error(`Mistral OCR API error (${status}): ${error.response.data?.message || error.message}`);
			}
			throw error;
		}
	}

	combinePages(response: MistralOcrResponse): string {
		if (!response.pages || response.pages.length === 0) {
			return '';
		}

		if (response.pages.length === 1) {
			return response.pages[0].markdown;
		}

		return response.pages.map((page) => page.markdown).join('\n\n---\n\n');
	}
}
