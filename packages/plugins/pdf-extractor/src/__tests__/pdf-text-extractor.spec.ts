import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetText = vi.fn();
const mockGetInfo = vi.fn();
const mockDestroy = vi.fn();

vi.mock('pdf-parse', () => ({
	PDFParse: class MockPDFParse {
		constructor() {}
		getText = mockGetText;
		getInfo = mockGetInfo;
		destroy = mockDestroy;
	}
}));

import { PdfTextExtractor } from '../pdf-text-extractor.js';

describe('PdfTextExtractor', () => {
	let extractor: PdfTextExtractor;

	beforeEach(() => {
		extractor = new PdfTextExtractor();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('extractText', () => {
		it('should extract text from a valid PDF buffer', async () => {
			mockGetInfo.mockResolvedValue({ total: 3, info: { Title: 'Test PDF' } });
			mockGetText.mockResolvedValue({
				text: '  Hello world from PDF  ',
				pages: [{ text: 'Hello world from PDF', num: 1 }],
				total: 3
			});

			const result = await extractor.extractText(Buffer.from('fake-pdf-data'));

			expect(result.text).toBe('Hello world from PDF');
			expect(result.numPages).toBe(3);
			expect(result.info).toEqual({ Title: 'Test PDF' });
			expect(mockDestroy).toHaveBeenCalled();
		});

		it('should respect maxPages parameter', async () => {
			mockGetInfo.mockResolvedValue({ total: 100, info: {} });
			mockGetText.mockResolvedValue({ text: 'Page content', pages: [], total: 100 });

			await extractor.extractText(Buffer.from('data'), 5);

			expect(mockGetText).toHaveBeenCalledWith({ first: 5 });
		});

		it('should process all pages when maxPages is 0', async () => {
			mockGetInfo.mockResolvedValue({ total: 10, info: {} });
			mockGetText.mockResolvedValue({ text: 'All pages', pages: [], total: 10 });

			await extractor.extractText(Buffer.from('data'), 0);

			expect(mockGetText).toHaveBeenCalledWith({ first: 10 });
		});

		it('should cap maxPages to actual page count', async () => {
			mockGetInfo.mockResolvedValue({ total: 3, info: {} });
			mockGetText.mockResolvedValue({ text: 'Short doc', pages: [], total: 3 });

			await extractor.extractText(Buffer.from('data'), 50);

			expect(mockGetText).toHaveBeenCalledWith({ first: 3 });
		});

		it('should handle empty PDF text', async () => {
			mockGetInfo.mockResolvedValue({ total: 1, info: {} });
			mockGetText.mockResolvedValue({ text: '   ', pages: [], total: 1 });

			const result = await extractor.extractText(Buffer.from('data'));

			expect(result.text).toBe('');
			expect(result.numPages).toBe(1);
		});

		it('should propagate pdf-parse errors', async () => {
			mockGetInfo.mockRejectedValue(new Error('Corrupted PDF'));

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
