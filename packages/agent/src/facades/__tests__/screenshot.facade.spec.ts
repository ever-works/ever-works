import { Test, TestingModule } from '@nestjs/testing';
import {
    ScreenshotFacadeService,
    NoScreenshotProviderError,
    ScreenshotProviderNotFoundError,
} from '../screenshot.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    IScreenshotPlugin,
    PluginManifest,
    ScreenshotCaptureResult,
} from '@ever-works/plugin';

describe('ScreenshotFacadeService', () => {
    let service: ScreenshotFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;

    const defaultFacadeOptions = { userId: 'test-user' };

    const createMockScreenshotPlugin = (id: string, providerName: string): IScreenshotPlugin => ({
        id,
        name: `${providerName} Plugin`,
        version: '1.0.0',
        category: 'screenshot',
        capabilities: ['screenshot'],
        settingsSchema: { type: 'object', properties: {} },
        providerName,
        onLoad: jest.fn(),
        onEnable: jest.fn(),
        onDisable: jest.fn(),
        onUnload: jest.fn(),
        validateSettings: jest.fn().mockResolvedValue({ valid: true }),
        capture: jest.fn().mockResolvedValue({
            success: true,
            imageUrl: 'https://screenshots.example.com/abc123.png',
            cacheUrl: 'https://cache.example.com/abc123.png',
        } as ScreenshotCaptureResult),
        isAvailable: jest.fn().mockResolvedValue(true),
        getScreenshotUrl: jest.fn().mockReturnValue('https://api.example.com/screenshot?url='),
    });

    const createRegisteredPlugin = (
        plugin: IScreenshotPlugin,
        manifest: Partial<PluginManifest>,
        state: RegisteredPlugin['state'] = 'enabled',
    ): RegisteredPlugin => ({
        plugin: plugin as any,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: 'Test plugin',
            category: plugin.category,
            capabilities: manifest.capabilities || plugin.capabilities,
            systemPlugin: manifest.systemPlugin,
            ...manifest,
        } as PluginManifest,
        state,
        builtIn: manifest.builtIn ?? false,
        stateHistory: [],
        registeredAt: Date.now(),
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ScreenshotFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: PluginSettingsService,
                    useValue: {
                        getSettings: jest.fn().mockResolvedValue({}),
                    },
                },
            ],
        }).compile();

        service = module.get<ScreenshotFacadeService>(ScreenshotFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('isAvailable', () => {
        it('should return true when screenshot plugin is enabled', () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isAvailable()).toBe(true);
        });

        it('should return false when no screenshot plugins exist', () => {
            registry.getByCapability.mockReturnValue([]);

            expect(service.isAvailable()).toBe(false);
        });

        it('should return false when screenshot plugin is not enabled', () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const registered = createRegisteredPlugin(
                screenshotPlugin,
                { capabilities: ['screenshot'] },
                'loaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isAvailable()).toBe(false);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of available screenshot providers', () => {
            const screenshotone = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const browserless = createMockScreenshotPlugin('browserless', 'Browserless');

            const screenshotoneRegistered = createRegisteredPlugin(screenshotone, {
                capabilities: ['screenshot'],
            });
            const browserlessRegistered = createRegisteredPlugin(
                browserless,
                { capabilities: ['screenshot'] },
                'loaded',
            );

            registry.getByCapability.mockReturnValue([
                screenshotoneRegistered,
                browserlessRegistered,
            ]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(2);
            expect(providers[0]).toEqual({
                id: 'screenshotone',
                name: 'ScreenshotOne',
                enabled: true,
            });
            expect(providers[1]).toEqual({
                id: 'browserless',
                name: 'Browserless',
                enabled: false,
            });
        });

        it('should return empty array when no providers exist', () => {
            registry.getByCapability.mockReturnValue([]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(0);
        });
    });

    describe('capture', () => {
        it('should capture screenshot using resolved provider', async () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.capture(
                { url: 'https://example.com' },
                defaultFacadeOptions,
            );

            expect(result.success).toBe(true);
            expect(result.imageUrl).toBe('https://screenshots.example.com/abc123.png');
            expect(screenshotPlugin.capture).toHaveBeenCalledWith(
                expect.objectContaining({ url: 'https://example.com' }),
            );
        });

        it('should throw NoScreenshotProviderError when no provider is configured', async () => {
            registry.getByCapability.mockReturnValue([]);

            await expect(
                service.capture({ url: 'https://example.com' }, defaultFacadeOptions),
            ).rejects.toThrow(NoScreenshotProviderError);
        });

        it('should throw ScreenshotProviderNotFoundError for invalid provider override', async () => {
            registry.get.mockReturnValue(undefined);

            await expect(
                service.capture(
                    { url: 'https://example.com' },
                    { userId: 'test-user', providerOverride: 'non-existent' },
                ),
            ).rejects.toThrow(ScreenshotProviderNotFoundError);
        });

        it('should use provider override when specified', async () => {
            const screenshotone = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const browserless = createMockScreenshotPlugin('browserless', 'Browserless');

            const screenshotoneRegistered = createRegisteredPlugin(screenshotone, {
                capabilities: ['screenshot'],
            });
            const browserlessRegistered = createRegisteredPlugin(browserless, {
                capabilities: ['screenshot'],
            });

            registry.getByCapability.mockReturnValue([
                screenshotoneRegistered,
                browserlessRegistered,
            ]);
            registry.get.mockReturnValue(browserlessRegistered);

            await service.capture(
                { url: 'https://example.com' },
                { userId: 'test-user', providerOverride: 'browserless' },
            );

            expect(browserless.capture).toHaveBeenCalled();
            expect(screenshotone.capture).not.toHaveBeenCalled();
        });

        it('should pass all capture options to the plugin', async () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            await service.capture(
                {
                    url: 'https://example.com',
                    viewportWidth: 1920,
                    viewportHeight: 1080,
                    format: 'jpg',
                    fullPage: true,
                    delay: 500,
                    blockAds: true,
                    blockTrackers: true,
                    blockCookieBanners: true,
                    cache: true,
                    cacheTtl: 3600,
                },
                defaultFacadeOptions,
            );

            expect(screenshotPlugin.capture).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://example.com',
                    viewportWidth: 1920,
                    viewportHeight: 1080,
                    format: 'jpg',
                    fullPage: true,
                    delay: 500,
                    blockAds: true,
                    blockTrackers: true,
                    blockCookieBanners: true,
                    cache: true,
                    cacheTtl: 3600,
                }),
            );
        });

        it('should return error when capture fails', async () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            (screenshotPlugin.capture as jest.Mock).mockResolvedValue({
                success: false,
                error: 'Failed to capture screenshot',
            });

            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.capture(
                { url: 'https://example.com' },
                defaultFacadeOptions,
            );

            expect(result.success).toBe(false);
            expect(result.error).toBe('Failed to capture screenshot');
        });
    });

    describe('getSmartImage', () => {
        it('should return smart image result with default capture settings', async () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const result = await service.getSmartImage(
                { url: 'https://example.com' },
                defaultFacadeOptions,
            );

            expect(result.primaryImage).toBe('https://cache.example.com/abc123.png');
            expect(result.source).toBe('screenshot');
        });

        it('should use default viewport and format settings', async () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            await service.getSmartImage({ url: 'https://example.com' }, defaultFacadeOptions);

            expect(screenshotPlugin.capture).toHaveBeenCalledWith(
                expect.objectContaining({
                    viewportWidth: 1280,
                    viewportHeight: 800,
                    format: 'png',
                    blockAds: true,
                    blockCookieBanners: true,
                    cache: true,
                }),
            );
        });

        it('should throw NoScreenshotProviderError when no provider exists', async () => {
            registry.getByCapability.mockReturnValue([]);

            await expect(
                service.getSmartImage({ url: 'https://example.com' }, defaultFacadeOptions),
            ).rejects.toThrow(NoScreenshotProviderError);
        });
    });

    describe('getScreenshotUrl', () => {
        it('should return pre-signed URL when plugin supports it', async () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const url = await service.getScreenshotUrl(
                { url: 'https://example.com' },
                defaultFacadeOptions,
            );

            expect(url).toBe('https://api.example.com/screenshot?url=');
        });

        it('should return null when plugin does not support getScreenshotUrl', async () => {
            const screenshotPlugin = createMockScreenshotPlugin('screenshotone', 'ScreenshotOne');
            delete (screenshotPlugin as any).getScreenshotUrl;

            const registered = createRegisteredPlugin(screenshotPlugin, {
                capabilities: ['screenshot'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            const url = await service.getScreenshotUrl(
                { url: 'https://example.com' },
                defaultFacadeOptions,
            );

            expect(url).toBeNull();
        });
    });
});
