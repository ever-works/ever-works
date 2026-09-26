import { Logger } from '@nestjs/common';
import { loadPluginSchema, loadRegisteredPlugins } from '../services/plugin-registry.service';
import {
    createRegistry,
    gate,
    registerColdPlugin,
    requiredSecretSchema,
    settle,
} from './cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const AI = 'ai-provider';

/**
 * A lazy proxy marks itself materialised BEFORE its first-materialise hook
 * runs, and the hook awaits the loader's manifest DB upsert before it calls
 * `onLoad`. A caller that arrives inside that window finds the proxy
 * materialised and the entry still `loaded`, while `onLoad` has not run — and
 * may yet fail. Disk builtIns (openrouter, tavily, the pipelines, …) are cold
 * until first use, so the first requests of a fresh process race exactly
 * there.
 *
 * Every path that picks a plugin to USE must wait for that first load to
 * settle. Only the settings-schema read (`loadPluginSchema`) must not: the
 * plugin's own `onLoad` reaches it through `context.getSettings`.
 */
describe('first load still running — a second caller waits for it', () => {
    it('answers the plugin to a second caller only once its onLoad has run', async () => {
        const registry = createRegistry();
        const hold = gate();
        const cold = registerColdPlugin(registry, {
            id: 'slow-first-load',
            settingsSchema: requiredSecretSchema(),
            firstLoadGate: hold.promise,
        });

        const first = loadRegisteredPlugins([cold.registered]);
        await settle();
        // The window: imported and marked materialised, onLoad not yet run.
        expect(cold.proxy.__isMaterialized).toBe(true);
        expect(cold.onLoadDone()).toBe(false);

        const second = loadRegisteredPlugins([cold.registered]).then((entries) => ({
            ids: entries.map((entry) => entry.plugin.id),
            onLoadDoneWhenAnswered: cold.onLoadDone(),
        }));
        await settle();
        hold.release();

        await expect(second).resolves.toEqual({
            ids: ['slow-first-load'],
            onLoadDoneWhenAnswered: true,
        });
        await expect(first).resolves.toHaveLength(1);
        expect(cold.loads()).toBe(1);
    });

    it('never answers a second caller a plugin whose onLoad then fails', async () => {
        const registry = createRegistry();
        const hold = gate();
        const cold = registerColdPlugin(registry, {
            id: 'slow-onload-fails',
            settingsSchema: requiredSecretSchema(),
            onLoadFails: true,
            firstLoadGate: hold.promise,
        });

        const first = loadRegisteredPlugins([cold.registered]);
        await settle();
        const second = loadRegisteredPlugins([cold.registered]).then((entries) =>
            entries.map((entry) => entry.plugin.id),
        );
        await settle();
        hold.release();

        await expect(second).resolves.toEqual([]);
        await expect(first).resolves.toEqual([]);
        expect(registry.get('slow-onload-fails')?.state).toBe('error');
    });

    it("waits in the registry's scoped lookups too, and never picks a default whose onLoad then fails", async () => {
        const registry = createRegistry();
        const hold = gate();
        registerColdPlugin(registry, {
            id: 'slow-default-fails',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true, defaultForCapabilities: [AI] },
            onLoadFails: true,
            firstLoadGate: hold.promise,
        });
        registerColdPlugin(registry, {
            id: 'healthy-fallback',
            capabilities: [AI],
            settingsSchema: requiredSecretSchema(),
            manifest: { autoEnable: true },
        });

        const first = registry.getDefaultForCapabilityScoped(AI, undefined, 'user-1');
        await settle();
        const secondDefault = registry
            .getDefaultForCapabilityScoped(AI, undefined, 'user-1')
            .then((entry) => entry?.plugin.id);
        const secondEnabled = registry
            .getEnabledPluginsScoped(AI, undefined, 'user-1')
            .then((entries) => entries.map((entry) => entry.plugin.id));
        await settle();
        hold.release();

        await expect(secondDefault).resolves.toBe('healthy-fallback');
        await expect(secondEnabled).resolves.toEqual(['healthy-fallback']);
        await expect(first.then((entry) => entry?.plugin.id)).resolves.toBe('healthy-fallback');
    });

    it('does not make a settings-schema read wait (the plugin reaches it from its own onLoad)', async () => {
        const registry = createRegistry();
        const hold = gate();
        const cold = registerColdPlugin(registry, {
            id: 'slow-schema-read',
            settingsSchema: requiredSecretSchema('SLOW_SCHEMA_READ_KEY'),
            firstLoadGate: hold.promise,
        });

        const first = loadRegisteredPlugins([cold.registered]);
        await settle();

        await expect(loadPluginSchema(cold.proxy, cold.registered)).resolves.toBe(true);
        expect(cold.proxy.settingsSchema).toEqual(requiredSecretSchema('SLOW_SCHEMA_READ_KEY'));
        expect(cold.onLoadDone()).toBe(false);

        hold.release();
        await first;
    });
});

/**
 * A lazy proxy whose IMPORT failed resets itself so a later call can retry,
 * and each retry runs the failure hook again: another `error` write to the
 * database, another state-history entry, another STATE_CHANGED event. The
 * plugin list loads every visible plugin (twice per request), and settings
 * reads load theirs, so an entry already in `error` must not be loaded again.
 * (A retry could not bring it back anyway: `callOnLoad` refuses a plugin in
 * `error`.)
 */
describe('an entry already in error is not loaded again', () => {
    it('loadPluginSchema answers false for it without importing again', async () => {
        const registry = createRegistry();
        const cold = registerColdPlugin(registry, {
            id: 'broken-import',
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });

        await expect(loadPluginSchema(cold.proxy, cold.registered)).resolves.toBe(false);
        expect(cold.registered.state).toBe('error');
        const transitions = cold.registered.stateHistory.length;

        await expect(loadPluginSchema(cold.proxy, cold.registered)).resolves.toBe(false);
        await expect(loadPluginSchema(cold.proxy, cold.registered)).resolves.toBe(false);

        expect(cold.loads()).toBe(1);
        expect(cold.registered.stateHistory).toHaveLength(transitions);
    });

    it('loadRegisteredPlugins skips it without importing again', async () => {
        const registry = createRegistry();
        const cold = registerColdPlugin(registry, {
            id: 'broken-import-list',
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });

        await expect(loadRegisteredPlugins([cold.registered])).resolves.toEqual([]);
        await expect(loadRegisteredPlugins([cold.registered])).resolves.toEqual([]);

        expect(cold.loads()).toBe(1);
    });
});
