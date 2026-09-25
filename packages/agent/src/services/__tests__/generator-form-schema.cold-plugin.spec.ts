import { BadRequestException, Logger } from '@nestjs/common';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
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
