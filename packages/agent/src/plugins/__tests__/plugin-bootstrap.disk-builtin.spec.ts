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
import type { LazyPluginStub } from '../services/lazy-plugin-proxy';
import { PluginRepository } from '../repositories/plugin.repository';
import { PluginEvents } from '../plugins.constants';
import type {
    PluginModule,
    PluginsModuleOptions,
} from '../interfaces/plugins-module-options.interface';

/**
 * Bootstrap against the REAL loader, registry, lifecycle manager and lazy
 * proxy, over plugins discovered on disk (`fixtures/bootstrap-onload/`).
 *
 * A plugin whose package.json says `builtIn: true` is still DISCOVERED on disk,
 * so the loader registers it as a lazy proxy like any other; bootstrap then
 * loads it at boot. Calling `callOnLoad` on that proxy ran `onLoad` twice: the
 * proxy's `onLoad` materialised the plugin, whose first-materialise hook ran
 * `callOnLoad` (onLoad #1), and then forwarded the original call (onLoad #2).
 * The mocked `plugin-bootstrap.service.spec.ts` cannot see that — its registry
 * entries carry no proxy — hence this spec.
 */

// Silence Logger output during tests
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const FIXTURES = path.join(__dirname, 'fixtures', 'bootstrap-onload');

type OnloadCounts = Record<string, number>;
const globalCounts = globalThis as unknown as { __bootstrapOnload?: OnloadCounts };

function onLoadCount(pluginId: string): number {
    return globalCounts.__bootstrapOnload?.[pluginId] ?? 0;
}

/** A programmatic `builtInPlugins` entry: a real class, never a proxy. */
class ProgrammaticBuiltinPlugin {
    readonly id = 'programmatic-builtin';
    readonly name = 'Programmatic Built-in';
    readonly version = '1.0.0';
    readonly category = 'utility';
    readonly capabilities: string[] = [];

    async onLoad(): Promise<void> {
        const counts = (globalCounts.__bootstrapOnload = globalCounts.__bootstrapOnload ?? {});
        counts[this.id] = (counts[this.id] ?? 0) + 1;
    }

    async onUnload(): Promise<void> {}
}

