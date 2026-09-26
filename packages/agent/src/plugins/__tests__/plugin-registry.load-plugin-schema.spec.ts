import { Logger } from '@nestjs/common';
import type { IPlugin } from '@ever-works/plugin';
import { loadPluginSchema } from '../services/plugin-registry.service';
import { createLazyPluginProxy } from '../services/lazy-plugin-proxy';
import { createRegistry, registerColdPlugin, requiredSecretSchema } from './cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

/**
 * `loadPluginSchema` — the one async step every synchronous reader of
 * `plugin.settingsSchema` / `plugin.configurationMode` takes first, so a lazy
 * proxy that has not materialised yet answers the plugin class's values
 * instead of `{}` / `undefined`.
 */
describe('loadPluginSchema', () => {
    it('materialises a cold lazy proxy so its schema and configuration mode are the real ones', async () => {
        const registry = createRegistry();
        const cold = registerColdPlugin(registry, {
            id: 'cold-schema',
            settingsSchema: requiredSecretSchema('COLD_SCHEMA_KEY'),
            configurationMode: 'admin-only',
        });

        // Cold: the proxy knows only the package.json manifest.
        expect(cold.proxy.settingsSchema).toEqual({});
        expect(cold.proxy.configurationMode).toBeUndefined();

        await expect(loadPluginSchema(cold.proxy)).resolves.toBe(true);

        expect(cold.proxy.__isMaterialized).toBe(true);
        expect(cold.proxy.settingsSchema).toEqual(requiredSecretSchema('COLD_SCHEMA_KEY'));
        expect(cold.proxy.configurationMode).toBe('admin-only');
        expect(cold.loads()).toBe(1);
    });

    it('does not import again once the plugin has materialised', async () => {
        const registry = createRegistry();
        const cold = registerColdPlugin(registry, {
            id: 'warm-schema',
            settingsSchema: requiredSecretSchema(),
        });

        await loadPluginSchema(cold.proxy);
        await loadPluginSchema(cold.proxy);
        await Promise.all([loadPluginSchema(cold.proxy), loadPluginSchema(cold.proxy)]);

        expect(cold.loads()).toBe(1);
    });

    it('answers true at once for a plugin that is not a lazy proxy', async () => {
        const real = {
            id: 'real',
            settingsSchema: requiredSecretSchema(),
        } as unknown as IPlugin;

        await expect(loadPluginSchema(real)).resolves.toBe(true);
        await expect(loadPluginSchema(undefined)).resolves.toBe(true);
    });

    it('answers false, and leaves the entry in error, when the plugin cannot be imported', async () => {
        const registry = createRegistry();
        const cold = registerColdPlugin(registry, {
            id: 'broken',
            settingsSchema: requiredSecretSchema(),
            failing: true,
        });

        await expect(loadPluginSchema(cold.proxy)).resolves.toBe(false);

        expect(registry.get('broken')?.state).toBe('error');
        expect(cold.proxy.settingsSchema).toEqual({});
    });

    it("does not wait on the plugin's own onLoad (a reader called from inside it cannot deadlock)", async () => {
        let innerAnswer: boolean | undefined;
        let proxy: ReturnType<typeof createLazyPluginProxy> | undefined;
        const real = {
            id: 'self-reader',
            name: 'Self reader',
            version: '1.0.0',
            category: 'utility',
            capabilities: ['test'],
            settingsSchema: requiredSecretSchema(),
            onLoad: async () => undefined,
            onUnload: async () => undefined,
        } as unknown as IPlugin;

        proxy = createLazyPluginProxy(
            {
                id: 'self-reader',
                name: 'Self reader',
                version: '1.0.0',
                description: 'reads its own schema from onLoad',
                category: 'utility',
                capabilities: ['test'],
            } as never,
            async () => real,
            // The first-materialise hook is where onLoad runs; the plugin's
            // onLoad resolving its own settings reaches this helper.
            async () => {
                innerAnswer = await loadPluginSchema(proxy);
            },
        );

        await expect(proxy.__materialize({ waitForLoad: true })).resolves.toBe(real);
        expect(innerAnswer).toBe(true);
    });
});
