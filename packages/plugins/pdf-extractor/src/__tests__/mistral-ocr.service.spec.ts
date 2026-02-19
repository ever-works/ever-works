import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

import { MistralOcrService } from '../mistral-ocr.service.js';
import type { MistralOcrResponse } from '../types.js';

describe('MistralOcrService', () => {
	let service: MistralOcrService;

	beforeEach(() => {
		service = new MistralOcrService();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('processDocument', () => {
		const testUrl = 'https://example.com/doc.pdf';
		const testApiKey = 'test-api-key-12345';

		const mockResponse: MistralOcrResponse = {
			model: 'mistral-ocr-latest',
			pages: [{ index: 0, markdown: '# Page 1', images: [], dimensions: { width: 612, height: 792, dpi: 72 } }],
			usage_info: { pages_processed: 1 }
		};

		it('should send correct payload with default model', async () => {
			vi.mocked(axios.post).mockResolvedValue({ data: mockResponse });

			await service.processDocument(testUrl, testApiKey);

			expect(axios.post).toHaveBeenCalledWith(
				'https://api.mistral.ai/v1/ocr',
				{
					model: 'mistral-ocr-latest',
					document: { type: 'document_url', document_url: testUrl }
				},
				expect.objectContaining({
					headers: {
						Authorization: `Bearer ${testApiKey}`,
						'Content-Type': 'application/json'
					},
					timeout: 60000
				})
			);
		});

		it('should use custom model and timeout', async () => {
			vi.mocked(axios.post).mockResolvedValue({ data: mockResponse });

			await service.processDocument(testUrl, testApiKey, {
				model: 'mistral-ocr-custom',
				timeout: 30000
			});

			expect(axios.post).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ model: 'mistral-ocr-custom' }),
				expect.objectContaining({ timeout: 30000 })
			);
		});

		it('should include page range when specified', async () => {
			vi.mocked(axios.post).mockResolvedValue({ data: mockResponse });

			await service.processDocument(testUrl, testApiKey, { pages: [0, 1, 2] });

			expect(axios.post).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ pages: [0, 1, 2] }),
				expect.any(Object)
			);
		});

		it('should throw on 401 unauthorized', async () => {
			const axiosError = new Error('Unauthorized') as any;
			axiosError.response = { status: 401, data: {} };
			axiosError.isAxiosError = true;
			vi.mocked(axios.post).mockRejectedValue(axiosError);
			vi.mocked(axios.isAxiosError).mockReturnValue(true);

			await expect(service.processDocument(testUrl, 'bad-key')).rejects.toThrow('Invalid Mistral API key');
		});

		it('should throw on 400 bad request', async () => {
			const axiosError = new Error('Bad Request') as any;
			axiosError.response = { status: 400, data: { message: 'Invalid document' } };
			axiosError.isAxiosError = true;
			vi.mocked(axios.post).mockRejectedValue(axiosError);
			vi.mocked(axios.isAxiosError).mockReturnValue(true);

			await expect(service.processDocument(testUrl, testApiKey)).rejects.toThrow('Bad request');
		});

		it('should throw on 429 rate limit', async () => {
			const axiosError = new Error('Too Many Requests') as any;
			axiosError.response = { status: 429, data: {} };
			axiosError.isAxiosError = true;
			vi.mocked(axios.post).mockRejectedValue(axiosError);
			vi.mocked(axios.isAxiosError).mockReturnValue(true);

			await expect(service.processDocument(testUrl, testApiKey)).rejects.toThrow('rate limit');
		});
	});

	describe('combinePages', () => {
		it('should join multiple pages with horizontal rules', () => {
			const response: MistralOcrResponse = {
				model: 'mistral-ocr-latest',
				pages: [
					{
						index: 0,
						markdown: '# Page 1\nContent A',
						images: [],
						dimensions: { width: 612, height: 792, dpi: 72 }
					},
					{
						index: 1,
						markdown: '# Page 2\nContent B',
						images: [],
						dimensions: { width: 612, height: 792, dpi: 72 }
					}
				],
				usage_info: { pages_processed: 2 }
			};

			const result = service.combinePages(response);
			expect(result).toBe('# Page 1\nContent A\n\n---\n\n# Page 2\nContent B');
		});

		it('should return single page without separator', () => {
			const response: MistralOcrResponse = {
				model: 'mistral-ocr-latest',
				pages: [
					{ index: 0, markdown: 'Only page', images: [], dimensions: { width: 612, height: 792, dpi: 72 } }
				],
				usage_info: { pages_processed: 1 }
			};

			expect(service.combinePages(response)).toBe('Only page');
		});

		it('should return empty string for no pages', () => {
			const response: MistralOcrResponse = {
				model: 'mistral-ocr-latest',
				pages: [],
				usage_info: { pages_processed: 0 }
			};

			expect(service.combinePages(response)).toBe('');
		});
	});
});
