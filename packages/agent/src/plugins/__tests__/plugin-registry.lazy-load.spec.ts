import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';
import { PluginRegistryService } from '../services/plugin-registry.service';

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const makeManifest = (id: string): PluginManifest =>
    ({
        id,
        name: `Test Plugin ${id}`,
        version: '1.0.0',
        category: 'utility',
        capabilities: ['utility'],
        description: '',
    }) as PluginManifest;

const makePlugin = (id: string): IPlugin =>
    ({
        id,
        name: `Test Plugin ${id}`,
        version: '1.0.0',
        category: 'utility',
        capabilities: ['utility'],
        onLoad: jest.fn().mockResolvedValue(undefined),
        onUnload: jest.fn().mockResolvedValue(undefined),
    }) as unknown as IPlugin;

describe('PluginRegistryService — lazy loading', () => {
    let registry: PluginRegistryService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [PluginRegistryService, EventEmitter2],
        }).compile();
        registry = module.get(PluginRegistryService);
    });

    afterEach(() => {
        registry.clear();
    });

    it('registerLazy parks a loader without invoking it', () => {
        const manifest = makeManifest('lazy-1');
        const loader = jest.fn().mockResolvedValue(makePlugin('lazy-1'));

        const registered = registry.registerLazy(manifest, loader);

        expect(registered.state).toBe('unloaded');
        expect(registered.plugin).toBeUndefined();
        expect(loader).not.toHaveBeenCalled();
        expect(registry.isLazy('lazy-1')).toBe(true);
        // Manifest indices must be populated so capability/category
        // lookups still find the plugin pre-load.
        expect(registry.getByCapability('utility')).toHaveLength(1);
        expect(registry.getByCategory('utility')).toHaveLength(1);
    });

    it('ensureLoaded invokes the loader on first call and caches thereafter', async () => {
        const manifest = makeManifest('lazy-2');
        const plugin = makePlugin('lazy-2');
        const loader = jest.fn().mockResolvedValue(plugin);
        registry.registerLazy(manifest, loader);

        const first = await registry.ensureLoaded('lazy-2');
        expect(first).toBe(plugin);
        expect(loader).toHaveBeenCalledTimes(1);

        const second = await registry.ensureLoaded('lazy-2');
        expect(second).toBe(plugin);
        // Second call MUST be a cache hit — same loader is not
        // re-invoked, no second `import()` cost.
        expect(loader).toHaveBeenCalledTimes(1);

        // After load, registry has the plugin instance attached and
        // state transitioned to 'loaded'.
        expect(registry.get('lazy-2')?.plugin).toBe(plugin);
        expect(registry.get('lazy-2')?.state).toBe('loaded');
    });

    it('ensureLoaded dedupes concurrent calls to a single import', async () => {
        const manifest = makeManifest('lazy-3');
        const plugin = makePlugin('lazy-3');
        let resolveLoader: ((p: IPlugin) => void) | null = null;
        const loaderPromise = new Promise<IPlugin>((resolve) => {
            resolveLoader = resolve;
        });
        const loader = jest.fn().mockReturnValue(loaderPromise);
        registry.registerLazy(manifest, loader);

        const a = registry.ensureLoaded('lazy-3');
        const b = registry.ensureLoaded('lazy-3');
        const c = registry.ensureLoaded('lazy-3');

        // All three callers share the same in-flight promise — only
        // one `import()` ever runs.
        expect(loader).toHaveBeenCalledTimes(1);

        resolveLoader!(plugin);
        const [ra, rb, rc] = await Promise.all([a, b, c]);
        expect(ra).toBe(plugin);
        expect(rb).toBe(plugin);
        expect(rc).toBe(plugin);
    });

    it('ensureLoaded fires the post-load hook exactly once after the plugin is attached', async () => {
        const manifest = makeManifest('lazy-4');
        const plugin = makePlugin('lazy-4');
        const loader = jest.fn().mockResolvedValue(plugin);
        const hook = jest.fn().mockResolvedValue(undefined);

        registry.setPostLoadHook(hook);
        registry.registerLazy(manifest, loader);

        await registry.ensureLoaded('lazy-4');
        await registry.ensureLoaded('lazy-4'); // re-call

        expect(hook).toHaveBeenCalledTimes(1);
        expect(hook).toHaveBeenCalledWith('lazy-4');
    });

    it('ensureLoaded surfaces loader failures and transitions state to error', async () => {
        const manifest = makeManifest('lazy-5');
        const err = new Error('boom');
        const loader = jest.fn().mockRejectedValue(err);
        registry.registerLazy(manifest, loader);

        await expect(registry.ensureLoaded('lazy-5')).rejects.toThrow('boom');
        expect(registry.get('lazy-5')?.state).toBe('error');
    });

    it('ensureLoaded returns the already-attached instance for eager-registered plugins', async () => {
        const manifest = makeManifest('eager-1');
        const plugin = makePlugin('eager-1');
        registry.register(plugin, manifest, { state: 'loaded' });

        const resolved = await registry.ensureLoaded('eager-1');
        expect(resolved).toBe(plugin);
        expect(registry.isLazy('eager-1')).toBe(false);
    });

    it('ensureLoaded throws when the plugin id is unknown', async () => {
        await expect(registry.ensureLoaded('nope')).rejects.toThrow(/not registered/);
    });

    it('unregister clears the parked loader so re-registration is allowed', async () => {
        const manifest = makeManifest('lazy-6');
        registry.registerLazy(manifest, jest.fn());
        registry.unregister('lazy-6');

        expect(registry.has('lazy-6')).toBe(false);
        expect(registry.isLazy('lazy-6')).toBe(false);
        // Re-registration must not collide with leftover state.
        expect(() => registry.registerLazy(manifest, jest.fn())).not.toThrow();
    });
});
