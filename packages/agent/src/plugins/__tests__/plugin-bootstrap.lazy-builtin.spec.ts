import * as path from 'path';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginBootstrapService } from '../services/plugin-bootstrap.service';
import { PluginLoaderService } from '../services/plugin-loader.service';
import { PluginLifecycleManagerService } from '../services/plugin-lifecycle-manager.service';
import { PluginContextFactoryService } from '../services/plugin-context-factory.service';
import { PluginRegistryService } from '../services/plugin-registry.service';
import { PluginManifestValidatorService } from '../services/plugin-manifest-validator.service';
import { PluginVersionCheckerService } from '../services/plugin-version-checker.service';
import { PluginClassValidatorService } from '../services/plugin-class-validator.service';
import { CustomCapabilityRegistryService } from '../services/custom-capability-registry.service';
import { PluginSettingsService } from '../services/plugin-settings.service';
import type { LazyPluginStub } from '../services/lazy-plugin-proxy';
import type { PluginRepository } from '../repositories/plugin.repository';
import type { UserPluginRepository } from '../repositories/user-plugin.repository';
import type { WorkPluginRepository } from '../repositories/work-plugin.repository';
import { PluginEvents } from '../plugins.constants';
import type {
    PluginModule,
    PluginsModuleOptions,
} from '../interfaces/plugins-module-options.interface';

/**
 * `PLUGIN_EAGER_BUILTINS` — whether bootstrap materialises the `builtIn`
 * plugins it DISCOVERS ON DISK (a lazy proxy each) at boot, or leaves them
 * cold until first use like every other disk plugin.
 *
 * Runs against the REAL loader, registry, lifecycle manager, lazy proxy and
 * settings service over plugins discovered on disk
 * (`fixtures/bootstrap-lazy-builtin/`).
 *
 * Unset (the default) or any value but `true` leaves disk builtIns lazy: this
 * spec pins that onLoad, error recording, settings resolution (the real
 * schema, `x-envVar` included) and provider selection (the runtime-manifest
 * fields `getManifest()` adds) still behave for a builtIn nobody has used yet.
 * `true` restores the eager builtIn boot, pinned in detail by
 * `plugin-bootstrap.disk-builtin.spec.ts`.
 */

jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const FIXTURES = path.join(__dirname, 'fixtures', 'bootstrap-lazy-builtin');
const ENV_KEY = 'LAZY_BUILTIN_FIXTURE_API_KEY';

const globalCounts = globalThis as unknown as { __lazyBuiltinOnload?: Record<string, number> };

function onLoadCount(pluginId: string): number {
    return globalCounts.__lazyBuiltinOnload?.[pluginId] ?? 0;
}

/** A programmatic `builtInPlugins` entry: a real class, never a proxy. */
class ProgrammaticBuiltinPlugin {
    readonly id = 'lazy-programmatic-builtin';
    readonly name = 'Programmatic Built-in';
    readonly version = '1.0.0';
    readonly category = 'utility';
    readonly capabilities: string[] = [];

    async onLoad(): Promise<void> {
        const counts = (globalCounts.__lazyBuiltinOnload = globalCounts.__lazyBuiltinOnload ?? {});
        counts[this.id] = (counts[this.id] ?? 0) + 1;
    }

    async onUnload(): Promise<void> {}
}

