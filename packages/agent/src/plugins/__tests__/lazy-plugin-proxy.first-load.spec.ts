import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { IPlugin, PluginManifest } from '@ever-works/plugin';
import { createLazyPluginProxy, type LazyPluginStub } from '../services/lazy-plugin-proxy';
import { PluginSettingsService } from '../services/plugin-settings.service';
import type { PluginRepository } from '../repositories/plugin.repository';
import type { UserPluginRepository } from '../repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../repositories/work-plugin.repository';
import {
    createRegistry,
    gate,
    registerColdPlugin,
    requiredSecretSchema,
    settle,
    type Pingable,
} from './cold-plugin.fixture';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

/**
 * F6 — the first-use race, closed in the proxy itself.
 *
 * A lazy proxy imports the plugin, marks itself materialised, and only then
 * runs its first-materialise hook: the loader's manifest fold, `onLoad`
 * (through `callOnLoad`) and the manifest DB upsert. A caller that arrives
 * inside that window must not be handed the instance, nor run one of its
 * methods, before that first load has settled — the plugin's `onLoad` may not
 * have run yet (openrouter: "not loaded"), or may be about to fail and put the
 * entry in `error`. Only code running INSIDE the plugin's own first load (its
 * `onLoad` reading its settings, calling itself) is answered at once: it could
 * never wait on itself.
 */
describe('lazy proxy — a caller arriving during the first load waits for it', () => {
    it('answers a plain __materialize() only once onLoad has run (the review probe)', async () => {
        const registry = createRegistry();
        const hold = gate();
        const cold = registerColdPlugin(registry, {
            id: 'probe-plain-materialize',
            settingsSchema: requiredSecretSchema(),
            firstLoadGate: hold.promise,
        });

        const first = cold.proxy.__materialize();
        await settle();
        // The window: imported and marked materialised, onLoad not yet run.
        expect(cold.proxy.__isMaterialized).toBe(true);
        expect(cold.onLoadDone()).toBe(false);

        const second = cold.proxy.__materialize().then((real) => ({
            onLoadDoneWhenAnswered: cold.onLoadDone(),
            ping: (real as unknown as Pingable).ping(),
        }));
        await settle();
        hold.release();

        await expect(second).resolves.toEqual({ onLoadDoneWhenAnswered: true, ping: 'pong' });
        await first;
        expect(cold.loads()).toBe(1);
    });

    it('runs a method called through the proxy in that window only once onLoad has run', async () => {
        const registry = createRegistry();
        const hold = gate();
        const cold = registerColdPlugin(registry, {
            id: 'probe-method-call',
            settingsSchema: requiredSecretSchema(),
            firstLoadGate: hold.promise,
        });

        const first = cold.proxy.__materialize();
        await settle();

        // Deferred into a promise so a synchronous throw ("used before its
        // onLoad ran") is reported as a rejection rather than failing the spec.
        const viaProxy = Promise.resolve().then(() => (cold.proxy as unknown as Pingable).ping());
        await settle();
        hold.release();

        await expect(viaProxy).resolves.toBe('pong');
        await first;
        // Once loaded, a sync method is sync again.
        expect((cold.proxy as unknown as Pingable).ping()).toBe('pong');
    });

    it('never hands a second caller a plugin whose onLoad then fails without the entry saying so', async () => {
        const registry = createRegistry();
        const hold = gate();
        const cold = registerColdPlugin(registry, {
            id: 'probe-onload-fails',
            settingsSchema: requiredSecretSchema(),
            onLoadFails: true,
            firstLoadGate: hold.promise,
        });

        const first = cold.proxy.__materialize();
        await settle();
        const second = cold.proxy.__materialize().then(() => cold.registered.state);
        await settle();
        hold.release();

        // Answered after the failure was recorded, so the caller's re-check
        // (`pluginLoadFailure`) sees it.
        await expect(second).resolves.toBe('error');
        await first;
    });
});

