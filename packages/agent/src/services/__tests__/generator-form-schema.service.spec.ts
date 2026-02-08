import { GeneratorFormSchemaService } from '../generator-form-schema.service';
import type {
    PluginRegistryService,
    RegisteredPlugin,
} from '@src/plugins/services/plugin-registry.service';
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
                'default-pipeline',
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
                if (id === 'default-pipeline') return pipelineRegistered;
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
                id: 'default-pipeline',
                capabilities: ['pipeline', 'form-schema-provider'],
            });
            const pipelineRegistered = createRegistered(pipelinePlugin);

            mockRegistry.get.mockImplementation((id: string) => {
                if (id === 'default-pipeline') return pipelineRegistered;
                return undefined;
            });
            mockRegistry.getByCapability.mockReturnValue([pipelineRegistered]);

            await expect(
                service.validateFormSchemaPlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
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
});