describe('PluginBootstrapService — PLUGIN_EAGER_BUILTINS (disk builtIns, real loader + lazy proxy)', () => {
    let registry: PluginRegistryService;
    let repo: { upsert: jest.Mock; updateState: jest.Mock; findByPluginId: jest.Mock };
    let loadedEvents: string[];
    const savedEnv: Record<string, string | undefined> = {};

    function build(extra?: Partial<PluginsModuleOptions>): PluginBootstrapService {
        const options: PluginsModuleOptions = {
            pluginPaths: [FIXTURES],
            platformVersion: '1.0.0',
            ...extra,
        };
        const emitter = new EventEmitter2();
        emitter.on(PluginEvents.LOADED, (event: { pluginId: string }) => {
            loadedEvents.push(event.pluginId);
        });
        registry = new PluginRegistryService(emitter);
        const pluginRepository = repo as unknown as PluginRepository;
        const loader = new PluginLoaderService(
            options,
            registry,
            new PluginManifestValidatorService(),
            new PluginVersionCheckerService(options),
            new PluginClassValidatorService(),
            pluginRepository,
        );
        const lifecycle = new PluginLifecycleManagerService(
            registry,
            pluginRepository,
            emitter,
            new CustomCapabilityRegistryService(),
        );
        const contextFactory = {
            createContext: (pluginId: string) => ({ pluginId }),
        } as unknown as PluginContextFactoryService;
        return new PluginBootstrapService(
            loader,
            lifecycle,
            contextFactory,
            registry,
            pluginRepository,
        );
    }

    function proxyOf(pluginId: string): LazyPluginStub {
        return registry.get(pluginId)?.plugin as LazyPluginStub;
    }

    function errorWritesFor(pluginId: string): unknown[][] {
        return repo.updateState.mock.calls.filter(
            (call: unknown[]) => call[0] === pluginId && call[1] === 'error',
        );
    }

    function loadedEventsFor(pluginId: string): number {
        return loadedEvents.filter((id) => id === pluginId).length;
    }

    beforeEach(() => {
        PluginBootstrapService.resetForTesting();
        globalCounts.__lazyBuiltinOnload = {};
        loadedEvents = [];
        repo = {
            upsert: jest.fn().mockResolvedValue(undefined),
            updateState: jest.fn().mockResolvedValue(undefined),
            findByPluginId: jest.fn().mockResolvedValue(null),
        };
        for (const key of ['PLUGIN_LAZY_LOAD', 'PLUGIN_EAGER_BUILTINS', ENV_KEY]) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        PluginBootstrapService.resetForTesting();
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    describe('PLUGIN_EAGER_BUILTINS=true', () => {
        it('materialises disk builtIns at boot and runs each onLoad once', async () => {
            process.env.PLUGIN_EAGER_BUILTINS = 'true';

            await build().bootstrap({ force: true });

            expect(proxyOf('lazy-builtin').__isMaterialized).toBe(true);
            expect(onLoadCount('lazy-builtin')).toBe(1);
            expect(onLoadCount('lazy-builtin-onload-throws')).toBe(1);
            expect(registry.get('lazy-builtin-onload-throws')?.state).toBe('error');
            expect(registry.get('lazy-builtin-missing-entry')?.state).toBe('error');
            expect(registry.get('lazy-builtin')?.manifest.defaultForCapabilities).toEqual([
                'lazy-fixture',
            ]);
        });
    });

    describe.each([
        ['unset (the default)', undefined],
        ['false', 'false'],
    ])('PLUGIN_EAGER_BUILTINS %s', (_label, value) => {
        beforeEach(() => {
            if (value !== undefined) process.env.PLUGIN_EAGER_BUILTINS = value;
        });

        it('leaves a disk builtIn cold at boot, then runs its onLoad once on first use', async () => {
            const result = await build().bootstrap({ force: true });

            expect(result.executed).toBe(true);
            const plugin = proxyOf('lazy-builtin');
            expect(plugin.__isMaterialized).toBe(false);
            expect(registry.get('lazy-builtin')?.state).toBe('loaded');
            expect(onLoadCount('lazy-builtin')).toBe(0);
            expect(loadedEventsFor('lazy-builtin')).toBe(0);

            await plugin.__materialize({ waitForLoad: true });

            expect(plugin.__isMaterialized).toBe(true);
            expect(onLoadCount('lazy-builtin')).toBe(1);
            expect(loadedEventsFor('lazy-builtin')).toBe(1);
            expect(registry.get('lazy-builtin')?.state).toBe('loaded');
        });

        it('records a failing builtIn onLoad as error once, on first use instead of at boot', async () => {
            await build().bootstrap({ force: true });

            expect(onLoadCount('lazy-builtin-onload-throws')).toBe(0);
            expect(registry.get('lazy-builtin-onload-throws')?.state).toBe('loaded');
            expect(errorWritesFor('lazy-builtin-onload-throws')).toHaveLength(0);

            await proxyOf('lazy-builtin-onload-throws').__materialize({ waitForLoad: true });

            expect(onLoadCount('lazy-builtin-onload-throws')).toBe(1);
            expect(registry.get('lazy-builtin-onload-throws')?.state).toBe('error');
            expect(errorWritesFor('lazy-builtin-onload-throws')).toHaveLength(1);
        });

        it('records a builtIn whose entry module is missing as error once, on first use', async () => {
            await build().bootstrap({ force: true });

            expect(registry.get('lazy-builtin-missing-entry')?.state).toBe('loaded');
            expect(errorWritesFor('lazy-builtin-missing-entry')).toHaveLength(0);

            await expect(proxyOf('lazy-builtin-missing-entry').__materialize()).rejects.toThrow();

            expect(registry.get('lazy-builtin-missing-entry')?.state).toBe('error');
            expect(errorWritesFor('lazy-builtin-missing-entry')).toHaveLength(1);
            expect(registry.get('lazy-builtin')?.state).toBe('loaded');
        });

        it('still runs onLoad at boot for a programmatic builtInPlugins entry (a real instance)', async () => {
            await build({
                builtInPlugins: [
                    { plugin: ProgrammaticBuiltinPlugin as unknown as PluginModule['plugin'] },
                ],
            }).bootstrap({ force: true });

            expect(onLoadCount('lazy-programmatic-builtin')).toBe(1);
            expect(loadedEventsFor('lazy-programmatic-builtin')).toBe(1);
            expect(proxyOf('lazy-builtin').__isMaterialized).toBe(false);
        });

        it("resolves a cold builtIn's settings from its real schema, x-envVar binding included", async () => {
            process.env[ENV_KEY] = 'fixture-env-secret';
            await build().bootstrap({ force: true });
            expect(proxyOf('lazy-builtin').__isMaterialized).toBe(false);

            const settings = new PluginSettingsService(
                registry,
                repo as unknown as PluginRepository,
                {
                    findByUserAndPlugin: jest.fn().mockResolvedValue(null),
                } as unknown as UserPluginRepository,
                {
                    findByWorkAndPlugin: jest.fn().mockResolvedValue(null),
                } as unknown as WorkPluginRepository,
                new EventEmitter2(),
            );
            const resolved = await settings.getResolvedSettings('lazy-builtin', {
                includeSecrets: true,
            });

            expect(resolved.apiKey).toEqual(
                expect.objectContaining({ value: 'fixture-env-secret', source: 'env' }),
            );
            expect(onLoadCount('lazy-builtin')).toBe(1);
        });

        it('folds the runtime manifest (getManifest) into the registry entry only once the builtIn materialises', async () => {
            // Some builtIns declare selection fields only in getManifest()
            // (openrouter's default ai-provider flag): the readers that pick a
            // provider from them load their candidates first.
            await build().bootstrap({ force: true });

            expect(registry.get('lazy-builtin')?.manifest.defaultForCapabilities).toBeUndefined();

            await proxyOf('lazy-builtin').__materialize({ waitForLoad: true });

            expect(registry.get('lazy-builtin')?.manifest.defaultForCapabilities).toEqual([
                'lazy-fixture',
            ]);
        });

        it('selects a cold builtIn by the default its getManifest() declares, then runs its onLoad once', async () => {
            await build().bootstrap({ force: true });
            expect(proxyOf('lazy-builtin').__isMaterialized).toBe(false);

            const chosen = await registry.getDefaultForCapabilityScoped(
                'lazy-fixture',
                undefined,
                'user-1',
            );
            const enabled = await registry.getEnabledPluginsScoped(
                'lazy-fixture',
                undefined,
                'user-1',
            );

            expect(chosen?.plugin.id).toBe('lazy-builtin');
            expect(enabled.map((entry) => entry.manifest.defaultForCapabilities)).toEqual([
                ['lazy-fixture'],
            ]);
            expect(proxyOf('lazy-builtin').settingsSchema).toEqual(
                expect.objectContaining({ required: ['apiKey'] }),
            );
            expect(onLoadCount('lazy-builtin')).toBe(1);
        });

        it('stays fully eager when PLUGIN_LAZY_LOAD=false (the lazy-load kill switch wins)', async () => {
            process.env.PLUGIN_LAZY_LOAD = 'false';

            await build().bootstrap({ force: true });

            const plugin = registry.get('lazy-builtin')?.plugin as unknown as Record<
                string,
                unknown
            >;
            expect(typeof plugin.__materialize).toBe('undefined');
            expect(onLoadCount('lazy-builtin')).toBe(1);
        });
    });
});