describe("lazy proxy — calls made inside the plugin's own first load", () => {
    function settingsServiceFor(registry: ReturnType<typeof createRegistry>) {
        return new PluginSettingsService(
            registry,
            { findByPluginId: jest.fn().mockResolvedValue(null) } as unknown as PluginRepository,
            {
                findByUserAndPlugin: jest.fn().mockResolvedValue(null),
            } as unknown as UserPluginRepository,
            {
                findByWorkAndPlugin: jest.fn().mockResolvedValue(null),
            } as unknown as WorkPluginRepository,
            new EventEmitter2(),
        );
    }

    it('lets onLoad read its own settings (context.getSettings) and call itself through the proxy', async () => {
        const registry = createRegistry();
        const settings = settingsServiceFor(registry);
        const seen: Record<string, unknown> = {};
        const cold = registerColdPlugin(registry, {
            id: 'self-reader',
            settingsSchema: requiredSecretSchema('SELF_READER_API_KEY'),
            members: {
                echo: async (value: string) => value,
                onLoad: async () => {
                    // What context.getSettings reaches: the settings
                    // service, which loads the plugin's schema first.
                    const resolved = await settings.getResolvedSettings('self-reader');
                    seen.settingKeys = Object.keys(resolved).sort();
                    const proxy = registry.get('self-reader')!.plugin as LazyPluginStub;
                    seen.self = (await proxy.__materialize()).id;
                    seen.echo = await (
                        proxy as unknown as { echo(value: string): Promise<string> }
                    ).echo('hello');
                },
            },
        });

        await expect(cold.proxy.__materialize({ waitForLoad: true })).resolves.toMatchObject({
            id: 'self-reader',
        });
        expect(seen).toEqual({
            settingKeys: ['apiKey', 'region'],
            self: 'self-reader',
            echo: 'hello',
        });
        expect(cold.registered.state).toBe('loaded');
    }, 5_000);

    it('rejects a waitForLoad for the same plugin from inside its own onLoad instead of hanging', async () => {
        const registry = createRegistry();
        let selfWait: unknown;
        const cold = registerColdPlugin(registry, {
            id: 'self-waiter',
            settingsSchema: requiredSecretSchema(),
            members: {
                onLoad: async () => {
                    const proxy = registry.get('self-waiter')!.plugin as LazyPluginStub;
                    try {
                        await proxy.__materialize({ waitForLoad: true });
                        selfWait = 'resolved';
                    } catch (error) {
                        selfWait = error;
                    }
                },
            },
        });

        await cold.proxy.__materialize({ waitForLoad: true });

        expect(selfWait).toBeInstanceOf(Error);
        expect((selfWait as Error).message).toMatch(/Plugin "self-waiter".*its own first load/);
    }, 5_000);

    it('rejects a cross-plugin wait that would close a cycle between two first loads', async () => {
        // A's onLoad waits for B; B's first load (started independently)
        // waits for A from its own onLoad. Neither could ever settle.
        const manifest = (id: string) =>
            ({
                id,
                name: id,
                version: '1.0.0',
                description: id,
                category: 'utility',
                capabilities: ['test'],
            }) as PluginManifest;
        const aGate = gate();
        const errors: Record<string, unknown> = {};
        let a!: LazyPluginStub;
        let b!: LazyPluginStub;
        const plugin = (id: string): IPlugin =>
            ({ id, onLoad: async () => undefined }) as unknown as IPlugin;
        a = createLazyPluginProxy(
            manifest('cycle-a'),
            async () => plugin('cycle-a'),
            async () => {
                await aGate.promise;
                try {
                    await b.__materialize({ waitForLoad: true });
                } catch (error) {
                    errors.a = error;
                }
            },
        );
        b = createLazyPluginProxy(
            manifest('cycle-b'),
            async () => plugin('cycle-b'),
            async () => {
                try {
                    await a.__materialize({ waitForLoad: true });
                } catch (error) {
                    errors.b = error;
                }
            },
        );

        const aLoad = a.__materialize();
        await settle(); // A imported, its hook waits on the gate
        const bLoad = b.__materialize(); // B's hook now waits for A
        await settle();
        aGate.release(); // A's hook now waits for B: the cycle closes

        await Promise.all([aLoad, bLoad]);
        expect(errors.a).toBeInstanceOf(Error);
        expect((errors.a as Error).message).toMatch(/would never settle/);
        expect(errors.b).toBeUndefined();
    }, 5_000);
});

/**
 * Review of the F6 fix: a first load started from INSIDE another plugin's
 * first load (its onLoad loads a second plugin) carries both loads' markers.
 * When the inner plugin's onLoad then waits for the outer one, the wait is
 * refused — the outer load may be waiting for the inner one — and the error
 * must name the plugin that waited, not claim the outer plugin waited for
 * itself. The marker also reaches work an onLoad starts WITHOUT awaiting it,
 * until that load settles: such a wait is refused the same way (see
 * LazyPluginStub, "The first load").
 */
