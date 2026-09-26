import { BadRequestException, Logger } from '@nestjs/common';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import type { FormFieldDefinition, FormFieldGroup, JsonSchema } from '@ever-works/plugin';
import { GeneratorFormSchemaService } from '../generator-form-schema.service';
import type { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import {
    createRegistry,
    registerColdPlugin,
    requiredSecretSchema,
} from '../../plugins/__tests__/cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

/**
 * The generator form flags providers whose required settings are missing
 * (`configured: false`) and refuses to generate while an enabled
 * form-schema-provider plugin is unconfigured. Both read the plugin class's
 * settings schema — for a plugin the registry still holds as a COLD lazy
 * proxy, the proxy's `{}` must not make it look configured.
 */
describe('GeneratorFormSchemaService — cold lazy plugins', () => {
    function build() {
        const registry = createRegistry();
        const settingsService = {
            getUserGlobalPipelineDefault: jest.fn().mockResolvedValue(null),
            // Nothing is configured: every setting resolves to no value.
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        } as unknown as PluginSettingsService;
        const service = new GeneratorFormSchemaService(registry, undefined, settingsService);
        return { registry, service };
    }

    it('marks a cold search provider with a missing required API key as not configured', async () => {
        const { registry, service } = build();
        registerColdPlugin(registry, {
            id: 'cold-form-search',
            category: 'search',
            capabilities: [PLUGIN_CAPABILITIES.SEARCH],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        const schema = await service.getFormSchema(undefined, { userId: 'user-1' });

        expect(schema.providers.search).toEqual([
            expect.objectContaining({ id: 'cold-form-search', configured: false }),
        ]);
    });

    it('refuses generation while an enabled cold form-schema provider is unconfigured', async () => {
        const { registry, service } = build();
        registerColdPlugin(registry, {
            id: 'cold-form-provider',
            category: 'data-source',
            capabilities: [PLUGIN_CAPABILITIES.FORM_SCHEMA_PROVIDER],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        await expect(
            service.validateFormSchemaPlugins({ userId: 'user-1' }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

/**
 * The generator form reads manifest fields that several builtIns set only in
 * their class's getManifest() — pdf-extractor's `supplementary`, the
 * pipelines' `selectableProviderCategories`, openrouter's
 * `defaultForCapabilities` — and a cold lazy proxy's registry entry does not
 * carry them until the plugin loads.
 */
describe('GeneratorFormSchemaService — cold plugins with a runtime manifest', () => {
    function build() {
        const registry = createRegistry();
        const settingsService = {
            getUserGlobalPipelineDefault: jest.fn().mockResolvedValue(null),
            getResolvedSettings: jest.fn().mockResolvedValue({ apiKey: 'sk-configured' }),
        } as unknown as PluginSettingsService;
        const service = new GeneratorFormSchemaService(registry, undefined, settingsService);
        return { registry, service };
    }

    it('does not offer a cold supplementary extractor as a content-extractor choice', async () => {
        const { registry, service } = build();
        for (const [id, runtimeManifest] of [
            ['cold-general-extractor', undefined],
            ['cold-pdf-extractor', { supplementary: true }],
        ] as const) {
            registerColdPlugin(registry, {
                id,
                category: 'content-extractor',
                capabilities: [PLUGIN_CAPABILITIES.CONTENT_EXTRACTOR],
                settingsSchema: requiredSecretSchema(),
                manifest: { autoEnable: true },
                runtimeManifest,
            });
        }

        const schema = await service.getFormSchema(undefined, { userId: 'user-1' });

        expect(schema.providers.contentExtractor.map((option) => option.id)).toEqual([
            'cold-general-extractor',
        ]);
    });

    it("limits the provider choices to a cold pipeline's selectable categories", async () => {
        const { registry, service } = build();
        registerColdPlugin(registry, {
            id: 'cold-pipeline',
            category: 'pipeline',
            capabilities: [PLUGIN_CAPABILITIES.PIPELINE],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { selectableProviderCategories: [PLUGIN_CAPABILITIES.SCREENSHOT] },
        });
        registerColdPlugin(registry, {
            id: 'cold-search',
            category: 'search',
            capabilities: [PLUGIN_CAPABILITIES.SEARCH],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        const schema = await service.getFormSchema('cold-pipeline', { userId: 'user-1' });

        expect(schema.resolvedPipelineId).toBe('cold-pipeline');
        expect(schema.providers.search).toEqual([]);
    });

    it("marks the default and shows the icon a cold AI provider's getManifest() declares", async () => {
        const { registry, service } = build();
        registerColdPlugin(registry, {
            id: 'cold-ai-other',
            category: 'ai-provider',
            capabilities: [PLUGIN_CAPABILITIES.AI_PROVIDER],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });
        registerColdPlugin(registry, {
            id: 'cold-ai-default',
            category: 'ai-provider',
            capabilities: [PLUGIN_CAPABILITIES.AI_PROVIDER],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: {
                defaultForCapabilities: [PLUGIN_CAPABILITIES.AI_PROVIDER],
                icon: { type: 'lucide', value: 'Bot' },
            },
        });

        const schema = await service.getFormSchema(undefined, { userId: 'user-1' });

        expect(schema.providers.ai).toEqual([
            expect.objectContaining({ id: 'cold-ai-other', isDefault: false }),
            expect.objectContaining({
                id: 'cold-ai-default',
                isDefault: true,
                icon: { type: 'lucide', value: 'Bot' },
            }),
        ]);
    });
});

/**
 * task_f6ae037f — the generator form reads a form-schema provider's members
 * synchronously: `getFormFields()`, `getFormGroups()`, `getDefaultValues()` and
 * the `handledConfigFields` data member. The registry hands out lazy proxies,
 * and before the fix the proxy answered EVERY such read with its async
 * forwarding wrapper — also once the plugin had loaded. So the form got a
 * Promise for agent-pipeline's fields (coerced to `[]`: its own fields were
 * dropped), a function for `handledConfigFields`, and a Promise spread into
 * the field list for a data-source form provider (a TypeError).
 *
 * The providers below are shaped like the real packages:
 * `packages/plugins/agent-pipeline` (AgentPipelinePlugin + form-schema.ts) and
 * `packages/plugins/apify` (a data-source form-schema provider).
 */
describe('GeneratorFormSchemaService — form members of lazy form-schema providers', () => {
    const AGENT_PIPELINE_FIELDS: FormFieldDefinition[] = [
        {
            name: 'target_items',
            type: 'number',
            label: 'Target Items',
            defaultValue: 50,
            validation: { min: 1, max: 500 },
            group: 'volume',
        },
        {
            name: 'max_pages_to_process',
            type: 'number',
            label: 'Max Pages to Process',
            defaultValue: 20,
            validation: { min: 1, max: 1000 },
            group: 'search',
        },
        {
            name: 'capture_screenshots',
            type: 'boolean',
            label: 'Capture Screenshots',
            defaultValue: false,
            group: 'features',
        },
    ];
    const AGENT_PIPELINE_GROUPS: FormFieldGroup[] = [
        { name: 'volume', title: 'Generation Volume', order: 0 },
        { name: 'search', title: 'Search Configuration', order: 1, collapsible: true },
        { name: 'features', title: 'Generation Features', order: 2, collapsible: true },
    ];
    const APIFY_FIELD: FormFieldDefinition = {
        name: 'apify_dataset_id',
        type: 'text',
        label: 'Dataset ID',
        defaultValue: 'ds-default',
        group: 'apify',
    };
    const APIFY_GROUPS: FormFieldGroup[] = [{ name: 'apify', title: 'Apify Import', order: 10 }];
    const EMPTY_SCHEMA = { type: 'object', properties: {} } as JsonSchema;

    /** Form members of a provider; `getDefaultValues` reads its fields through `this`, as agent-pipeline's does. */
    function formMembers(fields: FormFieldDefinition[], groups: FormFieldGroup[]) {
        return {
            getFormFields: () => fields.map((field) => ({ ...field })),
            getFormGroups: () => groups,
            validateFormInput: () => ({ valid: true }),
            getDefaultValues(this: { getFormFields(): FormFieldDefinition[] }) {
                return Object.fromEntries(
                    this.getFormFields()
                        .filter((field) => field.defaultValue !== undefined)
                        .map((field) => [field.name, field.defaultValue]),
                );
            },
        };
    }

    function build() {
        const registry = createRegistry();
        const settingsService = {
            getUserGlobalPipelineDefault: jest.fn().mockResolvedValue(null),
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        } as unknown as PluginSettingsService;
        const service = new GeneratorFormSchemaService(registry, undefined, settingsService);
        const pipeline = registerColdPlugin(registry, {
            id: 'agent-pipeline',
            category: 'pipeline',
            capabilities: [PLUGIN_CAPABILITIES.PIPELINE, PLUGIN_CAPABILITIES.FORM_SCHEMA_PROVIDER],
            settingsSchema: EMPTY_SCHEMA,
            manifest: { autoEnable: true },
            runtimeManifest: { defaultForCapabilities: [PLUGIN_CAPABILITIES.PIPELINE] },
            members: {
                handledConfigFields: ['*'],
                ...formMembers(AGENT_PIPELINE_FIELDS, AGENT_PIPELINE_GROUPS),
            },
        });
        return { registry, service, pipeline };
    }

    it("returns agent-pipeline's own fields, groups, defaults and handledConfigFields", async () => {
        const { service, pipeline } = build();

        const schema = await service.getFormSchema('agent-pipeline', { userId: 'user-1' });

        expect(pipeline.proxy.__isMaterialized).toBe(true);
        expect(schema.resolvedPipelineId).toBe('agent-pipeline');
        expect(schema.pluginFields).toEqual(AGENT_PIPELINE_FIELDS);
        expect(schema.pluginGroups).toEqual(AGENT_PIPELINE_GROUPS);
        expect(schema.handledConfigFields).toEqual(['*']);
        expect(schema.defaultValues).toEqual({
            target_items: 50,
            max_pages_to_process: 20,
            capture_screenshots: false,
        });
    });

    it('returns the fields of the default pipeline it resolved itself (no pipeline id given)', async () => {
        const { service } = build();

        const schema = await service.getFormSchema(undefined, { userId: 'user-1' });

        expect(schema.resolvedPipelineId).toBe('agent-pipeline');
        expect(schema.pluginFields.map((field) => field.name)).toEqual([
            'target_items',
            'max_pages_to_process',
            'capture_screenshots',
        ]);
        expect(schema.handledConfigFields).toEqual(['*']);
    });

    it("appends a cold data-source form provider's fields, groups and defaults after the pipeline's", async () => {
        const { registry, service } = build();
        const apify = registerColdPlugin(registry, {
            id: 'apify',
            category: 'data-source',
            capabilities: ['data-source', PLUGIN_CAPABILITIES.FORM_SCHEMA_PROVIDER],
            settingsSchema: EMPTY_SCHEMA,
            manifest: { autoEnable: true },
            members: { sourceName: 'Apify', ...formMembers([APIFY_FIELD], APIFY_GROUPS) },
        });

        const schema = await service.getFormSchema('agent-pipeline', { userId: 'user-1' });

        expect(apify.loads()).toBe(1);
        expect(schema.pluginFields.map((field) => field.name)).toEqual([
            'target_items',
            'max_pages_to_process',
            'capture_screenshots',
            'apify_dataset_id',
        ]);
        expect(schema.pluginGroups?.map((group) => group.name)).toEqual([
            'volume',
            'search',
            'features',
            'apify',
        ]);
        expect(schema.defaultValues).toEqual({
            target_items: 50,
            max_pages_to_process: 20,
            capture_screenshots: false,
            apify_dataset_id: 'ds-default',
        });
    });

    it('leaves out a data-source form provider that cannot load, and still answers the pipeline form', async () => {
        const { registry, service } = build();
        const broken = registerColdPlugin(registry, {
            id: 'broken-form-source',
            category: 'data-source',
            capabilities: ['data-source', PLUGIN_CAPABILITIES.FORM_SCHEMA_PROVIDER],
            settingsSchema: EMPTY_SCHEMA,
            manifest: { autoEnable: true },
            failing: true,
        });

        const schema = await service.getFormSchema('agent-pipeline', { userId: 'user-1' });

        expect(broken.registered.state).toBe('error');
        expect(schema.pluginFields.map((field) => field.name)).toEqual([
            'target_items',
            'max_pages_to_process',
            'capture_screenshots',
        ]);
    });
});
