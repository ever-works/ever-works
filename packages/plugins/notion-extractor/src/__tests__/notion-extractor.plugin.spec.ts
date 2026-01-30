import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotionExtractorPlugin } from '../notion-extractor.plugin.js';
import type { PluginContext } from '@ever-works/plugin';

describe('NotionExtractorPlugin', () => {
	let plugin: NotionExtractorPlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new NotionExtractorPlugin();
		mockContext = {
			logger: {
				log: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn()
			},
			events: {
				emit: vi.fn(),
				on: vi.fn(),
				off: vi.fn()
			},
			settings: {}
		} as unknown as PluginContext;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Plugin Metadata', () => {
		it('should have correct plugin metadata', () => {
			expect(plugin.id).toBe('notion-extractor');
			expect(plugin.name).toBe('Notion Page Extractor');
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

		it('should have provider name "Notion"', () => {
			expect(plugin.providerName).toBe('Notion');
		});

		it('should have settings schema with apiKey and useSplitbeeForPublicPages', () => {
			expect(plugin.settingsSchema).toBeDefined();
			expect(plugin.settingsSchema.type).toBe('object');

			const properties = plugin.settingsSchema.properties as Record<string, unknown>;
			expect(properties.apiKey).toBeDefined();
			expect(properties.useSplitbeeForPublicPages).toBeDefined();
		});
	});

	describe('canExtract', () => {
		it('should return true for notion.so URLs', async () => {
			expect(await plugin.canExtract('https://notion.so/page-123abc')).toBe(true);
			expect(await plugin.canExtract('https://www.notion.so/My-Page-abc123')).toBe(true);
			expect(
				await plugin.canExtract('https://notion.so/workspace/Page-Title-12345678901234567890123456789012')
			).toBe(true);
		});

		it('should return true for notion.site URLs', async () => {
			expect(await plugin.canExtract('https://mysite.notion.site/page-123')).toBe(true);
			expect(await plugin.canExtract('https://company.notion.site/docs/Page-abc')).toBe(true);
		});

		it('should return false for non-Notion URLs', async () => {
			expect(await plugin.canExtract('https://example.com')).toBe(false);
			expect(await plugin.canExtract('https://github.com/notion/repo')).toBe(false);
			expect(await plugin.canExtract('https://google.com/notion.so')).toBe(false);
			expect(await plugin.canExtract('https://notnotion.so/page')).toBe(false);
		});

		it('should return false for invalid URLs', async () => {
			expect(await plugin.canExtract('not-a-url')).toBe(false);
			expect(await plugin.canExtract('')).toBe(false);
		});
	});

	describe('Lifecycle', () => {
		it('should initialize NotionService on load', async () => {
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Notion Extractor Plugin loaded');
		});

		it('should log on enable', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onEnable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Notion Extractor Plugin enabled');
		});

		it('should log on disable', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onDisable(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Notion Extractor Plugin disabled');
		});
	});

	describe('validateSettings', () => {
		it('should accept valid Notion API key with secret_ prefix', async () => {
			const result = await plugin.validateSettings({ apiKey: 'secret_abcdefghijk' });
			expect(result.valid).toBe(true);
		});

		it('should accept valid Notion API key with ntn_ prefix', async () => {
			const result = await plugin.validateSettings({ apiKey: 'ntn_abcdefghijk' });
			expect(result.valid).toBe(true);
		});

		it('should reject invalid API key format', async () => {
			const result = await plugin.validateSettings({ apiKey: 'invalid_key_format' });
			expect(result.valid).toBe(false);
			expect(result.errors?.[0].path).toBe('apiKey');
		});

		it('should accept empty settings (API key is optional)', async () => {
			const result = await plugin.validateSettings({});
			expect(result.valid).toBe(true);
		});
	});

	describe('healthCheck', () => {
		it('should return unhealthy when service not initialized', async () => {
			const result = await plugin.healthCheck();
			expect(result.status).toBe('unhealthy');
			expect(result.message).toContain('not initialized');
		});

		it('should return healthy when service is initialized', async () => {
			await plugin.onLoad(mockContext);
			const result = await plugin.healthCheck();
			expect(result.status).toBe('healthy');
		});
	});

	describe('getManifest', () => {
		it('should return correct manifest', () => {
			const manifest = plugin.getManifest();
			expect(manifest.id).toBe('notion-extractor');
			expect(manifest.name).toBe('Notion Page Extractor');
			expect(manifest.systemPlugin).toBe(false);
			expect(manifest.autoInstall).toBe(false);
			expect(manifest.capabilities).toContain('content-extractor');
		});
	});

	describe('isAvailable', () => {
		it('should always return true (Splitbee is generally available)', async () => {
			expect(await plugin.isAvailable()).toBe(true);
		});
	});

	describe('getSupportedFormats', () => {
		it('should support text and markdown formats', () => {
			const formats = plugin.getSupportedFormats();
			expect(formats).toContain('text');
			expect(formats).toContain('markdown');
		});
	});

	describe('extract', () => {
		it('should fail if service not initialized', async () => {
			const result = await plugin.extract({
				url: 'https://notion.so/page-123abc'
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain('not initialized');
		});

		it('should fail for non-Notion URLs', async () => {
			await plugin.onLoad(mockContext);
			const result = await plugin.extract({
				url: 'https://example.com'
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain('Not a Notion URL');
		});
	});
});