describe('lazy proxy — a first load started inside another one', () => {
    const manifest = (id: string) =>
        ({
            id,
            name: id,
            version: '1.0.0',
            description: id,
            category: 'utility',
            capabilities: ['test'],
        }) as PluginManifest;
    const plugin = (id: string): IPlugin =>
        ({ id, onLoad: async () => undefined }) as unknown as IPlugin;

    it("names the inner plugin as the waiter when it waits for the outer plugin's first load", async () => {
        const errors: Record<string, unknown> = {};
        let inner!: LazyPluginStub;
        const outer = createLazyPluginProxy(
            manifest('nest-outer'),
            async () => plugin('nest-outer'),
            // The outer onLoad loads the inner plugin and awaits it.
            async () => {
                await inner.__materialize();
            },
        );
        inner = createLazyPluginProxy(
            manifest('nest-inner'),
            async () => plugin('nest-inner'),
            async () => {
                try {
                    await outer.__materialize({ waitForLoad: true });
                } catch (error) {
                    errors.inner = error;
                }
            },
        );

        await outer.__materialize({ waitForLoad: true });

        expect(errors.inner).toBeInstanceOf(Error);
        const message = (errors.inner as Error).message;
        expect(message).toMatch(/first load of plugin "nest-inner" waited for plugin "nest-outer"/);
        expect(message).not.toMatch(/its own first load/);
    }, 5_000);

    it('refuses, naming the waiter, a wait from a load that un-awaited work of an onLoad started', async () => {
        const errors: Record<string, unknown> = {};
        const outerGate = gate();
        const innerDone = gate();
        let inner!: LazyPluginStub;
        const outer = createLazyPluginProxy(
            manifest('bg-outer'),
            async () => plugin('bg-outer'),
            async () => {
                // Started, not awaited: it still carries this load's marker.
                void inner.__materialize();
                await outerGate.promise;
            },
        );
        inner = createLazyPluginProxy(
            manifest('bg-inner'),
            async () => plugin('bg-inner'),
            async () => {
                try {
                    await outer.__materialize({ waitForLoad: true });
                } catch (error) {
                    errors.inner = error;
                } finally {
                    innerDone.release();
                }
            },
        );

        const outerLoad = outer.__materialize();
        await innerDone.promise;
        outerGate.release();
        await outerLoad;

        expect(errors.inner).toBeInstanceOf(Error);
        expect((errors.inner as Error).message).toMatch(
            /first load of plugin "bg-inner" waited for plugin "bg-outer"/,
        );
    }, 5_000);
});

/**
 * Review of the F6 fix: a caller outside the first load that calls a method
 * THROUGH the proxy waits for the load to settle — and when that load failed
 * (`onLoad` threw; `callOnLoad` caught it and put the entry in `error`), the
 * call must not then run on the half-initialised instance, as the eager boot
 * never selected such a plugin. `__materialize` still resolves, so callers
 * that re-check the entry (`pluginLoadFailure`) keep working.
 */
describe('lazy proxy — a method call whose first load failed', () => {
    it('refuses a call made on the cold proxy once its onLoad has failed', async () => {
        const registry = createRegistry();
        const work = jest.fn(async () => 'worked');
        const cold = registerColdPlugin(registry, {
            id: 'fails-cold-call',
            settingsSchema: requiredSecretSchema(),
            onLoadFails: true,
            members: { work },
        });

        const call = (cold.proxy as unknown as { work(): Promise<string> }).work();

        await expect(call).rejects.toThrow(/Plugin "fails-cold-call".*error state/);
        expect(work).not.toHaveBeenCalled();
        expect(cold.registered.state).toBe('error');
        await expect(cold.proxy.__materialize()).resolves.toMatchObject({
            id: 'fails-cold-call',
        });
    });

    it('refuses a call made while that first load was settling', async () => {
        const registry = createRegistry();
        const hold = gate();
        const work = jest.fn(async () => 'worked');
        const cold = registerColdPlugin(registry, {
            id: 'fails-settling-call',
            settingsSchema: requiredSecretSchema(),
            onLoadFails: true,
            firstLoadGate: hold.promise,
            members: { work },
        });

        const first = cold.proxy.__materialize();
        await settle();
        const call = (cold.proxy as unknown as { work(): Promise<string> }).work();
        call.catch(() => undefined);
        await settle();
        hold.release();

        await expect(call).rejects.toThrow(/Plugin "fails-settling-call".*error state/);
        expect(work).not.toHaveBeenCalled();
        await first;
    });

    it('still runs a call whose first load succeeded', async () => {
        const registry = createRegistry();
        const work = jest.fn(async () => 'worked');
        const cold = registerColdPlugin(registry, {
            id: 'loads-cold-call',
            settingsSchema: requiredSecretSchema(),
            members: { work },
        });

        await expect((cold.proxy as unknown as { work(): Promise<string> }).work()).resolves.toBe(
            'worked',
        );
        expect(work).toHaveBeenCalledTimes(1);
    });
});