describe('PluginBootstrapService — plugins discovered on disk (real loader + lazy proxy)', () => {
    let registry: PluginRegistryService;
    let repo: {
        upsert: jest.Mock;
        updateState: jest.Mock;
        findByPluginId: jest.Mock;
    };
    let loadedEvents: string[];
    let savedLazyEnv: string | undefined;

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

    function stateOf(pluginId: string): string | undefined {
        return registry.get(pluginId)?.state;
    }

    function loadedEventsFor(pluginId: string): number {
        return loadedEvents.filter((id) => id === pluginId).length;
    }

    function errorWritesFor(pluginId: string): unknown[][] {
        return repo.updateState.mock.calls.filter(
            (call: unknown[]) => call[0] === pluginId && call[1] === 'error',
        );
    }

    beforeEach(() => {
        PluginBootstrapService.resetForTesting();
        globalCounts.__bootstrapOnload = {};
        loadedEvents = [];
        repo = {
            upsert: jest.fn().mockResolvedValue(undefined),
            updateState: jest.fn().mockResolvedValue(undefined),
            findByPluginId: jest.fn().mockResolvedValue(null),
        };
        // Lazy mode is the default; make sure an ambient kill switch cannot
        // flip the lazy cases into eager mode.
        savedLazyEnv = process.env.PLUGIN_LAZY_LOAD;
        delete process.env.PLUGIN_LAZY_LOAD;
    });

    afterEach(() => {
        PluginBootstrapService.resetForTesting();
        if (savedLazyEnv === undefined) {
            delete process.env.PLUGIN_LAZY_LOAD;
        } else {
            process.env.PLUGIN_LAZY_LOAD = savedLazyEnv;
        }
    });

    it('loads a disk builtIn at boot and runs its onLoad exactly once', async () => {
        const result = await build().bootstrap({ force: true });

        expect(result.executed).toBe(true);
        const plugin = registry.get('disk-builtin')?.plugin as LazyPluginStub;
        expect(plugin.__isMaterialized).toBe(true);
        expect(stateOf('disk-builtin')).toBe('loaded');
        expect(onLoadCount('disk-builtin')).toBe(1);
        expect(loadedEventsFor('disk-builtin')).toBe(1);
    });

    it('calls a failing disk builtIn onLoad once and records its error once', async () => {
        await build().bootstrap({ force: true });

        expect(onLoadCount('disk-builtin-onload-throws')).toBe(1);
        expect(stateOf('disk-builtin-onload-throws')).toBe('error');
        expect(loadedEventsFor('disk-builtin-onload-throws')).toBe(0);
        const writes = errorWritesFor('disk-builtin-onload-throws');
        expect(writes).toHaveLength(1);
        expect(writes[0]).toEqual([
            'disk-builtin-onload-throws',
            'error',
            expect.stringContaining('apiKey missing'),
        ]);
    });

    it('records a disk builtIn whose entry module is missing as error once, and boots the rest', async () => {
        const result = await build().bootstrap({ force: true });

        expect(result.executed).toBe(true);
        expect(stateOf('disk-builtin-missing-entry')).toBe('error');
        expect(errorWritesFor('disk-builtin-missing-entry')).toHaveLength(1);
        expect(stateOf('disk-builtin')).toBe('loaded');
        expect(onLoadCount('disk-builtin')).toBe(1);
    });

    it('leaves a disk plugin that is not builtIn cold until first use, then runs onLoad once', async () => {
        await build().bootstrap({ force: true });

        const plugin = registry.get('disk-lazy')?.plugin as LazyPluginStub;
        expect(plugin.__isMaterialized).toBe(false);
        expect(onLoadCount('disk-lazy')).toBe(0);
        expect(loadedEventsFor('disk-lazy')).toBe(0);

        await plugin.__materialize({ waitForLoad: true });

        expect(plugin.__isMaterialized).toBe(true);
        expect(onLoadCount('disk-lazy')).toBe(1);
        expect(loadedEventsFor('disk-lazy')).toBe(1);
        expect(stateOf('disk-lazy')).toBe('loaded');
    });

    it('PLUGIN_LAZY_LOAD=false: registers real instances and runs each onLoad once', async () => {
        process.env.PLUGIN_LAZY_LOAD = 'false';
        try {
            await build().bootstrap({ force: true });
        } finally {
            delete process.env.PLUGIN_LAZY_LOAD;
        }

        for (const id of ['disk-builtin', 'disk-lazy']) {
            const plugin = registry.get(id)?.plugin as unknown as Record<string, unknown>;
            expect(typeof plugin.__materialize).toBe('undefined');
            expect(stateOf(id)).toBe('loaded');
            expect(onLoadCount(id)).toBe(1);
            expect(loadedEventsFor(id)).toBe(1);
        }
        expect(onLoadCount('disk-builtin-onload-throws')).toBe(1);
        expect(errorWritesFor('disk-builtin-onload-throws')).toHaveLength(1);
    });

    it('runs onLoad once for a programmatic builtInPlugins entry (a real instance, not a proxy)', async () => {
        await build({
            builtInPlugins: [
                { plugin: ProgrammaticBuiltinPlugin as unknown as PluginModule['plugin'] },
            ],
        }).bootstrap({ force: true });

        const plugin = registry.get('programmatic-builtin')?.plugin as unknown as Record<
            string,
            unknown
        >;
        expect(typeof plugin.__materialize).toBe('undefined');
        expect(stateOf('programmatic-builtin')).toBe('loaded');
        expect(onLoadCount('programmatic-builtin')).toBe(1);
        expect(loadedEventsFor('programmatic-builtin')).toBe(1);
        // The disk builtIn in the same boot still loads once, through its proxy.
        expect(onLoadCount('disk-builtin')).toBe(1);
    });
});
