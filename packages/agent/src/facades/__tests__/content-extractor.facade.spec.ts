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
            settingsSchema?: IContentExtractorPlugin['settingsSchema'];
        },
    ): IContentExtractorPlugin => ({
        id,
        name: `${providerName} Extractor`,
        version: '1.0.0',
        category: 'content-extractor',
        capabilities: ['content-extractor'],
        settingsSchema: options?.settingsSchema ?? { type: 'object', properties: {} },
        configurationMode: 'hybrid',
        providerName,
        onLoad: jest.fn(),
        onUnload: jest.fn(),
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
        state: RegisteredPlugin['state'] = 'loaded',
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
                'unloaded',
            );
            registry.getByCapability.mockReturnValue([registered]);

            expect(service.isConfigured()).toBe(false);
        });
    });

    describe('extractContent - supplementary plugins (tier 0)', () => {
        it('should use supplementary plugin before provider override when canExtract matches', async () => {
            const pdfExtractor = createMockExtractorPlugin('pdf-extractor', 'PDF', {
                canExtractImpl: jest
                    .fn()
                    .mockImplementation((url: string) => Promise.resolve(url.endsWith('.pdf'))),
            });
            const tavilyExtractor = createMockExtractorPlugin('tavily', 'Tavily', {
                canExtractImpl: jest.fn().mockResolvedValue(true),
            });

            const pdfRegistered = createRegisteredPlugin(pdfExtractor, {
                capabilities: ['content-extractor'],
                supplementary: true,
            });
            const tavilyRegistered = createRegisteredPlugin(tavilyExtractor, {
                capabilities: ['content-extractor'],
            });

            registry.getByCapability.mockReturnValue([pdfRegistered, tavilyRegistered]);
            registry.get.mockReturnValue(tavilyRegistered);

            await service.extractContent('https://example.com/doc.pdf', undefined, {
                userId: 'test-user',
                providerOverride: 'tavily',
            });

            // PDF extractor should win even though Tavily was the override
            expect(pdfExtractor.extract).toHaveBeenCalled();
            expect(tavilyExtractor.extract).not.toHaveBeenCalled();
        });

        it('should fall through to override when supplementary canExtract returns false', async () => {
            const pdfExtractor = createMockExtractorPlugin('pdf-extractor', 'PDF', {
                canExtractImpl: jest.fn().mockResolvedValue(false),
            });
            const tavilyExtractor = createMockExtractorPlugin('tavily', 'Tavily', {
                canExtractImpl: jest.fn().mockResolvedValue(true),
            });

            const pdfRegistered = createRegisteredPlugin(pdfExtractor, {
                capabilities: ['content-extractor'],
                supplementary: true,
            });
            const tavilyRegistered = createRegisteredPlugin(tavilyExtractor, {
                capabilities: ['content-extractor'],
            });

            registry.getByCapability.mockReturnValue([pdfRegistered, tavilyRegistered]);
            registry.get.mockReturnValue(tavilyRegistered);

            await service.extractContent('https://example.com/page', undefined, {
                userId: 'test-user',
                providerOverride: 'tavily',
            });

            expect(pdfExtractor.extract).not.toHaveBeenCalled();
            expect(tavilyExtractor.extract).toHaveBeenCalled();
        });

        it('should skip supplementary plugin when disabled for scope', async () => {
            const pdfExtractor = createMockExtractorPlugin('pdf-extractor', 'PDF', {
                canExtractImpl: jest.fn().mockResolvedValue(true),
            });
            const tavilyExtractor = createMockExtractorPlugin('tavily', 'Tavily', {
                canExtractImpl: jest.fn().mockResolvedValue(true),
            });

            const pdfRegistered = createRegisteredPlugin(pdfExtractor, {
                capabilities: ['content-extractor'],
                supplementary: true,
            });
            const tavilyRegistered = createRegisteredPlugin(tavilyExtractor, {
                capabilities: ['content-extractor'],
            });

            registry.getByCapability.mockReturnValue([pdfRegistered, tavilyRegistered]);
            registry.get.mockReturnValue(tavilyRegistered);
            // PDF extractor disabled for this work
            registry.isPluginEnabledForScope.mockImplementation((id) =>
                Promise.resolve(id !== 'pdf-extractor'),
            );

            await service.extractContent('https://example.com/doc.pdf', undefined, {
                userId: 'test-user',
                workId: 'dir-1',
                providerOverride: 'tavily',
            });

            expect(pdfExtractor.extract).not.toHaveBeenCalled();
            expect(tavilyExtractor.extract).toHaveBeenCalled();
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

        it('should support provider override from facade extraction options', async () => {
            const jinaExtractor = createMockExtractorPlugin('jina', 'Jina');
            const registered = createRegisteredPlugin(jinaExtractor, {
                capabilities: ['content-extractor'],
            });
            registry.get.mockReturnValue(registered);

            const result = await service.extractContent(
                'https://example.com',
                { providerOverride: 'jina' },
                defaultFacadeOptions,
            );

            expect(registry.get).toHaveBeenCalledWith('jina');
            expect(jinaExtractor.extract).toHaveBeenCalled();
            expect(result?.rawContent).toBe('Content from Jina');
        });

        it('should prefer facade provider override over extraction option override', async () => {
            const jinaExtractor = createMockExtractorPlugin('jina', 'Jina');
            const firecrawlExtractor = createMockExtractorPlugin('firecrawl', 'Firecrawl');

            registry.get.mockImplementation((id) => {
                if (id === 'jina') {
                    return createRegisteredPlugin(jinaExtractor, {
                        capabilities: ['content-extractor'],
                    });
                }
                if (id === 'firecrawl') {
                    return createRegisteredPlugin(firecrawlExtractor, {
                        capabilities: ['content-extractor'],
                    });
                }
                return undefined;
            });

            const result = await service.extractContent(
                'https://example.com',
                { providerOverride: 'jina' },
                { ...defaultFacadeOptions, providerOverride: 'firecrawl' },
            );

            expect(firecrawlExtractor.extract).toHaveBeenCalled();
            expect(jinaExtractor.extract).not.toHaveBeenCalled();
            expect(result?.rawContent).toBe('Content from Firecrawl');
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

        it('should skip enabled extractors missing required settings', async () => {
            const firecrawlExtractor = createMockExtractorPlugin('firecrawl', 'Firecrawl', {
                settingsSchema: {
                    type: 'object',
                    required: ['apiKey'],
                    properties: { apiKey: { type: 'string' } },
                },
            });
            const localExtractor = createMockExtractorPlugin('local-content-extractor', 'Local', {
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });

            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(firecrawlExtractor, {
                    capabilities: ['content-extractor'],
                    systemPlugin: false,
                }),
                createRegisteredPlugin(localExtractor, {
                    capabilities: ['content-extractor'],
                    systemPlugin: true,
                    defaultForCapabilities: ['content-extractor'],
                }),
            ]);
            settingsService.getSettings
                .mockResolvedValueOnce({ apiKey: '' })
                .mockResolvedValueOnce({});

            const result = await service.extractContent(
                'https://example.com',
                undefined,
                defaultFacadeOptions,
            );

            expect(firecrawlExtractor.extract).not.toHaveBeenCalled();
            expect(localExtractor.extract).toHaveBeenCalled();
            expect(result?.extraction?.providerId).toBe('local-content-extractor');
        });

        it('should fall back when the preferred extractor returns a failure result', async () => {
            const jinaExtractor = createMockExtractorPlugin('jina', 'Jina');
            const firecrawlExtractor = createMockExtractorPlugin('firecrawl', 'Firecrawl');

            (jinaExtractor.extract as jest.Mock).mockResolvedValue({
                success: false,
                url: 'https://example.com',
                error: 'blocked',
            } as ContentExtractionResult);

            const jinaRegistered = createRegisteredPlugin(jinaExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: false,
            });
            const firecrawlRegistered = createRegisteredPlugin(firecrawlExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: false,
            });

            registry.getByCapability.mockReturnValue([jinaRegistered, firecrawlRegistered]);

            const result = await service.extractContent(
                'https://example.com',
                undefined,
                defaultFacadeOptions,
            );

            expect(jinaExtractor.extract).toHaveBeenCalled();
            expect(firecrawlExtractor.extract).toHaveBeenCalled();
            expect(result?.rawContent).toBe('Content from Firecrawl');
            expect(result?.extraction?.providerId).toBe('firecrawl');
            expect(result?.extraction?.attempts).toEqual([
                expect.objectContaining({ providerId: 'jina', success: false, error: 'blocked' }),
                expect.objectContaining({ providerId: 'firecrawl', success: true }),
            ]);
        });

        it('should fall back when the preferred extractor returns empty content', async () => {
            const localExtractor = createMockExtractorPlugin('local-content-extractor', 'Local', {
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });
            const scrapflyExtractor = createMockExtractorPlugin('scrapfly', 'Scrapfly');

            (scrapflyExtractor.extract as jest.Mock).mockResolvedValue({
                success: true,
                url: 'https://example.com',
                content: '',
                markdown: '',
            } as ContentExtractionResult);

            const scrapflyRegistered = createRegisteredPlugin(scrapflyExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: false,
            });
            const localRegistered = createRegisteredPlugin(localExtractor, {
                capabilities: ['content-extractor'],
                systemPlugin: true,
                defaultForCapabilities: ['content-extractor'],
            });

            registry.getByCapability.mockReturnValue([scrapflyRegistered, localRegistered]);
            registry.getDefaultForCapability.mockReturnValue(localRegistered);

            const result = await service.extractContent(
                'https://example.com',
                undefined,
                defaultFacadeOptions,
            );

            expect(scrapflyExtractor.extract).toHaveBeenCalled();
            expect(localExtractor.extract).toHaveBeenCalled();
            expect(result?.rawContent).toBe('Content from Local');
            expect(result?.extraction?.attempts[0]).toEqual(
                expect.objectContaining({
                    providerId: 'scrapfly',
                    success: false,
                    error: 'empty content',
                }),
            );
        });

        it('should return diagnostics when all extractors fail', async () => {
            const jinaExtractor = createMockExtractorPlugin('jina', 'Jina');
            const firecrawlExtractor = createMockExtractorPlugin('firecrawl', 'Firecrawl');

            (jinaExtractor.extract as jest.Mock).mockResolvedValue({
                success: false,
                url: 'https://example.com',
                error: 'blocked',
            } as ContentExtractionResult);
            (firecrawlExtractor.extract as jest.Mock).mockResolvedValue({
                success: false,
                url: 'https://example.com',
                error: 'timeout',
            } as ContentExtractionResult);

            registry.getByCapability.mockReturnValue([
                createRegisteredPlugin(jinaExtractor, {
                    capabilities: ['content-extractor'],
                    systemPlugin: false,
                }),
                createRegisteredPlugin(firecrawlExtractor, {
                    capabilities: ['content-extractor'],
                    systemPlugin: false,
                }),
            ]);

            const result = await service.extractContentWithDiagnostics(
                'https://example.com',
                undefined,
                defaultFacadeOptions,
            );

            expect(result.content).toBeNull();
            expect(result.error).toBe('Processing failed for URL: https://example.com');
            expect(result.attempts).toEqual([
                expect.objectContaining({ providerId: 'jina', success: false, error: 'blocked' }),
                expect.objectContaining({
                    providerId: 'firecrawl',
                    success: false,
                    error: 'timeout',
                }),
            ]);
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
                'loaded',
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
