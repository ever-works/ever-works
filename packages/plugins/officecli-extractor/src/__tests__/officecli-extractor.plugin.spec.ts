import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockOpen, mockSend, mockClose } = vi.hoisted(() => ({
	mockOpen: vi.fn(),
	mockSend: vi.fn(),
	mockClose: vi.fn()
}));

vi.mock('@officecli/sdk', () => ({
	open: mockOpen
}));

vi.mock('axios');

import { OfficeCliExtractorPlugin } from '../officecli-extractor.plugin.js';
import type { PluginContext } from '@ever-works/plugin';
import axios from 'axios';

describe('OfficeCliExtractorPlugin', () => {
	let plugin: OfficeCliExtractorPlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new OfficeCliExtractorPlugin();
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

		// Default happy-path resident handle.
		mockSend.mockResolvedValue('Extracted Office text content');
		mockClose.mockResolvedValue('');
		mockOpen.mockResolvedValue({ send: mockSend, close: mockClose });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Plugin Metadata', () => {
		it('should have correct plugin metadata', () => {
			expect(plugin.id).toBe('officecli-extractor');
			expect(plugin.name).toBe('OfficeCLI Content Processor');
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

		it('should have provider name "OfficeCLI"', () => {
			expect(plugin.providerName).toBe('OfficeCLI');
		});

		it('should have settings schema with expected properties', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.renderMode).toBeDefined();
			expect(properties.renderMode.enum).toEqual(['text', 'markdown']);
			expect(properties.renderMode.default).toBe('text');
			expect(properties.maxBytes).toBeDefined();
			expect(properties.timeout).toBeDefined();
			expect(properties.binaryPath).toBeDefined();
		});
	});

	describe('canExtract', () => {
		it('should accept .docx URLs', async () => {
			expect(await plugin.canExtract('https://example.com/doc.docx')).toBe(true);
		});

		it('should accept .xlsx URLs', async () => {
			expect(await plugin.canExtract('https://example.com/sheet.xlsx')).toBe(true);
		});

		it('should accept .pptx URLs', async () => {
			expect(await plugin.canExtract('https://example.com/deck.pptx')).toBe(true);
		});

		it('should accept Office extensions case-insensitively', async () => {
			expect(await plugin.canExtract('https://example.com/DOC.DOCX')).toBe(true);
			expect(await plugin.canExtract('https://example.com/SHEET.XLSX')).toBe(true);
		});

		it('should accept Office URLs with query params', async () => {
			expect(await plugin.canExtract('https://example.com/doc.docx?token=abc')).toBe(true);
		});

		it('should reject non-Office URLs (incl. .pdf — no overlap with pdf-extractor)', async () => {
			expect(await plugin.canExtract('https://example.com/page.html')).toBe(false);
			expect(await plugin.canExtract('https://example.com/file.pdf')).toBe(false);
			expect(await plugin.canExtract('https://example.com/notes.txt')).toBe(false);
		});

		it('should reject non-HTTP protocols', async () => {
			expect(await plugin.canExtract('ftp://example.com/doc.docx')).toBe(false);
		});

		it('should reject invalid URLs', async () => {
			expect(await plugin.canExtract('not-a-url')).toBe(false);
			expect(await plugin.canExtract('')).toBe(false);
		});
	});

	describe('Lifecycle', () => {
		it('should initialize the service on load', async () => {
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('OfficeCLI Processor Plugin loaded');
		});

		it('should clear the service on unload', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onUnload();

			const result = await plugin.extract({ url: 'https://example.com/doc.docx' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('not initialized');
		});
	});

	describe('extract', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it('should return the mapped extraction shape for a docx', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });
			mockSend.mockResolvedValue('Quarterly Report\nRevenue grew by twenty percent this year.');

			const result = await plugin.extract({ url: 'https://example.com/report.docx' });

			expect(result.success).toBe(true);
			expect(result.url).toBe('https://example.com/report.docx');
			expect(result.content).toContain('Revenue grew');
			expect(result.markdown).toContain('Revenue grew');
			expect(result.title).toBe('Quarterly Report');
			expect(result.wordCount).toBeGreaterThan(0);
			expect(result.readingTime).toBeGreaterThanOrEqual(1);
			expect(result.duration).toBeDefined();
			expect(mockOpen).toHaveBeenCalledTimes(1);
			expect(mockSend).toHaveBeenCalledTimes(1);
			expect(mockClose).toHaveBeenCalledTimes(1);
		});

		it('should request plain text (asJson=false) in text render mode', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });

			await plugin.extract({ url: 'https://example.com/report.docx', settings: { renderMode: 'text' } });

			const [item, asJson] = mockSend.mock.calls[0];
			expect(item.command).toBe('dump');
			expect(item.format).toBeUndefined();
			expect(asJson).toBe(false);
		});

		it('should pass a markdown format arg in markdown render mode', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });
			mockSend.mockResolvedValue('# Heading\n\nBody text.');

			const result = await plugin.extract({
				url: 'https://example.com/report.docx',
				settings: { renderMode: 'markdown' }
			});

			const [item, asJson] = mockSend.mock.calls[0];
			expect(item.command).toBe('dump');
			expect(item.format).toBe('markdown');
			expect(asJson).toBe(false);
			expect(result.markdown).toContain('# Heading');
			expect(result.title).toBe('Heading');
		});

		it('should forward a binaryPath override to the SDK', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });

			await plugin.extract({
				url: 'https://example.com/report.docx',
				settings: { binaryPath: '/custom/bin/officecli' }
			});

			const [, openOptions] = mockOpen.mock.calls[0];
			expect(openOptions.binary).toBe('/custom/bin/officecli');
		});

		it('should reject unsupported extensions before any download', async () => {
			const result = await plugin.extract({ url: 'https://example.com/file.pdf' });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/Unsupported Office document URL/);
			expect(axios.get).not.toHaveBeenCalled();
		});

		it('should handle HTTP fetch errors', async () => {
			vi.mocked(axios.get).mockRejectedValue(new Error('Network error'));

			const result = await plugin.extract({ url: 'https://example.com/doc.docx' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('Network error');
		});

		it('should surface OfficeCLI transport failures as a failed extraction', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });
			mockOpen.mockRejectedValue(new Error('[exit 127] officecli CLI not found'));

			const result = await plugin.extract({ url: 'https://example.com/doc.docx' });
			expect(result.success).toBe(false);
			expect(result.error).toContain('officecli CLI not found');
			expect(mockContext.logger.error).toHaveBeenCalled();
		});

		it('should coerce a non-string SDK envelope to text', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-xlsx') });
			mockSend.mockResolvedValue({ success: true, rows: 3 });

			const result = await plugin.extract({ url: 'https://example.com/sheet.xlsx' });
			expect(result.success).toBe(true);
			expect(result.content).toContain('rows');
		});
	});

	describe('SSRF guard', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it.each([
			['http://127.0.0.1/foo.docx', 'loopback'],
			['http://169.254.169.254/latest/meta-data/report.docx', 'AWS/GCP/Azure IMDS link-local'],
			['http://10.0.0.1/report.xlsx', 'RFC1918 private']
		])('rejects SSRF-blocked URLs (%s — %s) without making an HTTP request', async (blockedUrl) => {
			const result = await plugin.extract({ url: blockedUrl });

			expect(result.success).toBe(false);
			expect(result.url).toBe(blockedUrl);
			expect(result.error).toMatch(/SSRF guard blocked/);
			expect(result.error).toContain(blockedUrl);
			expect(axios.get).not.toHaveBeenCalled();
			expect(mockOpen).not.toHaveBeenCalled();
		});
	});

	describe('OFFICECLI_EXTRACTOR_MAX_BYTES cap', () => {
		beforeEach(async () => {
			await plugin.onLoad(mockContext);
		});

		it('passes maxContentLength and maxBodyLength to axios.get to cap the payload size', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });

			await plugin.extract({ url: 'https://example.com/doc.docx' });

			expect(axios.get).toHaveBeenCalledTimes(1);
			const [, config] = vi.mocked(axios.get).mock.calls[0];
			expect(config?.maxContentLength).toBeGreaterThan(0);
			expect(config?.maxBodyLength).toBeGreaterThan(0);
			expect(config?.maxContentLength).toBe(config?.maxBodyLength);
		});

		it('honors an explicit maxBytes setting', async () => {
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });

			await plugin.extract({ url: 'https://example.com/doc.docx', settings: { maxBytes: 4096 } });

			const [, config] = vi.mocked(axios.get).mock.calls[0];
			expect(config?.maxContentLength).toBe(4096);
			expect(config?.maxBodyLength).toBe(4096);
		});

		it('rejects oversized payloads (axios maxContentLength fired)', async () => {
			const overflowErr = Object.assign(new Error('maxContentLength size of 26214400 exceeded'), {
				code: 'ERR_BAD_RESPONSE'
			});
			vi.mocked(axios.get).mockRejectedValue(overflowErr);

			const result = await plugin.extract({ url: 'https://example.com/huge.docx' });

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/maxContentLength/);
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
			expect(manifest.id).toBe('officecli-extractor');
			expect(manifest.name).toBe('OfficeCLI Content Processor');
			expect(manifest.builtIn).toBe(true);
			expect(manifest.systemPlugin).toBe(false);
			expect(manifest.capabilities).toContain('content-extractor');
			expect(manifest.readme).toBeDefined();
			expect(manifest.readme).toContain('Apache-2.0');
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
			expect(formats).not.toContain('html');
		});
	});

	describe('extractBatch', () => {
		it('should process multiple URLs', async () => {
			await plugin.onLoad(mockContext);
			vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('fake-docx') });

			const results = await plugin.extractBatch(['https://example.com/a.docx', 'https://example.com/b.pptx']);

			expect(results).toHaveLength(2);
			expect(results[0].success).toBe(true);
			expect(results[1].success).toBe(true);
		});
	});
});
