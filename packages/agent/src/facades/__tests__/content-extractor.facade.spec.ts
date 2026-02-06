import { Test, TestingModule } from '@nestjs/testing';
import {
    ContentExtractorFacadeService,
    NoContentExtractorProviderError,
    ContentExtractorProviderNotFoundError,
} from '../content-extractor.facade';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import type {
    IContentExtractorPlugin,
    PluginManifest,
    ContentExtractionResult,
} from '@ever-works/plugin';

describe('ContentExtractorFacadeService', () => {
    let service: ContentExtractorFacadeService;
    let registry: jest.Mocked<PluginRegistryService>;
    let settingsService: jest.Mocked<PluginSettingsService>;

    const defaultFacadeOptions = { userId: 'test-user' };

    const createMockExtractorPlugin = (
        id: string,
        providerName: string,
        options?: {
            systemPlugin?: boolean;
            defaultForCapabilities?: string[];
            canExtractImpl?: (url: string) => Promise<boolean>;
        },
    ): IContentExtractorPlugin => ({
        id,
        name: `${providerName} Extractor`,
        version: '1.0.0',
        category: 'content-extractor',
        capabilities: ['content-extractor'],
        settingsSchema: { type: 'object', properties: {} },
        configurationMode: 'hybrid',
        providerName,
        onLoad: jest.fn(),
        onEnable: jest.fn(),
        onDisable: jest.fn(),
        onUnload: jest.fn(),
        validateSettings: jest.fn().mockResolvedValue({ valid: true }),
        extract: jest.fn().mockResolvedValue({
            success: true,
            url: 'https://example.com',
            content: `Content from ${providerName}`,
            markdown: `Markdown from ${providerName}`,
        } as ContentExtractionResult),
        canExtract: options?.canExtractImpl ?? jest.fn().mockResolvedValue(true),
        getSupportedFormats: jest.fn().mockReturnValue(['text', 'markdown']),
        isAvailable: jest.fn().mockResolvedValue(true),
    });

    const createRegisteredPlugin = (
        plugin: IContentExtractorPlugin,
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
            defaultForCapabilities: manifest.defaultForCapabilities,
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
                ContentExtractorFacadeService,
                {
                    provide: PluginRegistryService,
                    useValue: {
                        get: jest.fn(),
                        getByCapability: jest.fn().mockReturnValue([]),
                        getDefaultForCapability: jest.fn().mockReturnValue(undefined),
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

        service = module.get<ContentExtractorFacadeService>(ContentExtractorFacadeService);
        registry = module.get(PluginRegistryService);
        settingsService = module.get(PluginSettingsService);
    });

    describe('isConfigured', () => {
        it('should return true when any content extractor plugin is enabled', () => {
            const localExtractor = createMockExtractorPlugin('local-content-extractor', 'Local', {
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });
            const registered = createRegisteredPlugin(localExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(true);
        });

        it('should return false when no plugins exist', () => {
            registry.getByCapability.mockReturnValue([]);

            expect(service.isConfigured()).toBe(false);
        });

        it('should return false when plugins exist but are not enabled', () => {
            const localExtractor = createMockExtractorPlugin('local-content-extractor', 'Local', {
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });
            const registered = createRegisteredPlugin(
                localExtractor,
                {
                    capabilities: ['content-extractor'],
                    systemPlugin: true,
                    defaultForCapabilities: ['content-extractor'],
                },
                'loaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('extractContent - resolvePlugin', () => {
        it('should use explicit provider override when specified', async () => {
            const notionExtractor = createMockExtractorPlugin('notion-extractor', 'Notion');
            const registered = createRegisteredPlugin(notionExtractor, {
                capabilities: ['content-extractor'],
            });
            registry.get.mockReturnValue(registered);

            const result = await service.extractContent('https://notion.so/page', undefined, {
                userId: 'test-user',
                providerOverride: 'notion-extractor',
            });

            expect(registry.get).toHaveBeenCalledWith('notion-extractor');
            expect(notionExtractor.extract).toHaveBeenCalled();
            expect(result?.rawContent).toBe('Content from Notion');
        });

        it('should throw error when override plugin cannot extract URL', async () => {
            const notionExtractor = createMockExtractorPlugin('notion-extractor', 'Notion', {
                canExtractImpl: jest.fn().mockResolvedValue(false),
            });
            const registered = createRegisteredPlugin(notionExtractor, {
                capabilities: ['content-extractor'],
            });
            registry.get.mockReturnValue(registered);

            const result = await service.extractContent('https://github.com/repo', undefined, {
                userId: 'test-user',
                providerOverride: 'notion-extractor',
            });

            expect(result).toBeNull();
        });

        it('should throw error for non-existent provider override', async () => {
            registry.get.mockReturnValue(undefined);

            const result = await service.extractContent('https://example.com', undefined, {
                userId: 'test-user',
                providerOverride: 'non-existent',
            });

            expect(result).toBeNull();
        });

        it('should prefer non-system extractors over default', async () => {
            const notionExtractor = createMockExtractorPlugin('notion-extractor', 'Notion');
            const localExtractor = createMockExtractorPlugin('local-content-extractor', 'Local', {
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });

            const notionRegistered = createRegisteredPlugin(notionExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: false,
            });
            const localRegistered = createRegisteredPlugin(localExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });

            registry.getByCapability.mockReturnValue([localRegistered, notionRegistered]);

            await service.extractContent('https://notion.so/page', undefined, defaultFacadeOptions);

            expect(notionExtractor.extract).toHaveBeenCalled();
            expect(localExtractor.extract).not.toHaveBeenCalled();
        });

        it('should fall back to default extractor when non-system plugin cannot handle URL', async () => {
            const notionExtractor = createMockExtractorPlugin('notion-extractor', 'Notion', {
                canExtractImpl: jest.fn().mockResolvedValue(false),
            });
            const localExtractor = createMockExtractorPlugin('local-content-extractor', 'Local', {
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });

            const notionRegistered = createRegisteredPlugin(notionExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: false,
            });
            const localRegistered = createRegisteredPlugin(localExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });

            registry.getByCapability.mockReturnValue([notionRegistered, localRegistered]);
            registry.getDefaultForCapability.mockReturnValue(localRegistered);

            await service.extractContent('https://example.com', undefined, defaultFacadeOptions);

            expect(notionExtractor.canExtract).toHaveBeenCalled();
            expect(localExtractor.extract).toHaveBeenCalled();
        });

        it('should return null when no extractor can handle the URL', async () => {
            registry.getByCapability.mockReturnValue([]);

            const result = await service.extractContent(
                'https://example.com',
                undefined,
                defaultFacadeOptions,
            );

            expect(result).toBeNull();
        });

        it('should use first enabled non-system extractor that can handle URL', async () => {
            const githubExtractor = createMockExtractorPlugin('github-extractor', 'GitHub', {
                canExtractImpl: jest.fn().mockResolvedValue(false),
            });
            const notionExtractor = createMockExtractorPlugin('notion-extractor', 'Notion', {
                canExtractImpl: jest.fn().mockResolvedValue(true),
            });

            const githubRegistered = createRegisteredPlugin(githubExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: false,
            });
            const notionRegistered = createRegisteredPlugin(notionExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: false,
            });

            registry.getByCapability.mockReturnValue([githubRegistered, notionRegistered]);

            await service.extractContent('https://notion.so/page', undefined, defaultFacadeOptions);

            expect(githubExtractor.canExtract).toHaveBeenCalled();
            expect(githubExtractor.extract).not.toHaveBeenCalled();
            expect(notionExtractor.canExtract).toHaveBeenCalled();
            expect(notionExtractor.extract).toHaveBeenCalled();
        });
    });

    describe('getAvailableProviders', () => {
        it('should return list of all content extractor providers', () => {
            const notion = createMockExtractorPlugin('notion-extractor', 'Notion');
            const local = createMockExtractorPlugin('local-content-extractor', 'Local', {
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });

            const notionRegistered = createRegisteredPlugin(notion, {
                capabilities: ['content-extractor'],
            });
            const localRegistered = createRegisteredPlugin(
                local,
                {
                    capabilities: ['content-extractor'],
                    systemPlugin: true,
                    defaultForCapabilities: ['content-extractor'],
                },
                'enabled',
            );

            registry.getByCapability.mockReturnValue([notionRegistered, localRegistered]);

            const providers = service.getAvailableProviders();

            expect(providers).toHaveLength(2);
            expect(providers[0]).toEqual({
                id: 'notion-extractor',
                name: 'Notion',
                enabled: true,
            });
            expect(providers[1]).toEqual({
                id: 'local-content-extractor',
                name: 'Local',
                enabled: true,
            });
        });
    });
});
