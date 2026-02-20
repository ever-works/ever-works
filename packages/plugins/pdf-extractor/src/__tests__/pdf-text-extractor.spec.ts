import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExtractText, mockGetDocumentProxy, mockGetMeta } = vi.hoisted(() => ({
	mockExtractText: vi.fn(),
	mockGetDocumentProxy: vi.fn(),
	mockGetMeta: vi.fn()
}));

vi.mock('unpdf', () => ({
	extractText: mockExtractText,
	getDocumentProxy: mockGetDocumentProxy,
	getMeta: mockGetMeta
}));

import { PdfTextExtractor } from '../pdf-text-extractor.js';

describe('PdfTextExtractor', () => {
	let extractor: PdfTextExtractor;
	const mockDestroy = vi.fn();

	beforeEach(() => {
		extractor = new PdfTextExtractor();
		vi.clearAllMocks();

		mockGetDocumentProxy.mockResolvedValue({
			numPages: 3,
			destroy: mockDestroy
		});
		mockGetMeta.mockResolvedValue({ info: {} });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('extractText', () => {
		it('should extract text from a valid PDF buffer', async () => {
			mockGetDocumentProxy.mockResolvedValue({
				numPages: 3,
				destroy: mockDestroy
			});
			mockExtractText.mockResolvedValue({
				totalPages: 3,
				text: ['Hello world', 'from PDF', 'page three']
			});
			mockGetMeta.mockResolvedValue({ info: { Title: 'Test PDF' } });

			const result = await extractor.extractText(Buffer.from('fake-pdf-data'));

			expect(result.text).toBe('Hello world\nfrom PDF\npage three');
			expect(result.numPages).toBe(3);
			expect(result.info).toEqual({ Title: 'Test PDF' });
			expect(mockDestroy).toHaveBeenCalled();
		});

		it('should respect maxPages parameter', async () => {
			mockGetDocumentProxy.mockResolvedValue({
				numPages: 100,
				destroy: mockDestroy
			});
			const pageTexts = Array.from({ length: 100 }, (_, i) => `Page ${i + 1}`);
			mockExtractText.mockResolvedValue({ totalPages: 100, text: pageTexts });

			const result = await extractor.extractText(Buffer.from('data'), 5);

			expect(result.text).toBe('Page 1\nPage 2\nPage 3\nPage 4\nPage 5');
			expect(result.numPages).toBe(100);
		});

		it('should process all pages when maxPages is 0', async () => {
			mockGetDocumentProxy.mockResolvedValue({
				numPages: 3,
				destroy: mockDestroy
			});
			mockExtractText.mockResolvedValue({
				totalPages: 3,
				text: ['Page 1', 'Page 2', 'Page 3']
			});

			const result = await extractor.extractText(Buffer.from('data'), 0);

			expect(result.text).toBe('Page 1\nPage 2\nPage 3');
		});

		it('should cap maxPages to actual page count', async () => {
			mockGetDocumentProxy.mockResolvedValue({
				numPages: 3,
				destroy: mockDestroy
			});
			mockExtractText.mockResolvedValue({
				totalPages: 3,
				text: ['Page 1', 'Page 2', 'Page 3']
			});

			const result = await extractor.extractText(Buffer.from('data'), 50);

			expect(result.text).toBe('Page 1\nPage 2\nPage 3');
			expect(result.numPages).toBe(3);
		});

		it('should handle empty PDF text', async () => {
			mockGetDocumentProxy.mockResolvedValue({
				numPages: 1,
				destroy: mockDestroy
			});
			mockExtractText.mockResolvedValue({
				totalPages: 1,
				text: ['   ']
			});

			const result = await extractor.extractText(Buffer.from('data'));

			expect(result.text).toBe('');
			expect(result.numPages).toBe(1);
		});

		it('should propagate unpdf errors', async () => {
			mockGetDocumentProxy.mockRejectedValue(new Error('Corrupted PDF'));

			await expect(extractor.extractText(Buffer.from('bad-data'))).rejects.toThrow('Corrupted PDF');
		});
	});

	describe('calculateTextDensity', () => {
		it('should calculate chars per page', () => {
			// 'HelloWorldTest' = 14 meaningful chars / 2 pages = 7
			expect(extractor.calculateTextDensity('Hello World Test', 2)).toBe(7);
		});

		it('should return 0 for 0 pages', () => {
			expect(extractor.calculateTextDensity('Some text', 0)).toBe(0);
		});

		it('should return 0 for negative pages', () => {
			expect(extractor.calculateTextDensity('Some text', -1)).toBe(0);
		});

		it('should handle whitespace-only text', () => {
			expect(extractor.calculateTextDensity('   \n\t  ', 5)).toBe(0);
		});
	});
});
