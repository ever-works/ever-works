import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExtractText, mockGetDocumentProxy, mockGetMeta, mockDestroy } = vi.hoisted(() => ({
	mockExtractText: vi.fn().mockResolvedValue({ totalPages: 0, text: [] }),
	mockGetDocumentProxy: vi.fn().mockResolvedValue({ numPages: 0, destroy: vi.fn() }),
	mockGetMeta: vi.fn().mockResolvedValue({ info: {} }),
	mockDestroy: vi.fn()
}));

vi.mock('unpdf', () => ({
	extractText: mockExtractText,
	getDocumentProxy: mockGetDocumentProxy,
	getMeta: mockGetMeta
}));

vi.mock('axios');

import { PdfExtractorPlugin } from '../pdf-extractor.plugin.js';
import type { PluginContext } from '@ever-works/plugin';
import axios from 'axios';

describe('PdfExtractorPlugin', () => {
	let plugin: PdfExtractorPlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new PdfExtractorPlugin();
		mockContext = {
			logger: {
				log: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn()
			},
			events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
			settings: {}
		} as unknown as PluginContext;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Plugin Metadata', () => {
		it('should have correct plugin metadata', () => {
			expect(plugin.id).toBe('pdf-extractor');
			expect(plugin.name).toBe('PDF Content Processor');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('content-extractor');
			expect(plugin.capabilities).toContain('content-extractor');
		});

		it('should NOT be a system plugin', () => {
			expect(plugin.systemPlugin).toBe(false);
		});

		it('should NOT be the default extractor', () => {
			expect(plugin.isDefault).toBe(false);
		});

		it('should have provider name "PDF"', () => {
			expect(plugin.providerName).toBe('PDF');
		});

		it('should have settings schema with expected properties', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.mistralApiKey).toBeDefined();
			expect(properties.mistralApiKey['x-secret']).toBe(true);
			expect(properties.mistralApiKey['x-scope']).toBe('user');
			expect(properties.mistralApiKey['x-envVar']).toBe('PLUGIN_PDF_EXTRACTOR_API_KEY');
			expect(properties.ocrModel).toBeDefined();
			expect(properties.textDensityThreshold).toBeDefined();
			expect(properties.maxPages).toBeDefined();
			expect(properties.timeout).toBeDefined();
		});
	});

	describe('canExtract', () => {
		it('should accept .pdf URLs', async () => {
			expect(await plugin.canExtract('https://example.com/doc.pdf')).toBe(true);
		});

		it('should accept .PDF (case insensitive)', async () => {
			expect(await plugin.canExtract('https://example.com/DOC.PDF')).toBe(true);
		});

		it('should accept .pdf with query params', async () => {
			expect(await plugin.canExtract('https://example.com/doc.pdf?token=abc')).toBe(true);
		});

		it('should reject non-PDF URLs', async () => {
			expect(await plugin.canExtract('https://example.com/page.html')).toBe(false);
			expect(await plugin.canExtract('https://example.com/file.docx')).toBe(false);
		});

		it('should reject non-HTTP protocols', async () => {
			expect(await plugin.canExtract('ftp://example.com/doc.pdf')).toBe(false);
		});

		it('should reject invalid URLs', async () => {
			expect(await plugin.canExtract('not-a-url')).toBe(false);
			expect(await plugin.canExtract('')).toBe(false);
		});
	});

	describe('Lifecycle', () => {
		it('should initialize services on load', async () => {
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('PDF Processor Plugin loaded');
		});

		it('should clear services on unload', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onUnload();

			const result = await plugin.extract({ url: 'https://example.com/doc.pdf' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('not initialized');
		});
	});

	describe('extract (text-layer)', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it('should return success for a text-rich PDF', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-pdf') });
			mockGetDocumentProxy.mockResolvedValue({ numPages: 2, destroy: mockDestroy });
			mockExtractText.mockResolvedValue({ totalPages: 2, text: ['A'.repeat(250), 'A'.repeat(250)] });
			mockGetMeta.mockResolvedValue({ info: { Title: 'Test' } });

			const result = await plugin.extract({ url: 'https://example.com/doc.pdf' });

			expect(result.success).toBe(true);
			expect(result.wordCount).toBeDefined();
			expect(result.duration).toBeDefined();
		});

		it('should fail if services not initialized', async () => {
			await plugin.onUnload();

			const result = await plugin.extract({ url: 'https://example.com/doc.pdf' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('not initialized');
		});

		it('should handle HTTP fetch errors', async () => {
			vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

			const result = await plugin.extract({ url: 'https://example.com/doc.pdf' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('Network error');
		});
	});

	describe('extract (OCR fallback)', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it('should trigger OCR when text density is low and API key is present', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-pdf') });
			mockGetDocumentProxy.mockResolvedValue({ numPages: 5, destroy: mockDestroy });
			mockExtractText.mockResolvedValue({ totalPages: 5, text: ['sparse'] });
			mockGetMeta.mockResolvedValue({ info: {} });

			vi.mocked(axios.post).mockResolvedValue({
				data: {
					model: 'mistral-ocr-latest',
					pages: [
						{
							index: 0,
							markdown: '# OCR Result\nRich content here',
							images: [],
							dimensions: { width: 612, height: 792, dpi: 72 }
						}
					],
					usage_info: { pages_processed: 1 }
				}
			});

			const result = await plugin.extract({
				url: 'https://example.com/scanned.pdf',
				settings: { mistralApiKey: 'test-key-12345' }
			});

			expect(result.success).toBe(true);
			expect(result.markdown).toContain('OCR Result');
			expect(axios.post).toHaveBeenCalled();
		});

		it('should fall back to text-layer when OCR fails', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-pdf') });
			mockGetDocumentProxy.mockResolvedValue({ numPages: 5, destroy: mockDestroy });
			mockExtractText.mockResolvedValue({ totalPages: 5, text: ['sparse text'] });
			mockGetMeta.mockResolvedValue({ info: {} });

			vi.mocked(axios.post).mockRejectedValue(new Error('OCR service unavailable'));

			const result = await plugin.extract({
				url: 'https://example.com/scanned.pdf',
				settings: { mistralApiKey: 'test-key-12345' }
			});

			expect(result.success).toBe(true);
			expect(result.content).toBe('sparse text');
			expect(mockContext.logger.warn).toHaveBeenCalled();
		});

		it('should warn when density is low but no API key', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-pdf') });
			mockGetDocumentProxy.mockResolvedValue({ numPages: 5, destroy: mockDestroy });
			mockExtractText.mockResolvedValue({ totalPages: 5, text: ['sparse'] });
			mockGetMeta.mockResolvedValue({ info: {} });

			const result = await plugin.extract({
				url: 'https://example.com/scanned.pdf',
				settings: {}
			});

			expect(result.success).toBe(true);
			expect(mockContext.logger.warn).toHaveBeenCalledWith(expect.stringContaining('no Mistral API key'));
			expect(axios.post).not.toHaveBeenCalled();
		});
	});

	describe('healthCheck', () => {
		it('should return unhealthy when not initialized', async () => {
			expect((await plugin.healthCheck()).status).toBe('unhealthy');
		});

		it('should return healthy when initialized', async () => {
			await plugin.onLoad(mockContext);
			expect((await plugin.healthCheck()).status).toBe('healthy');
		});
	});

	describe('getManifest', () => {
		it('should return correct manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('pdf-extractor');
			expect(manifest.name).toBe('PDF Content Processor');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.systemPlugin).toBe(false);
			expect(manifest.capabilities).toContain('content-extractor');
			expect(manifest.readme).toBeDefined();
		});
	});

	describe('isAvailable', () => {
		it('should always return true', async () => {
			expect(await plugin.isAvailable()).toBe(true);
		});
	});

	describe('getSupportedFormats', () => {
		it('should support text and markdown', () => {
			const formats = plugin.getSupportedFormats();
			expect(formats).toContain('text');
			expect(formats).toContain('markdown');
		});
	});

	describe('extractBatch', () => {
		it('should process multiple URLs', async () => {
			await plugin.onLoad(mockContext);
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-pdf') });
			mockGetDocumentProxy.mockResolvedValue({ numPages: 1, destroy: mockDestroy });
			mockExtractText.mockResolvedValue({ totalPages: 1, text: ['A'.repeat(500)] });
			mockGetMeta.mockResolvedValue({ info: {} });

			const results = await plugin.extractBatch(['https://example.com/a.pdf', 'https://example.com/b.pdf']);

			expect(results).toHaveLength(2);
		});
	});

	describe('SSRF guard', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it.each([
			['http://127.0.0.1/foo.pdf', 'loopback'],
			['http://169.254.169.254/latest/meta-data/', 'AWS/GCP/Azure IMDS link-local'],
			['http://10.0.0.1/', 'RFC1918 private']
		])('rejects SSRF-blocked URLs (%s — %s) without making an HTTP request', async (blockedUrl) => {
			const result = await plugin.extract({ url: blockedUrl });

			expect(result.success).toBe(false);
			expect(result.url).toBe(blockedUrl);
			expect(result.error).toMatch(/SSRF guard blocked/);
			expect(result.error).toContain(blockedUrl);
			expect(axios.get).not.toHaveBeenCalled();
		});
	});

	describe('PDF_EXTRACTOR_MAX_BYTES cap', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it('passes maxContentLength and maxBodyLength to axios.get to cap the payload size', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-pdf') });
			mockGetDocumentProxy.mockResolvedValue({ numPages: 1, destroy: mockDestroy });
			mockExtractText.mockResolvedValue({ totalPages: 1, text: ['A'.repeat(500)] });
			mockGetMeta.mockResolvedValue({ info: {} });

			await plugin.extract({ url: 'https://example.com/doc.pdf' });

			expect(axios.get).toHaveBeenCalledTimes(1);
			const [, config] = vi.mocked(axios.get).mock.calls[0];
			// Default cap is 50 MB unless PDF_EXTRACTOR_MAX_BYTES env override raised it.
			expect(config?.maxContentLength).toBeGreaterThan(0);
			expect(config?.maxBodyLength).toBeGreaterThan(0);
			expect(config?.maxContentLength).toBe(config?.maxBodyLength);
		});

		it('rejects oversized payloads (axios maxContentLength fired)', async () => {
			// Simulate the axios rejection that fires when a response's
			// content-length exceeds the configured maxContentLength.
			const overflowErr = Object.assign(new Error('maxContentLength size of 52428800 exceeded'), {
				code: 'ERR_BAD_RESPONSE'
			});
			vi.mocked(axios.get).mockRejectedValue(overflowErr);

			const result = await plugin.extract({ url: 'https://example.com/huge.pdf' });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/maxContentLength/);
		});
	});
});
