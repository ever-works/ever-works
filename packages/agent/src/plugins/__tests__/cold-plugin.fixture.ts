import { EventEmitter2 } from '@nestjs/event-emitter';
import type { IPlugin, JsonSchema, PluginManifest } from '@ever-works/plugin';
import { PluginRegistryService, type RegisteredPlugin } from '../services/plugin-registry.service';
import type { LazyPluginStub } from '../services/lazy-plugin-proxy';

/**
 * Shared fixture for the "cold plugin" specs: a REAL `PluginRegistryService`
 * whose plugins are REAL lazy proxies (`registerLazy` → `createLazyPluginProxy`),
 * exactly as the loader registers every plugin it discovers on disk.
 *
 * Until such a proxy is materialised, `settingsSchema` answers `{}` and
 * `configurationMode` answers `undefined` (the package.json manifest carries
 * neither). A reader that looks at either one synchronously therefore sees
 * no fields, no `required` list, no `x-envVar` binding and the `hybrid`
 * default. The specs built on this fixture prove each reader awaits the real
 * class values first.
 */

/** A schema with one required secret. `envVar` also binds it to an env var. */
export function requiredSecretSchema(envVar?: string): JsonSchema {
    return {
        type: 'object',
        properties: {
            apiKey: {
                type: 'string',
                title: 'API key',
                'x-secret': true,
                ...(envVar ? { 'x-envVar': envVar } : {}),
            },
            region: {
                type: 'string',
                default: 'eu',
                'x-scope': 'work',
            },
        },
        required: ['apiKey'],
    } as unknown as JsonSchema;
}

export interface ColdPluginSpec {
    id: string;
    category?: string;
    capabilities?: string[];
    settingsSchema: JsonSchema;
    configurationMode?: 'hybrid' | 'admin-only' | 'user-only';
    /** Extra members of the REAL instance (plugin-specific methods). */
    members?: Record<string, unknown>;
    /** Extra package.json manifest fields (autoEnable, systemPlugin, …). */
    manifest?: Partial<PluginManifest> & Record<string, unknown>;
    /**
     * What the class's `getManifest()` adds on top of package.json (icon,
     * uiHints, defaultForCapabilities, supplementary, …). Folded into the
     * registry entry on first materialise, exactly as
     * `PluginLoaderService.enrichManifestAfterMaterialize` does: a field the
     * package.json manifest sets wins.
     */
    runtimeManifest?: Partial<PluginManifest> & Record<string, unknown>;
    /** The import fails: the loader rejects. */
    failing?: boolean;
    /**
     * The import succeeds but `onLoad` throws; the first-materialise hook
     * records `error` on the entry, as `PluginLifecycleManagerService.callOnLoad`
     * does, and the materialise itself still resolves.
     */
    onLoadFails?: boolean;
    /**
     * Holds the first-materialise hook AFTER the proxy has marked itself
     * materialised (and the runtime manifest is folded in) but BEFORE `onLoad`
     * has completed, until this promise settles — the window of a slow
     * `onLoad` (the real loader used to await its manifest DB upsert here too,
     * before `callOnLoad`). A second caller arriving then finds
     * `__isMaterialized` already true and the entry still `loaded`.
     */
    firstLoadGate?: Promise<unknown>;
    /**
     * Register it as a `builtIn` (package.json `builtIn: true`), as every real
     * plugin whose `getManifest()` adds list fields (visibility, uiHints,
     * supplementary) is. Default `false`: a plugin a list leaves cold unless
     * the list's viewer (the user, or the Work) has enabled it.
     */
    builtIn?: boolean;
    /**
     * Counts this plugin's first load while it is in flight (import started,
     * first-materialise hook not finished) on a tracker several plugins share.
     * The import then yields a macrotask, so loads started together overlap.
     */
    loadTracker?: LoadTracker;
}

/** How many fixture first loads are in flight now, and at most so far. */
export interface LoadTracker {
    active: number;
    peak: number;
}

export function loadTracker(): LoadTracker {
    return { active: 0, peak: 0 };
}

