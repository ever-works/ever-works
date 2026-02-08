import { BadRequestException } from '@nestjs/common';
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
        category: 'data-source',
        capabilities: ['data-source', 'form-schema-provider'],
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

    describe('getDataSourceFormFields (via getFormSchema)', () => {
        it('should include data source plugin fields in form schema', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [
                {
                    name: 'apify_datasetId',
                    type: 'text',
                    label: 'Dataset ID',
                } as FormFieldDefinition,
            ]);
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'data-source') return [dsRegistered];
                return [];
            });

            const schema = await service.getFormSchema(undefined);

            expect(schema.pluginFields).toHaveLength(1);
            expect(schema.pluginFields[0].name).toBe('apify_datasetId');
        });

        it('should merge default values from data source plugins', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [], {
                getDefaultValues: () => ({ apify_maxItems: 100 }),
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'data-source') return [dsRegistered];
                return [];
            });

            const schema = await service.getFormSchema(undefined);

            expect(schema.defaultValues).toEqual({ apify_maxItems: 100 });
        });

        it('should skip disabled data source plugins', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [
                {
                    name: 'apify_datasetId',
                    type: 'text',
                    label: 'Dataset ID',
                } as FormFieldDefinition,
            ]);
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'data-source') return [dsRegistered];
                return [];
            });
            mockRegistry.isPluginEnabledForScope.mockResolvedValue(false);

            const schema = await service.getFormSchema(undefined, {
                userId: 'user-1',
                directoryId: 'dir-1',
            });

            expect(schema.pluginFields).toHaveLength(0);
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
                if (cap === 'data-source') return [dsRegistered];
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

        it('should return empty pluginConfig when no data source plugins active', async () => {
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

    describe('validateDataSourcePlugins', () => {
        it('should pass when no data source plugins are enabled', async () => {
            mockRegistry.getByCapability.mockReturnValue([]);

            await expect(
                service.validateDataSourcePlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should pass when all enabled data source plugins are configured', async () => {
            const dsPlugin = createMockPlugin({
                id: 'apify',
                capabilities: ['data-source'],
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockReturnValue([dsRegistered]);
            mockRegistry.isPluginEnabledForScope.mockResolvedValue(true);

            await expect(
                service.validateDataSourcePlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should skip non-loaded data source plugins', async () => {
            const dsPlugin = createMockPlugin({
                id: 'broken',
                capabilities: ['data-source'],
            });
            const dsRegistered = createRegistered(dsPlugin);
            dsRegistered.state = 'error';

            mockRegistry.getByCapability.mockReturnValue([dsRegistered]);

            await expect(
                service.validateDataSourcePlugins({ userId: 'u1' }),
            ).resolves.toBeUndefined();
        });

        it('should skip disabled data source plugins', async () => {
            const dsPlugin = createMockPlugin({
                id: 'apify',
                capabilities: ['data-source'],
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockReturnValue([dsRegistered]);
            mockRegistry.isPluginEnabledForScope.mockResolvedValue(false);

            await expect(
                service.validateDataSourcePlugins({ userId: 'u1', directoryId: 'dir-1' }),
            ).resolves.toBeUndefined();
        });
    });

    describe('validateFormValues', () => {
        it('should validate data source plugin form values', async () => {
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
                if (cap === 'data-source') return [dsRegistered];
                return [];
            });

            const result = await service.validateFormValues(
                undefined,
                { apify: {} },
                { userId: 'u1' },
            );

            expect(result.valid).toBe(false);
        });

        it('should pass when data source plugin values are valid', async () => {
            const dsPlugin = createFormSchemaPlugin('apify', [], {
                validateFormInput: () => ({ valid: true }),
            });
            const dsRegistered = createRegistered(dsPlugin);

            mockRegistry.getByCapability.mockImplementation((cap: string) => {
                if (cap === 'data-source') return [dsRegistered];
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
