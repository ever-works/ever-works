import { Logger } from '@nestjs/common';
import { loadRegisteredPlugins } from '../services/plugin-registry.service';
import { createRegistry, registerColdPlugin, requiredSecretSchema } from './cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const AI = 'ai-provider';

/**
 * The registry's scoped lookups over plugins it still holds as COLD lazy
 * proxies — every plugin discovered on disk, builtIns included, until
 * something uses it.
 *
 * Until a proxy materialises, its registry entry carries the package.json
 * manifest only. What the class's `getManifest()` adds — openrouter's
 * `defaultForCapabilities: ['ai-provider']`, pdf-extractor's `supplementary`,
 * the pipelines' `selectableProviderCategories` — is folded in on first
 * materialise, and so is the `error` state of a plugin whose import or
 * `onLoad` fails. A lookup that picks a provider from those must load its
 * candidates first.
 */
describe('PluginRegistryService — scoped lookups over cold lazy plugins', () => {
    it('picks the default a cold plugin declares only in getManifest()', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, {
            id: 'cold-first',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });
        registerColdPlugin(registry, {
            id: 'cold-default',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { defaultForCapabilities: [AI] },
        });

        const chosen = await registry.getDefaultForCapabilityScoped(AI, undefined, 'user-1');

        expect(chosen?.plugin.id).toBe('cold-default');
    });

    it('never picks a cold plugin that cannot be imported', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, {
            id: 'cold-broken',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true, defaultForCapabilities: [AI] },
            failing: true,
        });
        registerColdPlugin(registry, {
            id: 'cold-fallback',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        const chosen = await registry.getDefaultForCapabilityScoped(AI, undefined, 'user-1');

        expect(chosen?.plugin.id).toBe('cold-fallback');
        expect(registry.get('cold-broken')?.state).toBe('error');
    });

    it('never picks a cold plugin whose onLoad fails', async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, {
            id: 'cold-onload-fails',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true, defaultForCapabilities: [AI] },
            onLoadFails: true,
        });
        registerColdPlugin(registry, {
            id: 'cold-healthy',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        const chosen = await registry.getDefaultForCapabilityScoped(AI, undefined, 'user-1');

        expect(chosen?.plugin.id).toBe('cold-healthy');
        expect(registry.get('cold-onload-fails')?.state).toBe('error');
    });

    it('leaves a plugin that is not enabled for the scope cold', async () => {
        const registry = createRegistry();
        const disabled = registerColdPlugin(registry, {
            id: 'cold-disabled',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
        });
        registerColdPlugin(registry, {
            id: 'cold-enabled',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        const chosen = await registry.getDefaultForCapabilityScoped(AI, undefined, 'user-1');
        const enabled = await registry.getEnabledPluginsScoped(AI, undefined, 'user-1');

        expect(chosen?.plugin.id).toBe('cold-enabled');
        expect(enabled.map((entry) => entry.plugin.id)).toEqual(['cold-enabled']);
        expect(disabled.loads()).toBe(0);
    });

    it("answers enabled entries with the class's runtime manifest folded in", async () => {
        const registry = createRegistry();
        registerColdPlugin(registry, {
            id: 'cold-supplementary',
            capabilities: ['content-extractor'],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
            runtimeManifest: { supplementary: true },
        });

        const [entry] = await registry.getEnabledPluginsScoped(
            'content-extractor',
            undefined,
            'user-1',
        );

        expect(entry.manifest.supplementary).toBe(true);
    });
});

describe('loadRegisteredPlugins', () => {
    it('loads every entry once and answers, in order, the ones that are still loaded', async () => {
        const registry = createRegistry();
        const first = registerColdPlugin(registry, {
            id: 'load-first',
            settingsSchema: requiredSecretSchema(),
            runtimeManifest: { supplementary: true },
        });
        const broken = registerColdPlugin(registry, {
            id: 'load-broken',
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });
        const onLoadFails = registerColdPlugin(registry, {
            id: 'load-onload-fails',
            settingsSchema: requiredSecretSchema(),
            onLoadFails: true,
        });
        const last = registerColdPlugin(registry, {
            id: 'load-last',
            settingsSchema: requiredSecretSchema('LOAD_LAST_KEY'),
        });

        const entries = [first, broken, onLoadFails, last].map((cold) => cold.registered);
        const loaded = await loadRegisteredPlugins(entries);

        expect(loaded.map((entry) => entry.plugin.id)).toEqual(['load-first', 'load-last']);
        expect(first.registered.manifest.supplementary).toBe(true);
        expect(last.proxy.settingsSchema).toEqual(requiredSecretSchema('LOAD_LAST_KEY'));

        await loadRegisteredPlugins(entries);
        expect(first.loads()).toBe(1);
        expect(last.loads()).toBe(1);
    });

    it('answers an empty list for no entries', async () => {
        await expect(loadRegisteredPlugins([])).resolves.toEqual([]);
    });
});