export interface ColdPlugin {
    registered: RegisteredPlugin;
    proxy: LazyPluginStub;
    /** How many times the loader (the "import") ran. */
    loads(): number;
    /** Whether the real instance's `onLoad` has run to completion. */
    onLoadDone(): boolean;
}

/**
 * The real instance's `ping()`, which every fixture plugin has: it answers
 * `'pong'` once `onLoad` has completed and throws before — as a plugin that
 * sets its client or context up in `onLoad` fails when used too early.
 */
export interface Pingable {
    ping(): string;
}

/** A deferred promise, for {@link ColdPluginSpec.firstLoadGate}. */
export function gate(): { promise: Promise<void>; release(): void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

/**
 * Let every pending import and hook step run until it blocks on something
 * that is not yet settled (a gate). The fixture's loader and hooks use no
 * timers, so one macrotask turn drains them.
 */
export function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

/** A real registry, as the plugins module builds it (no scope repositories). */
export function createRegistry(): PluginRegistryService {
    return new PluginRegistryService(new EventEmitter2());
}

/**
 * Register `spec` on `registry` as a lazy proxy. The materialise-failure hook
 * records `error` on the entry, as `PluginBootstrapService` wires it.
 */
export function registerColdPlugin(
    registry: PluginRegistryService,
    spec: ColdPluginSpec,
): ColdPlugin {
    const category = spec.category ?? 'utility';
    const capabilities = spec.capabilities ?? ['test'];
    const manifest = {
        id: spec.id,
        name: `Plugin ${spec.id}`,
        version: '1.0.0',
        description: `Cold fixture plugin ${spec.id}`,
        category,
        capabilities,
        ...(spec.manifest ?? {}),
    } as PluginManifest;

    let loads = 0;
    let onLoadDone = false;
    const tracker = spec.loadTracker;
    const loader = async (): Promise<IPlugin | null> => {
        loads += 1;
        if (tracker) {
            tracker.active += 1;
            tracker.peak = Math.max(tracker.peak, tracker.active);
            await settle();
        }
        if (spec.failing) {
            if (tracker) tracker.active -= 1;
            throw new Error(`fixture: cannot import ${spec.id}`);
        }
        const instance: Record<string, unknown> = {
            id: spec.id,
            name: `Plugin ${spec.id}`,
            version: '1.0.0',
            category,
            capabilities,
            settingsSchema: spec.settingsSchema,
            configurationMode: spec.configurationMode ?? 'hybrid',
            onLoad: async () => {
                if (spec.onLoadFails) throw new Error(`fixture: ${spec.id} onLoad failed`);
                onLoadDone = true;
            },
            onUnload: async () => undefined,
            ping: () => {
                if (!onLoadDone) throw new Error(`fixture: ${spec.id} used before its onLoad ran`);
                return 'pong';
            },
            ...(spec.members ?? {}),
        };
        if (spec.runtimeManifest) {
            const runtime = spec.runtimeManifest;
            instance.getManifest = () => ({ ...manifest, ...runtime });
        }
        return instance as unknown as IPlugin;
    };

    const registered = registry.registerLazy(manifest, loader, {
        builtIn: spec.builtIn ?? false,
        // The loader's hook, then the lifecycle manager's (callOnLoad).
        onFirstMaterialize: async (pluginId, real) => {
            try {
                if (spec.runtimeManifest) {
                    const defined = Object.fromEntries(
                        Object.entries(manifest).filter(([, value]) => value !== undefined),
                    );
                    registry.updateRegisteredManifest(pluginId, {
                        ...spec.runtimeManifest,
                        ...defined,
                    } as PluginManifest);
                }
                // Held here: whatever the hook awaits before onLoad has run.
                if (spec.firstLoadGate) await spec.firstLoadGate;
                try {
                    await real.onLoad({} as never);
                } catch (error) {
                    registry.updateState(pluginId, 'error', error as Error);
                }
            } finally {
                if (tracker) tracker.active -= 1;
            }
        },
        onMaterializeError: async (pluginId, error) => {
            registry.updateState(pluginId, 'error', error);
        },
    });

    return {
        registered,
        proxy: registered.plugin as LazyPluginStub,
        loads: () => loads,
        onLoadDone: () => onLoadDone,
    };
}
