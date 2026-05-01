import { GeneratorFormSchemaService } from '../generator-form-schema.service';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
import type { DirectoryPluginRepository } from '@src/plugins/repositories/directory-plugin.repository';
import type {
    IPlugin,
    IFormSchemaProvider,
    PluginManifest,
    FormFieldDefinition,
} from '@ever-works/plugin';

function createMockPlugin(overrides: Partial<IPlugin> & { id: string }): IPlugin {
    return {
        name: overrides.id,
        version: '1.0.0',
        category: 'data-source',
        capabilities: [],
        settingsSchema: { type: 'object', properties: {} },
        ...overrides,
    } as IPlugin;
}

function createRegistered(
    plugin: IPlugin,
    manifestOverrides?: Partial<PluginManifest>,
): RegisteredPlugin {
    return {
        plugin,
        manifest: {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            description: '',
            ...manifestOverrides,
        } as PluginManifest,
        state: 'loaded',
        builtIn: true,
        registeredAt: Date.now(),
        stateHistory: [],
    };
}

function createFormSchemaPlugin(
    id: string,
    fields: FormFieldDefinition[],
    opts?: {
        category?: string;
        capabilities?: string[];
        transformFormValues?: (v: Record<string, unknown>) => Record<string, unknown>;
        validateFormInput?: (v: Record<string, unknown>) => {
            valid: boolean;
            errors?: Record<string, string>;
        };
        getDefaultValues?: () => Record<string, unknown>;
    },
): IPlugin & IFormSchemaProvider {
    return {
        id,
        name: id,
        version: '1.0.0',
        category: opts?.category ?? 'data-source',
        capabilities: opts?.capabilities ?? ['form-schema-provider'],
        settingsSchema: { type: 'object', properties: {} },
        getFormFields: () => fields,
        getFormGroups: () => [],
        validateFormInput: opts?.validateFormInput ?? (() => ({ valid: true })),
        transformFormValues: opts?.transformFormValues,
        getDefaultValues: opts?.getDefaultValues,
    } as unknown as IPlugin & IFormSchemaProvider;
}

