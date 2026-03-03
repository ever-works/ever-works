import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreenshotOnePlugin } from '../screenshotone.plugin.js';
import type { PluginContext, ScreenshotOptions } from '@ever-works/plugin';

// Mock the screenshotone-api-sdk module
vi.mock('screenshotone-api-sdk', () => {
	const mockTakeOptions = {
		url: vi.fn().mockReturnThis(),
		viewportWidth: vi.fn().mockReturnThis(),
		viewportHeight: vi.fn().mockReturnThis(),
		format: vi.fn().mockReturnThis(),
		fullPage: vi.fn().mockReturnThis(),
		deviceScaleFactor: vi.fn().mockReturnThis(),
		blockAds: vi.fn().mockReturnThis(),
		blockTrackers: vi.fn().mockReturnThis(),
		blockCookieBanners: vi.fn().mockReturnThis(),
		delay: vi.fn().mockReturnThis(),
		cache: vi.fn().mockReturnThis(),
		cacheTtl: vi.fn().mockReturnThis(),
		selector: vi.fn().mockReturnThis(),
		userAgent: vi.fn().mockReturnThis()
	};

	return {
		Client: vi.fn().mockImplementation(() => ({
			take: vi.fn().mockResolvedValue({
				arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100))
			}),
			generateTakeURL: vi.fn().mockReturnValue('https://api.screenshotone.com/take?url=test'),
			generateSignedTakeURL: vi.fn().mockReturnValue('https://api.screenshotone.com/take?url=test&signature=abc')
		})),
		TakeOptions: {
			url: vi.fn().mockReturnValue(mockTakeOptions)
		}
	};
});

describe('ScreenshotOnePlugin', () => {
	let plugin: ScreenshotOnePlugin;
	let mockContext: PluginContext;

	beforeEach(() => {
		plugin = new ScreenshotOnePlugin();
		mockContext = {
			pluginId: 'screenshotone',
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
			expect(plugin.id).toBe('screenshotone');
			expect(plugin.name).toBe('ScreenshotOne');
			expect(plugin.version).toBe('1.0.0');
			expect(plugin.category).toBe('screenshot');
		});

		it('should have screenshot capability', () => {
			expect(plugin.capabilities).toContain('screenshot');
		});

		it('should have provider name', () => {
			expect(plugin.providerName).toBe('ScreenshotOne');
		});

		it('should have hybrid configuration mode', () => {
			expect(plugin.configurationMode).toBe('hybrid');
		});
	});

	describe('Settings Schema', () => {
		it('should define accessKey as required', () => {
			expect(plugin.settingsSchema.required).toContain('accessKey');
		});

		it('should mark accessKey as secret', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.accessKey['x-secret']).toBe(true);
		});

		it('should mark secretKey as secret', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.secretKey['x-secret']).toBe(true);
		});

		it('should have environment variable fallbacks', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.accessKey['x-envVar']).toBe('PLUGIN_SCREENSHOTONE_ACCESS_KEY');
			expect(properties.secretKey['x-envVar']).toBe('PLUGIN_SCREENSHOTONE_SECRET_KEY');
			expect(properties.viewportWidth['x-envVar']).toBe('PLUGIN_SCREENSHOTONE_VIEWPORT_WIDTH');
			expect(properties.viewportHeight['x-envVar']).toBe('PLUGIN_SCREENSHOTONE_VIEWPORT_HEIGHT');
			expect(properties.format['x-envVar']).toBe('PLUGIN_SCREENSHOTONE_FORMAT');
		});

		it('should have default values for viewport settings', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.viewportWidth.default).toBe(1280);
			expect(properties.viewportHeight.default).toBe(800);
		});

		it('should have default values for format and blocking options', () => {
			const properties = plugin.settingsSchema.properties as Record<string, any>;
			expect(properties.format.default).toBe('png');
			expect(properties.fullPage.default).toBe(false);
			expect(properties.blockAds.default).toBe(true);
			expect(properties.blockTrackers.default).toBe(true);
		});
	});

	describe('IScreenshotPlugin - capture', () => {
		it('should capture screenshot successfully with settings', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {
					accessKey: 'test-access-key',
					secretKey: 'test-secret-key'
				}
			};

			const result = await plugin.capture(options);

			expect(result.success).toBe(true);
			expect(result.imageBuffer).toBeDefined();
			expect(result.imageBase64).toBeDefined();
			expect(result.imageUrl).toBeDefined();
		});

		it('should fail when access key is not configured', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {}
			};

			const result = await plugin.capture(options);

			expect(result.success).toBe(false);
			expect(result.error).toContain('access key not configured');
		});

		it('should use provided viewport dimensions', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				viewportWidth: 1920,
				viewportHeight: 1080,
				settings: {
					accessKey: 'test-key'
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
					accessKey: 'test-key'
				}
			};

			const url = await plugin.getScreenshotUrl(options);

			expect(url).toBeDefined();
			expect(url).toContain('api.screenshotone.com');
		});

		it('should generate signed URL when secret key is available', async () => {
			await plugin.onLoad(mockContext);

			const options: ScreenshotOptions = {
				url: 'https://example.com',
				settings: {
					accessKey: 'test-key',
					secretKey: 'test-secret'
				}
			};

			const url = await plugin.getScreenshotUrl(options);

			expect(url).toBeDefined();
			expect(url).toContain('signature');
		});

		it('should return null when access key is missing', async () => {
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
		it('should return true', async () => {
			const available = await plugin.isAvailable();
			expect(available).toBe(true);
		});
	});

	describe('IScreenshotPlugin - validateCredentials', () => {
		it('should return invalid when plugin not initialized', async () => {
			const result = await plugin.validateCredentials();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('not initialized');
		});

		it('should return invalid when access key not configured', async () => {
			vi.mocked(mockContext.getSettings).mockResolvedValue({});
			await plugin.onLoad(mockContext);

			const result = await plugin.validateCredentials();

			expect(result.valid).toBe(false);
			expect(result.message).toContain('Access key is not configured');
		});

		it('should return valid when credentials are configured', async () => {
			vi.mocked(mockContext.getSettings).mockResolvedValue({
				accessKey: 'test-key'
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
			expect(mockContext.logger.log).toHaveBeenCalledWith('ScreenshotOne Plugin loaded');
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

			expect(manifest.id).toBe('screenshotone');
			expect(manifest.name).toBe('ScreenshotOne');
			expect(manifest.version).toBe('1.0.0');
			expect(manifest.category).toBe('screenshot');
			expect(manifest.capabilities).toContain('screenshot');
			expect(manifest.builtIn).toBe(false);
			expect(manifest.systemPlugin).toBe(false);
		});

		it('should have icon configuration', () => {
			const manifest = plugin.getManifest();

			expect(manifest.icon).toBeDefined();
			expect(manifest.icon?.type).toBe('lucide');
			expect(manifest.icon?.value).toBe('Camera');
			expect(manifest.icon?.backgroundColor).toBe('#4f46e5');
		});
	});
});
