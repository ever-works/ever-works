import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { PluginClassValidatorService } from '../services/plugin-class-validator.service';
import type { IPlugin, PluginManifest, PluginCategory } from '@ever-works/plugin';

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

describe('PluginClassValidatorService', () => {
    let service: PluginClassValidatorService;

    const createValidPlugin = (overrides?: Partial<IPlugin>): IPlugin =>
        ({
            id: 'test-plugin',
            name: 'Test Plugin',
            version: '1.0.0',
            category: 'utility' as PluginCategory,
            capabilities: ['test'],
            settingsSchema: { type: 'object', properties: {} },
            configurationMode: 'hybrid',
            onLoad: jest.fn().mockResolvedValue(undefined),
            onUnload: jest.fn().mockResolvedValue(undefined),
            validateSettings: jest.fn().mockResolvedValue({ valid: true }),
            ...overrides,
        }) as unknown as IPlugin;

    const createMockManifest = (
        id: string = 'test-plugin',
        category: PluginCategory = 'utility',
    ): PluginManifest => ({
        id,
        name: `Plugin ${id}`,
        version: '1.0.0',
        description: 'Test plugin',
        category,
        capabilities: ['test'],
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [PluginClassValidatorService],
        }).compile();

        service = module.get<PluginClassValidatorService>(PluginClassValidatorService);
    });

    describe('validatePlugin', () => {
        it('should validate a valid plugin instance', () => {
            const plugin = createValidPlugin();

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(true);
            expect(result.errors).toBeUndefined();
        });

        it('should reject null or undefined', () => {
            const result = service.validatePlugin(null);

            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
            expect(result.errors?.some((e) => e.message.includes('object or class'))).toBe(true);
        });

        it('should reject non-objects', () => {
            const result = service.validatePlugin('not-an-object');

            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
        });

        it('should reject plugin without required id property', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).id;

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'id')).toBe(true);
        });

        it('should reject plugin without required name property', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).name;

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'name')).toBe(true);
        });

        it('should reject plugin without required version property', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).version;

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'version')).toBe(true);
        });

        it('should reject plugin without required category property', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).category;

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'category')).toBe(true);
        });

        it('should reject plugin without capabilities array', () => {
            const plugin = createValidPlugin();
            (plugin as any).capabilities = 'not-an-array';

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'capabilities')).toBe(true);
        });

        it('should reject plugin without onLoad method', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).onLoad;

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'onLoad')).toBe(true);
        });

        it('should reject plugin without onUnload method', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).onUnload;

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'onUnload')).toBe(true);
        });

        it('should reject plugin without validateSettings method', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).validateSettings;

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'validateSettings')).toBe(true);
        });

        it('should warn about invalid healthCheck when defined', () => {
            const plugin = createValidPlugin();
            (plugin as any).healthCheck = 'not-a-function';

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(true);
            expect(result.warnings).toBeDefined();
            expect(result.warnings?.some((w) => w.path === 'healthCheck')).toBe(true);
        });

        it('should warn about invalid getManifest when defined', () => {
            const plugin = createValidPlugin();
            (plugin as any).getManifest = 'not-a-function';

            const result = service.validatePlugin(plugin);

            expect(result.valid).toBe(true);
            expect(result.warnings).toBeDefined();
            expect(result.warnings?.some((w) => w.path === 'getManifest')).toBe(true);
        });

        it('should validate a plugin class prototype', () => {
            class TestPlugin {
                id = 'test-plugin';
                name = 'Test Plugin';
                version = '1.0.0';
                category = 'utility';
                capabilities = ['test'];
                onLoad() {}
                onUnload() {}
                validateSettings() {
                    return { valid: true };
                }
            }

            const result = service.validatePlugin(TestPlugin);

            // Class prototypes don't have instance properties, but should have methods
            expect(result.valid).toBe(true);
        });
    });

    describe('validateCapabilities', () => {
        it('should validate git-provider capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['git-provider'],
            }) as any;
            plugin.providerName = 'github';
            plugin.getAuth = jest.fn();
            plugin.getCloneUrl = jest.fn();
            plugin.getWebUrl = jest.fn();
            plugin.createRepository = jest.fn();
            plugin.getRepository = jest.fn();
            plugin.deleteRepository = jest.fn();
            plugin.getUser = jest.fn();
            plugin.getOrganizations = jest.fn();
            plugin.listBranches = jest.fn();
            plugin.createPullRequest = jest.fn();
            plugin.mergePullRequest = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should fail when git-provider methods are missing', () => {
            const plugin = createValidPlugin({
                capabilities: ['git-provider'],
            });

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.message.includes('getAuth'))).toBe(true);
        });

        it('should fail when git-provider property is missing', () => {
            const plugin = createValidPlugin({
                capabilities: ['git-provider'],
            }) as any;
            plugin.getAuth = jest.fn();
            plugin.getCloneUrl = jest.fn();
            plugin.getWebUrl = jest.fn();
            plugin.createRepository = jest.fn();
            plugin.getRepository = jest.fn();
            plugin.deleteRepository = jest.fn();
            plugin.getUser = jest.fn();
            plugin.getOrganizations = jest.fn();
            plugin.listBranches = jest.fn();
            plugin.createPullRequest = jest.fn();
            plugin.mergePullRequest = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.message.includes('providerName'))).toBe(true);
        });

        it('should validate oauth capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['oauth'],
            }) as any;
            plugin.getAuthorizationUrl = jest.fn();
            plugin.exchangeCodeForToken = jest.fn();
            plugin.getAuthenticatedUser = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate deployment capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['deployment'],
            }) as any;
            plugin.providerName = 'vercel';
            plugin.deploy = jest.fn();
            plugin.getDeploymentStatus = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate screenshot capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['screenshot'],
            }) as any;
            plugin.providerName = 'screenshotone';
            plugin.capture = jest.fn();
            plugin.isAvailable = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate search capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['search'],
            }) as any;
            plugin.providerName = 'tavily';
            plugin.search = jest.fn();
            plugin.isAvailable = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate content-extractor capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['content-extractor'],
            }) as any;
            plugin.providerName = 'firecrawl';
            plugin.extract = jest.fn();
            plugin.isAvailable = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate data-source capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['data-source'],
            }) as any;
            plugin.sourceName = 'csv';
            plugin.query = jest.fn();
            plugin.isAvailable = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate ai-provider capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['ai-provider'],
            }) as any;
            plugin.providerType = 'openai';
            plugin.providerName = 'OpenAI';
            plugin.createChatCompletion = jest.fn();
            plugin.listModels = jest.fn();
            plugin.getModel = jest.fn();
            plugin.isAvailable = jest.fn();
            plugin.getCapabilities = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should fail when ai-provider properties are missing', () => {
            const plugin = createValidPlugin({
                capabilities: ['ai-provider'],
            }) as any;
            plugin.createChatCompletion = jest.fn();
            plugin.listModels = jest.fn();
            plugin.getModel = jest.fn();
            plugin.isAvailable = jest.fn();
            plugin.getCapabilities = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.message.includes('providerType'))).toBe(true);
        });

        it('should validate pipeline-modifier capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['pipeline-modifier'],
            }) as any;
            plugin.execute = jest.fn();
            plugin.getStepDefinition = jest.fn();
            plugin.targetPipelines = ['standard-pipeline'];

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate pipeline capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['pipeline'],
            }) as any;
            plugin.execute = jest.fn();
            plugin.getStepDefinitions = jest.fn();
            plugin.createExecutionPlan = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate form-field capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['form-field'],
            }) as any;
            plugin.fieldType = 'custom-input';
            plugin.getRegistration = jest.fn();
            plugin.validate = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate sub-provider capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['sub-provider'],
            }) as any;
            plugin.parentCapability = 'ai-provider';
            plugin.subProviderId = 'gpt-4';
            plugin.getRegistration = jest.fn();
            plugin.canHandle = jest.fn();
            plugin.getPriority = jest.fn();
            plugin.isAvailable = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate config-aware capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['config-aware'],
            }) as any;
            plugin.onConfigurationChange = jest.fn();
            plugin.getEffectiveConfig = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should validate form-schema-provider capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['form-schema-provider'],
            }) as any;
            plugin.getFormFields = jest.fn();
            plugin.validateFormInput = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should fail when pipeline-modifier methods are missing', () => {
            const plugin = createValidPlugin({
                capabilities: ['pipeline-modifier'],
            }) as any;
            plugin.targetPipelines = ['standard-pipeline'];

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.message.includes('execute'))).toBe(true);
        });

        it('should fail when pipeline-modifier targetPipelines is missing', () => {
            const plugin = createValidPlugin({
                capabilities: ['pipeline-modifier'],
            }) as any;
            plugin.execute = jest.fn();
            plugin.getStepDefinition = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.message.includes('targetPipelines'))).toBe(true);
        });

        it('should validate custom-capability capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['custom-capability'],
            }) as any;
            plugin.getCustomCapabilities = jest.fn();
            plugin.getCapabilityImplementation = jest.fn();
            plugin.hasCapability = jest.fn();
            plugin.getCapabilityVersion = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });

        it('should warn for unknown capability', () => {
            const plugin = createValidPlugin({
                capabilities: ['unknown-capability' as any],
            });

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
            expect(result.warnings).toBeDefined();
            expect(result.warnings?.some((w) => w.message.includes('Unknown capability'))).toBe(
                true,
            );
        });

        it('should validate multiple capabilities', () => {
            const plugin = createValidPlugin({
                capabilities: ['screenshot', 'search'],
            }) as any;
            plugin.providerName = 'multi-provider';
            plugin.capture = jest.fn();
            plugin.search = jest.fn();
            plugin.isAvailable = jest.fn();

            const result = service.validateCapabilities(plugin);

            expect(result.valid).toBe(true);
        });
    });

    describe('validateAgainstManifest', () => {
        it('should pass when plugin matches manifest', () => {
            const plugin = createValidPlugin();
            const manifest = createMockManifest();

            const result = service.validateAgainstManifest(plugin, manifest);

            expect(result.valid).toBe(true);
        });

        it('should fail when plugin ID does not match manifest', () => {
            const plugin = createValidPlugin({ id: 'wrong-id' });
            const manifest = createMockManifest('correct-id');

            const result = service.validateAgainstManifest(plugin, manifest);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'id')).toBe(true);
        });

        it('should warn when version does not match', () => {
            const plugin = createValidPlugin({ version: '2.0.0' });
            const manifest: PluginManifest = {
                ...createMockManifest(),
                version: '1.0.0',
            };

            const result = service.validateAgainstManifest(plugin, manifest);

            expect(result.valid).toBe(true);
            expect(result.warnings?.some((w) => w.path === 'version')).toBe(true);
        });

        it('should fail when category does not match', () => {
            const plugin = createValidPlugin({ category: 'integration' as PluginCategory });
            const manifest = createMockManifest('test-plugin', 'utility');

            const result = service.validateAgainstManifest(plugin, manifest);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'category')).toBe(true);
        });

        it('should fail when plugin is missing a capability declared in manifest', () => {
            const plugin = createValidPlugin({ capabilities: [] });
            const manifest: PluginManifest = {
                ...createMockManifest(),
                capabilities: ['test'],
            };

            const result = service.validateAgainstManifest(plugin, manifest);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'capabilities')).toBe(true);
        });

        it('should warn when plugin has capability not in manifest', () => {
            const plugin = createValidPlugin({ capabilities: ['test', 'extra'] });
            const manifest: PluginManifest = {
                ...createMockManifest(),
                capabilities: ['test'],
            };

            const result = service.validateAgainstManifest(plugin, manifest);

            expect(result.valid).toBe(true);
            expect(result.warnings?.some((w) => w.path === 'capabilities')).toBe(true);
        });
    });

    describe('validate', () => {
        it('should perform full validation', () => {
            const plugin = createValidPlugin();
            const manifest = createMockManifest();

            const result = service.validate(plugin, manifest);

            expect(result.valid).toBe(true);
        });

        it('should fail on plugin validation', () => {
            const plugin = {};

            const result = service.validate(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors).toBeDefined();
        });

        it('should fail on capability validation', () => {
            const plugin = createValidPlugin({ capabilities: ['git-provider'] });

            const result = service.validate(plugin);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.message.includes('git-provider'))).toBe(true);
        });

        it('should fail on manifest validation', () => {
            const plugin = createValidPlugin({ id: 'wrong-id' });
            const manifest = createMockManifest('correct-id');

            const result = service.validate(plugin, manifest);

            expect(result.valid).toBe(false);
            expect(result.errors?.some((e) => e.path === 'id')).toBe(true);
        });

        it('should aggregate all warnings', () => {
            const plugin = createValidPlugin({
                version: '2.0.0',
                capabilities: ['test', 'unknown-cap' as any],
            }) as any;
            plugin.healthCheck = 'invalid';

            const manifest: PluginManifest = {
                ...createMockManifest(),
                version: '1.0.0',
                capabilities: ['test'],
            };

            const result = service.validate(plugin, manifest);

            expect(result.valid).toBe(true);
            expect(result.warnings).toBeDefined();
            expect(result.warnings!.length).toBeGreaterThan(1);
        });
    });

    describe('isPlugin', () => {
        it('should return true for valid plugin', () => {
            const plugin = createValidPlugin();

            expect(service.isPlugin(plugin)).toBe(true);
        });

        it('should return false for null', () => {
            expect(service.isPlugin(null)).toBe(false);
        });

        it('should return false for undefined', () => {
            expect(service.isPlugin(undefined)).toBe(false);
        });

        it('should return false for string', () => {
            expect(service.isPlugin('not-a-plugin')).toBe(false);
        });

        it('should return false for incomplete plugin', () => {
            const incomplete = {
                id: 'test',
                name: 'Test',
                // missing required fields
            };

            expect(service.isPlugin(incomplete)).toBe(false);
        });

        it('should return false when onLoad is missing', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).onLoad;

            expect(service.isPlugin(plugin)).toBe(false);
        });

        it('should return false when validateSettings is missing', () => {
            const plugin = createValidPlugin();
            delete (plugin as any).validateSettings;

            expect(service.isPlugin(plugin)).toBe(false);
        });
    });

    describe('isPluginClass', () => {
        it('should return true for valid plugin class', () => {
            class TestPlugin {
                onLoad() {}
                onUnload() {}
            }

            expect(service.isPluginClass(TestPlugin)).toBe(true);
        });

        it('should return false for non-function', () => {
            expect(service.isPluginClass({})).toBe(false);
        });

        it('should return false for function without prototype', () => {
            const fn = () => {};
            Object.defineProperty(fn, 'prototype', { value: undefined });

            expect(service.isPluginClass(fn)).toBe(false);
        });

        it('should return false for class without required methods', () => {
            class IncompletePlugin {
                onLoad() {}
                // missing other methods
            }

            expect(service.isPluginClass(IncompletePlugin)).toBe(false);
        });

        it('should return false for plain object', () => {
            expect(service.isPluginClass({ onLoad: () => {} })).toBe(false);
        });

        it('should return true for class with all lifecycle methods', () => {
            class FullPlugin {
                onLoad() {}
                onUnload() {}
            }

            expect(service.isPluginClass(FullPlugin)).toBe(true);
        });
    });
});
