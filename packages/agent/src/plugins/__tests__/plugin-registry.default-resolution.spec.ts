import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginRegistryService } from '../services/plugin-registry.service';
import type { IPlugin, PluginManifest, PluginCategory } from '@ever-works/plugin';

describe('PluginRegistryService - Default Resolution', () => {
    let service: PluginRegistryService;

    interface MockPluginOptions {
        id: string;
        category?: PluginCategory;
        capabilities?: string[];
        defaultForCapabilities?: string[];
    }

    const createMockPlugin = (options: MockPluginOptions): IPlugin =>
        ({
            id: options.id,
            name: `Plugin ${options.id}`,
            version: '1.0.0',
            category: options.category || 'utility',
            capabilities: options.capabilities || ['test-capability'],
            settingsSchema: { type: 'object', properties: {} },
            configurationMode: 'hybrid',
            onLoad: jest.fn(),
            onUnload: jest.fn(),
        }) as unknown as IPlugin;

    const createMockManifest = (options: MockPluginOptions): PluginManifest => ({
        id: options.id,
        name: `Plugin ${options.id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category: options.category || 'utility',
        capabilities: options.capabilities || ['test-capability'],
        defaultForCapabilities: options.defaultForCapabilities,
    });

    const registerAndEnable = (options: MockPluginOptions): void => {
        const plugin = createMockPlugin(options);
        const manifest = createMockManifest(options);
        service.register(plugin, manifest);
        service.updateState(options.id, 'loaded');
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PluginRegistryService,
                {
                    provide: EventEmitter2,
                    useValue: {
                        emit: jest.fn(),
                        on: jest.fn(),
                        off: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<PluginRegistryService>(PluginRegistryService);
    });

    afterEach(() => {
        service.clear();
    });

    describe('getDefaultForCapability', () => {
        describe('Basic Resolution', () => {
            it('should resolve plugin with explicit defaultForCapabilities', () => {
                registerAndEnable({
                    id: 'tavily',
                    capabilities: ['search', 'content-extractor'],
                    defaultForCapabilities: ['search'],
                });

                const result = service.getDefaultForCapability('search');

                expect(result?.plugin.id).toBe('tavily');
            });

            it('should NOT resolve plugin for capability not in defaultForCapabilities', () => {
                registerAndEnable({
                    id: 'tavily',
                    capabilities: ['search', 'content-extractor'],
                    defaultForCapabilities: ['search'],
                });

                const result = service.getDefaultForCapability('content-extractor');

                expect(result).toBeUndefined();
            });

            it('should return undefined when no default configured', () => {
                registerAndEnable({
                    id: 'basic-search',
                    capabilities: ['search'],
                });

                const result = service.getDefaultForCapability('search');

                expect(result).toBeUndefined();
            });
        });

        describe('Multi-Capability Plugins', () => {
            it('should allow plugin to be default for multiple capabilities', () => {
                registerAndEnable({
                    id: 'multi-plugin',
                    capabilities: ['search', 'content-extractor'],
                    defaultForCapabilities: ['search', 'content-extractor'],
                });

                expect(service.getDefaultForCapability('search')?.plugin.id).toBe('multi-plugin');
                expect(service.getDefaultForCapability('content-extractor')?.plugin.id).toBe(
                    'multi-plugin',
                );
            });

            it('should allow plugin to be default for subset of capabilities', () => {
                registerAndEnable({
                    id: 'tavily',
                    capabilities: ['search', 'content-extractor'],
                    defaultForCapabilities: ['search'],
                });

                expect(service.getDefaultForCapability('search')?.plugin.id).toBe('tavily');
                expect(service.getDefaultForCapability('content-extractor')).toBeUndefined();
            });

            it('should resolve different defaults for different capabilities', () => {
                registerAndEnable({
                    id: 'tavily',
                    capabilities: ['search', 'content-extractor'],
                    defaultForCapabilities: ['search'],
                });

                registerAndEnable({
                    id: 'local-content-extractor',
                    capabilities: ['content-extractor'],
                    defaultForCapabilities: ['content-extractor'],
                });

                expect(service.getDefaultForCapability('search')?.plugin.id).toBe('tavily');
                expect(service.getDefaultForCapability('content-extractor')?.plugin.id).toBe(
                    'local-content-extractor',
                );
            });
        });

        describe('Edge Cases', () => {
            it('should skip disabled plugins', () => {
                const disabledPlugin = createMockPlugin({
                    id: 'disabled-default',
                    capabilities: ['search'],
                    defaultForCapabilities: ['search'],
                });
                const disabledManifest = createMockManifest({
                    id: 'disabled-default',
                    capabilities: ['search'],
                    defaultForCapabilities: ['search'],
                });
                service.register(disabledPlugin, disabledManifest);

                registerAndEnable({
                    id: 'enabled-no-default',
                    capabilities: ['search'],
                });

                const result = service.getDefaultForCapability('search');

                expect(result).toBeUndefined();
            });

            it('should use first registered when multiple claim default', () => {
                registerAndEnable({
                    id: 'first-search',
                    capabilities: ['search'],
                    defaultForCapabilities: ['search'],
                });

                registerAndEnable({
                    id: 'second-search',
                    capabilities: ['search'],
                    defaultForCapabilities: ['search'],
                });

                const result = service.getDefaultForCapability('search');

                expect(result?.plugin.id).toBe('first-search');
            });

            it('should handle empty defaultForCapabilities array', () => {
                registerAndEnable({
                    id: 'no-defaults',
                    capabilities: ['search'],
                    defaultForCapabilities: [],
                });

                const result = service.getDefaultForCapability('search');

                expect(result).toBeUndefined();
            });

            it('should ignore defaultForCapabilities not in capabilities', () => {
                registerAndEnable({
                    id: 'invalid-default',
                    capabilities: ['search'],
                    defaultForCapabilities: ['content-extractor'],
                });

                expect(service.getDefaultForCapability('content-extractor')).toBeUndefined();
            });

            it('should return undefined for non-existent capability', () => {
                registerAndEnable({
                    id: 'test-plugin',
                    capabilities: ['search'],
                    defaultForCapabilities: ['search'],
                });

                const result = service.getDefaultForCapability('non-existent-capability');

                expect(result).toBeUndefined();
            });
        });
    });
});