describe('GeneratorFormSchemaService', () => {
    let service: GeneratorFormSchemaService;
    let mockRegistry: jest.Mocked<PluginRegistryService>;

    beforeEach(() => {
        mockRegistry = {
            get: jest.fn(),
            getByCapability: jest.fn().mockReturnValue([]),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        } as unknown as jest.Mocked<PluginRegistryService>;

        service = new GeneratorFormSchemaService(mockRegistry);
    });

    describe('getAdditionalFormFields (via getFormSchema)', () => {
        it('should include form-schema-provider plugin fields in form schema', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [
                {
                    name: 'apify_datasetId',
                    type: 'text',
                    label: 'Dataset ID',
                } as FormFieldDefinition,
            ]);
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [dsRegistered];
                return [];
            });

            const schema = await service.getFormSchema(undefined);

            expect(schema.pluginFields).toHaveLength(1);
            expect(schema.pluginFields[0].name).toBe('apify_datasetId');
        });

        it('should merge default values from form-schema-provider plugins', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [], {
                getDefaultValues: () => ({ apify_maxItems: 100 }),
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [dsRegistered];
                return [];
            });

            const schema = await service.getFormSchema(undefined);

            expect(schema.defaultValues).toEqual({ apify_maxItems: 100 });
        });

        it('should skip disabled form-schema-provider plugins', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [
                {
                    name: 'apify_datasetId',
                    type: 'text',
                    label: 'Dataset ID',
                } as FormFieldDefinition,
            ]);
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [dsRegistered];
                return [];
            });
            mockRegistry.isPluginEnabledForScope.mockResolvedValue(false);

            const schema = await service.getFormSchema(undefined, {
                userId: 'user-1',
                directoryId: 'dir-1',
            });

            expect(schema.pluginFields).toHaveLength(0);
        });

        it('should discover a plugin with only form-schema-provider capability (no data-source)', async () => {
            const customPlugin = createFormSchemaPlugin(
                'custom-form-plugin',
                [
                    {
                        name: 'custom_field',
                        type: 'text',
                        label: 'Custom Field',
                    } as FormFieldDefinition,
                ],
                {
                    category: 'integration',
                    capabilities: ['form-schema-provider'],
                },
            );
            const customRegistered = createRegistered(customPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [customRegistered];
                return [];
            });

            const schema = await service.getFormSchema(undefined);

            expect(schema.pluginFields).toHaveLength(1);
            expect(schema.pluginFields[0].name).toBe('custom_field');
        });

        it('should exclude pipeline plugin from additional form fields (no double-counting)', async () => {
            const pipelinePlugin = createFormSchemaPlugin(
                'standard-pipeline',
                [
                    {
                        name: 'pipeline_field',
                        type: 'text',
                        label: 'Pipeline Field',
                    } as FormFieldDefinition,
                ],
                {
                    category: 'pipeline',
                    capabilities: ['pipeline', 'form-schema-provider'],
                },
            );
            const pipelineRegistered = createRegistered(pipelinePlugin);

            const dsPlugin = createFormSchemaPlugin('apify', [
                {
                    name: 'apify_field',
                    type: 'text',
                    label: 'Apify Field',
                } as FormFieldDefinition,
            ]);
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [pipelineRegistered, dsRegistered];
                return [];
            });

            const schema = await service.getFormSchema(undefined);

            // Pipeline fields come from resolvePipelinePlugin, not from additional form fields.
            // The pipeline's field should appear once (from pipeline resolution),
            // and the data source field should also appear once.
            const pipelineFields = schema.pluginFields.filter((f) => f.name === 'pipeline_field');
            const apifyFields = schema.pluginFields.filter((f) => f.name === 'apify_field');
            expect(pipelineFields).toHaveLength(1);
            expect(apifyFields).toHaveLength(1);
        });
    });

    describe('processFormConfig', () => {
        it('should extract nested per-plugin config from flat form values', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [], {
                transformFormValues: (values) => ({
                    ...values,
                    apify: {
                        datasetId: values['apify_datasetId'],
                        maxItems: values['apify_maxItems'] ?? 100,
                    },
                }),
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [dsRegistered];
                return [];
            });

            const result = await service.processFormConfig(
                undefined,
                {
                    apify_datasetId: 'ds-123',
                    apify_maxItems: 50,
                    max_search_queries: 10,
                },
                { userId: 'u1' },
            );

            expect(result.pluginConfig).toEqual({
                apify: {
                    datasetId: 'ds-123',
                    maxItems: 50,
                },
            });
            // The flat config should no longer contain 'apify' key
            expect(result.config['apify']).toBeUndefined();
            expect(result.config['max_search_queries']).toBe(10);
        });

        it('should return empty pluginConfig when no form-schema-provider plugins active', async () => {
            mockRegistry.getByCapability.mockReturnValue([]);

            const result = await service.processFormConfig(
                undefined,
                {
                    max_search_queries: 10,
                },
                { userId: 'u1' },
            );

            expect(result.pluginConfig).toEqual({});
            expect(result.config).toEqual({ max_search_queries: 10 });
        });

        it('should handle undefined rawConfig', async () => {
            mockRegistry.getByCapability.mockReturnValue([]);

            const result = await service.processFormConfig(undefined, undefined, { userId: 'u1' });

            expect(result.config).toEqual({});
            expect(result.pluginConfig).toEqual({});
        });
    });

    describe('validateFormSchemaPlugins', () => {
        it('should pass when no form-schema-provider plugins are enabled', async () => {
            mockRegistry.getByCapability.mockReturnValue([]);

            await expect(
                service.validateFormSchemaPlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should pass when all enabled form-schema-provider plugins are configured', async () => {
            const dsPlugin = createMockPlugin({
                id: 'apify',
                capabilities: ['form-schema-provider'],
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockReturnValue([dsRegistered]);
            mockRegistry.isPluginEnabledForScope.mockResolvedValue(true);

            await expect(
                service.validateFormSchemaPlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should skip non-loaded form-schema-provider plugins', async () => {
            const dsPlugin = createMockPlugin({
                id: 'broken',
                capabilities: ['form-schema-provider'],
            });
            const dsRegistered = createRegistered(dsPlugin);
            dsRegistered.state = 'error';

            mockRegistry.getByCapability.mockReturnValue([dsRegistered]);

            await expect(
                service.validateFormSchemaPlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should skip disabled form-schema-provider plugins', async () => {
            const dsPlugin = createMockPlugin({
                id: 'apify',
                capabilities: ['form-schema-provider'],
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockReturnValue([dsRegistered]);
            mockRegistry.isPluginEnabledForScope.mockResolvedValue(false);

            await expect(
                service.validateFormSchemaPlugins({ userId: 'u1', directoryId: 'dir-1' }),
            ).resolves.toBeUndefined();
        });

        it('should skip the pipeline plugin during validation', async () => {
            const pipelinePlugin = createMockPlugin({
                id: 'standard-pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockReturnValue([pipelineRegistered]);

            await expect(
                service.validateFormSchemaPlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
        });
    });

    describe('validateSelectedProviders', () => {
        function createProviderPlugin(
            id: string,
            capability: string,
            opts?: { defaultForCapabilities?: string[]; systemPlugin?: boolean },
        ) {
            const plugin = createMockPlugin({ id, capabilities: [capability] });
            return createRegistered(plugin, {
                defaultForCapabilities: opts?.defaultForCapabilities,
                systemPlugin: opts?.systemPlugin,
            });
        }

        it('should pass when explicit providers are valid and configured', async () => {
            const aiPlugin = createProviderPlugin('openrouter', 'ai-provider');
            mockRegistry.get.mockReturnValue(aiPlugin);

            await expect(
                service.validateSelectedProviders({ ai: 'openrouter' }, { userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should reject explicit provider that is not registered', async () => {
            mockRegistry.get.mockReturnValue(undefined);

            await expect(
                service.validateSelectedProviders({ ai: 'nonexistent' }, { userId: 'u1' }),
            ).rejects.toThrow('not available');
        });

        it('should reject explicit provider that is not configured', async () => {
            const aiPlugin = createMockPlugin({
                id: 'openrouter',
                capabilities: ['ai-provider'],
                settingsSchema: {
                    type: 'object',
                    properties: { apiKey: { type: 'string' } },
                    required: ['apiKey'],
                } as any,
            });
            const aiRegistered = createRegistered(aiPlugin);
            mockRegistry.get.mockReturnValue(aiRegistered);

            const settingsService = {
                getResolvedSettings: jest.fn().mockResolvedValue({}),
            };
            const svc = new GeneratorFormSchemaService(
                mockRegistry,
                undefined,
                settingsService as any,
            );

            await expect(
                svc.validateSelectedProviders({ ai: 'openrouter' }, { userId: 'u1' }),
            ).rejects.toThrow('not available');
        });

        it('should validate pipeline provider when explicitly selected', async () => {
            mockRegistry.get.mockReturnValue(undefined);

            await expect(
                service.validateSelectedProviders(
                    { pipeline: 'nonexistent-pipeline' },
                    { userId: 'u1' },
                ),
            ).rejects.toThrow('not available');
        });

        it('should validate default providers when no explicit selection', async () => {
            const aiPlugin = createMockPlugin({
                id: 'openrouter',
                capabilities: ['ai-provider'],
                settingsSchema: {
                    type: 'object',
                    properties: { apiKey: { type: 'string' } },
                    required: ['apiKey'],
                } as any,
            });
            const unconfiguredAi = createRegistered(aiPlugin, {
                defaultForCapabilities: ['ai-provider'],
            });

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'ai-provider') return [unconfiguredAi];
                return [];
            });

            const settingsService = {
                getResolvedSettings: jest.fn().mockResolvedValue({}),
            };

            const svc = new GeneratorFormSchemaService(
                mockRegistry,
                undefined,
                settingsService as any,
            );

            await expect(
                svc.validateSelectedProviders(undefined, { userId: 'u1' }),
            ).rejects.toThrow('not available');
        });

        it('should pass when default providers are configured', async () => {
            const configuredAi = createProviderPlugin('openrouter', 'ai-provider', {
                defaultForCapabilities: ['ai-provider'],
            });

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'ai-provider') return [configuredAi];
                return [];
            });

            // No settings service = all plugins considered configured
            await expect(
                service.validateSelectedProviders(undefined, { userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should pass when no providers exist for a category', async () => {
            mockRegistry.getByCapability.mockReturnValue([]);

            await expect(
                service.validateSelectedProviders(undefined, { userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should skip pipeline category when checking individual providers', async () => {
            mockRegistry.getByCapability.mockReturnValue([]);

            // Should not throw even with undefined providers (no pipeline validation)
            await expect(
                service.validateSelectedProviders({}, { userId: 'u1' }),
            ).resolves.toBeUndefined();
        });
    });

    describe('validateRequiredProvidersForPipeline', () => {
        function createProviderPlugin(
            id: string,
            capability: string,
            opts?: { defaultForCapabilities?: string[]; settingsSchema?: any },
        ) {
            const plugin = createMockPlugin({
                id,
                capabilities: [capability],
                settingsSchema: opts?.settingsSchema ?? { type: 'object', properties: {} },
            });
            return createRegistered(plugin, {
                defaultForCapabilities: opts?.defaultForCapabilities,
            });
        }

        it('should require ai, search, and contentExtractor for agent-pipeline imports', async () => {
            const pipelinePlugin = createFormSchemaPlugin('agent-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin, {
                defaultForCapabilities: ['pipeline'],
            });

            const aiRegistered = createProviderPlugin('groq', 'ai-provider', {
                defaultForCapabilities: ['ai-provider'],
            });

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'agent-pipeline') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [pipelineRegistered];
                if (cap === 'ai-provider') return [aiRegistered];
                if (cap === 'search') return [];
                if (cap === 'content-extractor') return [];
                return [];
            });

            await expect(
                service.validateRequiredProvidersForPipeline(
                    'agent-pipeline',
                    { pipeline: 'agent-pipeline', ai: 'groq' },
                    { userId: 'u1' },
                ),
            ).rejects.toThrow('required providers');
        });

        it('should pass when all required agent-pipeline providers are explicitly configured', async () => {
            const pipelinePlugin = createFormSchemaPlugin('agent-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin, {
                defaultForCapabilities: ['pipeline'],
            });

            const aiRegistered = createProviderPlugin('groq', 'ai-provider');
            const searchRegistered = createProviderPlugin('tavily', 'search');
            const extractorRegistered = createProviderPlugin('firecrawl', 'content-extractor');

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'agent-pipeline') return pipelineRegistered;
                if (id === 'groq') return aiRegistered;
                if (id === 'tavily') return searchRegistered;
                if (id === 'firecrawl') return extractorRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [pipelineRegistered];
                if (cap === 'ai-provider') return [aiRegistered];
                if (cap === 'search') return [searchRegistered];
                if (cap === 'content-extractor') return [extractorRegistered];
                return [];
            });

            await expect(
                service.validateRequiredProvidersForPipeline(
                    'agent-pipeline',
                    {
                        pipeline: 'agent-pipeline',
                        ai: 'groq',
                        search: 'tavily',
                        contentExtractor: 'firecrawl',
                    },
                    { userId: 'u1' },
                ),
            ).resolves.toBeUndefined();
        });
    });

    describe('isPluginConfigured with x-requiredGroups', () => {
        it('should mark plugin configured when at least one group field is set', async () => {
            const plugin = createMockPlugin({
                id: 'my-plugin',
                capabilities: ['ai-provider'],
                settingsSchema: {
                    type: 'object',
                    properties: {
                        oauthToken: { type: 'string', 'x-secret': true },
                        apiKey: { type: 'string', 'x-secret': true },
                    },
                    'x-requiredGroups': [
                        { fields: ['oauthToken', 'apiKey'], message: 'Need OAuth or API key' },
                    ],
                } as any,
            });
            const registered = createRegistered(plugin, {
                defaultForCapabilities: ['ai-provider'],
            });

            mockRegistry.get.mockReturnValue(registered);
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'ai-provider') return [registered];
                return [];
            });

            const settingsService = {
                getResolvedSettings: jest.fn().mockResolvedValue({
                    oauthToken: { value: '' },
                    apiKey: { value: 'sk-123' },
                }),
            };
            const svc = new GeneratorFormSchemaService(
                mockRegistry,
                undefined,
                settingsService as any,
            );

            await expect(
                svc.validateSelectedProviders({ ai: 'my-plugin' }, { userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should mark plugin unconfigured when no group field is set', async () => {
            const plugin = createMockPlugin({
                id: 'my-plugin',
                capabilities: ['ai-provider'],
                settingsSchema: {
                    type: 'object',
                    properties: {
                        oauthToken: { type: 'string', 'x-secret': true },
                        apiKey: { type: 'string', 'x-secret': true },
                    },
                    'x-requiredGroups': [
                        { fields: ['oauthToken', 'apiKey'], message: 'Need OAuth or API key' },
                    ],
                } as any,
            });
            const registered = createRegistered(plugin);

            mockRegistry.get.mockReturnValue(registered);

            const settingsService = {
                getResolvedSettings: jest.fn().mockResolvedValue({
                    oauthToken: { value: '' },
                    apiKey: { value: '' },
                }),
            };
            const svc = new GeneratorFormSchemaService(
                mockRegistry,
                undefined,
                settingsService as any,
            );

            await expect(
                svc.validateSelectedProviders({ ai: 'my-plugin' }, { userId: 'u1' }),
            ).rejects.toThrow('not available');
        });

        it('should require both required fields and requiredGroups to pass', async () => {
            const plugin = createMockPlugin({
                id: 'my-plugin',
                capabilities: ['ai-provider'],
                settingsSchema: {
                    type: 'object',
                    properties: {
                        baseUrl: { type: 'string' },
                        oauthToken: { type: 'string', 'x-secret': true },
                        apiKey: { type: 'string', 'x-secret': true },
                    },
                    required: ['baseUrl'],
                    'x-requiredGroups': [{ fields: ['oauthToken', 'apiKey'] }],
                } as any,
            });
            const registered = createRegistered(plugin);

            mockRegistry.get.mockReturnValue(registered);

            const settingsService = {
                getResolvedSettings: jest.fn().mockResolvedValue({
                    baseUrl: { value: '' },
                    oauthToken: { value: 'token' },
                    apiKey: { value: '' },
                }),
            };
            const svc = new GeneratorFormSchemaService(
                mockRegistry,
                undefined,
                settingsService as any,
            );

            // baseUrl is required but empty → unconfigured
            await expect(
                svc.validateSelectedProviders({ ai: 'my-plugin' }, { userId: 'u1' }),
            ).rejects.toThrow('not available');
        });
    });

    describe('selectableProviderCategories filtering', () => {
        it('should filter provider categories based on pipeline selectableProviderCategories', async () => {
            const pipelinePlugin = createFormSchemaPlugin('claude-code', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin, {
                selectableProviderCategories: ['screenshot'],
            });

            const aiPlugin = createMockPlugin({
                id: 'openrouter',
                capabilities: ['ai-provider'],
            });
            const aiRegistered = createRegistered(aiPlugin);

            const screenshotPlugin = createMockPlugin({
                id: 'screenshotone',
                capabilities: ['screenshot'],
            });
            const screenshotRegistered = createRegistered(screenshotPlugin);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'claude-code') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [pipelineRegistered];
                if (cap === 'ai-provider') return [aiRegistered];
                if (cap === 'screenshot') return [screenshotRegistered];
                if (cap === 'form-schema-provider') return [pipelineRegistered];
                return [];
            });

            const schema = await service.getFormSchema('claude-code');

            // Screenshot should be populated (declared in selectableProviderCategories)
            expect(schema.providers.screenshot.length).toBe(1);
            // AI should be empty (not declared in selectableProviderCategories)
            expect(schema.providers.ai.length).toBe(0);
            // Pipeline should still be populated
            expect(schema.providers.pipeline.length).toBe(1);
        });

        it('should show all provider categories when selectableProviderCategories is not set', async () => {
            const pipelinePlugin = createFormSchemaPlugin('standard-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin);

            const aiPlugin = createMockPlugin({
                id: 'openrouter',
                capabilities: ['ai-provider'],
            });
            const aiRegistered = createRegistered(aiPlugin);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [pipelineRegistered];
                if (cap === 'ai-provider') return [aiRegistered];
                if (cap === 'form-schema-provider') return [pipelineRegistered];
                return [];
            });

            const schema = await service.getFormSchema('standard-pipeline');

            // AI should be populated (no filtering when selectableProviderCategories is unset)
            expect(schema.providers.ai.length).toBe(1);
        });
    });

    describe('validateFormValues', () => {
        it('should validate form-schema-provider plugin form values', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [], {
                validateFormInput: (values) => {
                    if (!values['datasetId']) {
                        return { valid: false, errors: { datasetId: 'Required' } };
                    }
                    return { valid: true };
                },
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [dsRegistered];
                return [];
            });

            const result = await service.validateFormValues(
                undefined,
                { apify: {} },
                { userId: 'u1' },
            );

            expect(result.valid).toBe(false);
        });

        it('should pass when form-schema-provider plugin values are valid', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [], {
                validateFormInput: () => ({ valid: true }),
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'form-schema-provider') return [dsRegistered];
                return [];
            });

            const result = await service.validateFormValues(
                undefined,
                { apify: { datasetId: 'ds-123' } },
                { userId: 'u1' },
            );

            expect(result.valid).toBe(true);
        });
    });

    describe('resolvedPipelineId', () => {
        it('should include resolvedPipelineId in response when pipeline is resolved', async () => {
            const pipelinePlugin = createFormSchemaPlugin('standard-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin, {
                defaultForCapabilities: ['pipeline'],
            });

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [pipelineRegistered];
                if (cap === 'form-schema-provider') return [pipelineRegistered];
                return [];
            });

            const schema = await service.getFormSchema(undefined);

            expect(schema.resolvedPipelineId).toBe('standard-pipeline');
        });

        it('should include explicit pipelineId in resolvedPipelineId', async () => {
            const pipelinePlugin = createFormSchemaPlugin('agent-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'agent-pipeline') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [pipelineRegistered];
                if (cap === 'form-schema-provider') return [pipelineRegistered];
                return [];
            });

            const schema = await service.getFormSchema('agent-pipeline');

            expect(schema.resolvedPipelineId).toBe('agent-pipeline');
        });

        it('should be undefined when no pipeline plugin is found', async () => {
            mockRegistry.getByCapability.mockReturnValue([]);

            const schema = await service.getFormSchema(undefined);

            expect(schema.resolvedPipelineId).toBeUndefined();
        });
    });

    describe('active pipeline provider resolution', () => {
        it('should resolve pipeline from directory active capabilities when no explicit pipelineId', async () => {
            const standardPipeline = createFormSchemaPlugin('standard-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const standardRegistered = createRegistered(standardPipeline, {
                defaultForCapabilities: ['pipeline'],
            });

            const agentPipeline = createFormSchemaPlugin('agent-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const agentRegistered = createRegistered(agentPipeline);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return standardRegistered;
                if (id === 'agent-pipeline') return agentRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [standardRegistered, agentRegistered];
                if (cap === 'form-schema-provider') return [standardRegistered, agentRegistered];
                return [];
            });

            const mockDirPluginRepo = {
                findActiveByCapability: jest.fn().mockResolvedValue({
                    pluginId: 'agent-pipeline',
                }),
            } as unknown as jest.Mocked<DirectoryPluginRepository>;

            const svc = new GeneratorFormSchemaService(mockRegistry, mockDirPluginRepo);

            const schema = await svc.getFormSchema(undefined, { directoryId: 'dir-1' });

            expect(schema.resolvedPipelineId).toBe('agent-pipeline');
        });

        it('should fall back to defaultForCapabilities when no active pipeline provider is set', async () => {
            const standardPipeline = createFormSchemaPlugin('standard-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const standardRegistered = createRegistered(standardPipeline, {
                defaultForCapabilities: ['pipeline'],
            });

            const agentPipeline = createFormSchemaPlugin('agent-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const agentRegistered = createRegistered(agentPipeline);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return standardRegistered;
                if (id === 'agent-pipeline') return agentRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [standardRegistered, agentRegistered];
                if (cap === 'form-schema-provider') return [standardRegistered, agentRegistered];
                return [];
            });

            const mockDirPluginRepo = {
                findActiveByCapability: jest.fn().mockResolvedValue(null),
            } as unknown as jest.Mocked<DirectoryPluginRepository>;

            const svc = new GeneratorFormSchemaService(mockRegistry, mockDirPluginRepo);

            const schema = await svc.getFormSchema(undefined, { directoryId: 'dir-1' });

            expect(schema.resolvedPipelineId).toBe('standard-pipeline');
        });

        it('should prefer explicit pipelineId over directory active provider', async () => {
            const standardPipeline = createFormSchemaPlugin('standard-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const standardRegistered = createRegistered(standardPipeline, {
                defaultForCapabilities: ['pipeline'],
            });

            const agentPipeline = createFormSchemaPlugin('agent-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const agentRegistered = createRegistered(agentPipeline);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return standardRegistered;
                if (id === 'agent-pipeline') return agentRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [standardRegistered, agentRegistered];
                if (cap === 'form-schema-provider') return [standardRegistered, agentRegistered];
                return [];
            });

            const mockDirPluginRepo = {
                findActiveByCapability: jest.fn().mockResolvedValue({
                    pluginId: 'agent-pipeline',
                }),
            } as unknown as jest.Mocked<DirectoryPluginRepository>;

            const svc = new GeneratorFormSchemaService(mockRegistry, mockDirPluginRepo);

            // Explicit standard-pipeline should win over the directory's agent-pipeline provider
            const schema = await svc.getFormSchema('standard-pipeline', {
                directoryId: 'dir-1',
            });

            // Explicit pipelineId takes priority over the directory's active provider
            expect(schema.resolvedPipelineId).toBe('standard-pipeline');
        });

        it('should ignore explicit pipelineId when it is not enabled for the scope', async () => {
            const standardPipeline = createFormSchemaPlugin('standard-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const standardRegistered = createRegistered(standardPipeline, {
                defaultForCapabilities: ['pipeline'],
            });

            const agentPipeline = createFormSchemaPlugin('agent-pipeline', [], {
                category: 'pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const agentRegistered = createRegistered(agentPipeline);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'standard-pipeline') return standardRegistered;
                if (id === 'agent-pipeline') return agentRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'pipeline') return [standardRegistered, agentRegistered];
                if (cap === 'form-schema-provider') return [standardRegistered, agentRegistered];
                return [];
            });
            mockRegistry.isPluginEnabledForScope.mockImplementation(async (pluginId: string) => {
                return pluginId !== 'standard-pipeline';
            });

            const mockDirPluginRepo = {
                findActiveByCapability: jest.fn().mockResolvedValue({
                    pluginId: 'agent-pipeline',
                }),
            } as unknown as jest.Mocked<DirectoryPluginRepository>;

            const svc = new GeneratorFormSchemaService(mockRegistry, mockDirPluginRepo);

            const schema = await svc.getFormSchema('standard-pipeline', {
                directoryId: 'dir-1',
                userId: 'user-1',
            });

            expect(schema.resolvedPipelineId).toBe('agent-pipeline');
        });
    });
});
