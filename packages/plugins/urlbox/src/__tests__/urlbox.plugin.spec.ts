import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UrlboxPlugin } from '../urlbox.plugin.js';
import type { PluginContext, ScreenshotOptions } from '@ever-works/plugin';

// Mock the urlbox module
// urlbox exports a factory function: Urlbox(apiKey, apiSecret) => { generateRenderLink(options) }
vi.mock('urlbox', () => {
	const mockGenerateRenderLink = vi
		.fn()
		.mockReturnValue('https://api.urlbox.com/v1/render?url=https%3A%2F%2Fexample.com&width=1280');

	const mockUrlboxFactory = vi.fn().mockReturnValue({
		generateRenderLink: mockGenerateRenderLink
	});

	return {
		default: mockUrlboxFactory
	};
});

// Mock global fetch
const mockFetchResponse = {
	ok: true,
	status: 200,
	arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100))
};

vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchResponse));

describe('UrlboxPlugin', () => {
	let plugin: UrlboxPlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new UrlboxPlugin();
		mockContext = {
			pluginId: 'urlbox',
			logger: {
				log: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn()
			},
			cache: {} as any,
			http: {} as any,
			env: {} as any,
			envVars: {} as any,
			services: {} as any,
			getSettings: vi.fn().mockResolvedValue({}),
			getResolvedSettings: vi.fn().mockResolvedValue({}),
			onEvent: vi.fn(),
			emitEvent: vi.fn(),
			registerCustomCapability: vi.fn(),
			getCustomCapability: vi.fn(),
			hasCustomCapability: vi.fn(),
			listCustomCapabilities: vi.fn()
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Plugin Metadata', () => {
		it('should have correct plugin metadata', () => {
			expect(plugin.id).toBe('urlbox');
			expect(plugin.name).toBe('Urlbox');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('screenshot');
		});

		it('should have screenshot capability', () => {
			expect(plugin.capabilities).toContain('screenshot');
		});

		it('should have provider name', () => {
			expect(plugin.providerName).toBe('Urlbox');
		});

		it('should have hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('Settings Schema', () => {
		it('should define apiKey as required', () => {
			expect(plugin.settingsSchema.required).toContain('apiKey');
		});

		it('should mark apiKey as secret', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.apiKey['x-secret']).toBe(true);
		});

		it('should mark apiSecret as secret', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.apiSecret['x-secret']).toBe(true);
		});

		it('should have environment variable fallbacks', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.apiKey['x-envVar']).toBe('PLUGIN_URLBOX_API_KEY');
			expect(properties.apiSecret['x-envVar']).toBe('PLUGIN_URLBOX_API_SECRET');
			expect(properties.viewportWidth['x-envVar']).toBe('PLUGIN_URLBOX_VIEWPORT_WIDTH');
			expect(properties.viewportHeight['x-envVar']).toBe('PLUGIN_URLBOX_VIEWPORT_HEIGHT');
			expect(properties.format['x-envVar']).toBe('PLUGIN_URLBOX_FORMAT');
		});

		it('should have default values for viewport settings', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.viewportWidth.default).toBe(1280);
			expect(properties.viewportHeight.default).toBe(1024);
		});

		it('should have default values for format and blocking options', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.format.default).toBe('png');
			expect(properties.fullPage.default).toBe(false);
			expect(properties.blockAds.default).toBe(true);
			expect(properties.hideCookieBanners.default).toBe(true);
		});

		it('should have quality setting with correct bounds', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.quality.default).toBe(80);
			expect(properties.quality.minimum).toBe(1);
			expect(properties.quality.maximum).toBe(100);
		});

		it('should have retina setting defaulting to false', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.retina.default).toBe(false);
		});

		it('should have format enum with supported formats', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.format.enum).toEqual(['png', 'jpg', 'jpeg', 'webp']);
		});
	});

	describe('IScreenshotPlugin - capture', () => {
		it('should capture screenshot successfully with settings', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {
					apiKey: 'test-api-key',
					apiSecret: 'test-api-secret'
				}
			};

			const result = await plugin.capture(options);

			expect(result.success).toBe(true);
			expect(result.imageBuffer).toBeDefined();
			expect(result.imageBase64).toBeDefined();
			expect(result.imageUrl).toBeDefined();
		});

		it('should fail when API key is not configured', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {}
			};

			const result = await plugin.capture(options);

			expect(result.success).toBe(false);
			expect(result.error).toContain('API key not configured');
		});

		it('should use provided viewport dimensions', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				viewportWidth: 1920,
				viewportHeight: 1080,
				settings: {
					apiKey: 'test-key'
				}
			};

			const result = await plugin.capture(options);

			expect(result.success).toBe(true);
			expect(result.width).toBe(1920);
			expect(result.height).toBe(1080);
		});
	});

	describe('IScreenshotPlugin - getScreenshotUrl', () => {
		it('should generate URL with settings', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {
					apiKey: 'test-key'
				}
			};

			const url = await plugin.getScreenshotUrl(options);

			expect(url).toBeDefined();
			expect(url).toContain('api.urlbox.com');
		});

		it('should generate render link with API secret', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {
					apiKey: 'test-key',
					apiSecret: 'test-secret'
				}
			};

			const url = await plugin.getScreenshotUrl(options);

			expect(url).toBeDefined();
			expect(url).toContain('api.urlbox.com');
		});

		it('should return null when API key is missing', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {}
			};

			const url = await plugin.getScreenshotUrl(options);

			expect(url).toBeNull();
		});
	});

	describe('IScreenshotPlugin - isAvailable', () => {
		it('should return true when API key is configured', async () => {
			(mockContext.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ apiKey: 'test-key' });
			await plugin.onLoad(mockContext);
			const available = await plugin.isAvailable();
			expect(available).toBe(true);
		});

		it('should return false when not loaded', async () => {
			const available = await plugin.isAvailable();
			expect(available).toBe(false);
		});
	});

	describe('IScreenshotPlugin - validateCredentials', () => {
		it('should return invalid when plugin not initialized', async () => {
			const result = await plugin.validateCredentials();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('not initialized');
		});

		it('should return invalid when API key not configured', async () => {
			vi.mocked(mockContext.getSettings).mockResolvedValue({});
			await plugin.onLoad(mockContext);

			const result = await plugin.validateCredentials();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('API key is not configured');
		});

		it('should return valid when credentials are configured', async () => {
			vi.mocked(mockContext.getSettings).mockResolvedValue({
				apiKey: 'test-key'
			});
			await plugin.onLoad(mockContext);

			const result = await plugin.validateCredentials();

			expect(result.valid).toBe(true);
		});
	});

	describe('IScreenshotPlugin - getSupportedFormats', () => {
		it('should return supported formats', () => {
			const formats = plugin.getSupportedFormats();

			expect(formats).toContain('png');
			expect(formats).toContain('jpg');
			expect(formats).toContain('jpeg');
			expect(formats).toContain('webp');
		});
	});

	describe('IScreenshotPlugin - getMaxDimensions', () => {
		it('should return maximum viewport dimensions', () => {
			const dimensions = plugin.getMaxDimensions();

			expect(dimensions.width).toBe(3840);
			expect(dimensions.height).toBe(2160);
		});
	});

	describe('Lifecycle', () => {
		it('should log on load', async () => {
			await plugin.onLoad(mockContext);
			expect(mockContext.logger.log).toHaveBeenCalledWith('Urlbox Plugin loaded');
		});

		it('should clear context on unload', async () => {
			await plugin.onLoad(mockContext);
			await plugin.onUnload();
			// Context should be cleared - validateCredentials should fail
			const result = await plugin.validateCredentials();
			expect(result.valid).toBe(false);
			expect(result.message).toContain('not initialized');
		});
	});

	describe('healthCheck', () => {
		it('should return healthy status', async () => {
			const health = await plugin.healthCheck();

			expect(health.status).toBe('healthy');
			expect(health.checkedAt).toBeDefined();
		});
	});

	describe('getManifest', () => {
		it('should return correct manifest', () => {
			const manifest = plugin.getManifest();

			expect(manifest.id).toBe('urlbox');
			expect(manifest.name).toBe('Urlbox');
			expect(manifest.version).toBe('1.0.0');
			expect(manifest.category).toBe('screenshot');
			expect(manifest.capabilities).toContain('screenshot');
			expect(manifest.builtIn).toBe(false);
			expect(manifest.systemPlugin).toBe(false);
		});

		it('should have icon configuration', () => {
			const manifest = plugin.getManifest();

			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('url');
			expect(manifest.icon?.value).toBe('https://urlbox.com/apple-touch-icon.png');
		});
	});
});
