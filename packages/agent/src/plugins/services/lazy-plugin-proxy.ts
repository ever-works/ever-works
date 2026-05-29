import type { IPlugin, PluginManifest } from '@ever-works/plugin';

/**
 * Loader closure that imports the real plugin module on demand.
 * Returns the instantiated plugin (or null on failure — caller decides how to surface).
 */
export type PluginInstanceLoader = () => Promise<IPlugin | null>;

/**
 * Lazy plugin stub used by the registry while the real module has not been
 * imported yet. Exposes manifest-derived static properties synchronously so
 * callers that only need metadata pay no import cost. Any method call on the
 * proxy awaits a deduped import + onLoad of the real plugin before forwarding.
 */
export interface LazyPluginStub extends IPlugin {
    /** True once the underlying real plugin instance has been materialized. */
    readonly __isMaterialized: boolean;
    /**
     * Force materialization (import + onLoad) and return the real plugin.
     * Concurrent callers share a single import + onLoad invocation.
     */
    __materialize(): Promise<IPlugin>;
}

/**
 * Optional hook fired the first time a plugin materializes. The lifecycle
 * manager wires this to its callOnLoad bookkeeping so events/state updates
 * still happen exactly once even though materialization is now triggered by
 * the first method call rather than at boot.
 */
export type OnFirstMaterialize = (pluginId: string, real: IPlugin) => Promise<void>;

const FORWARDED_LIFECYCLE_METHODS = new Set<keyof IPlugin>([
    'onLoad',
    'onUnload',
    'healthCheck',
    'getManifest',
    'validateSettings',
    'validateConnection',
]);

/**
 * Build a lazy IPlugin proxy backed by `manifest` for sync reads and `loader`
 * for first-use materialization. `onFirstMaterialize` runs exactly once after
 * a successful import, before the triggering method call is forwarded — this
 * is where the lifecycle manager hooks its onLoad event emission.
 */
export function createLazyPluginProxy(
    manifest: PluginManifest,
    loader: PluginInstanceLoader,
    onFirstMaterialize?: OnFirstMaterialize,
): LazyPluginStub {
    let materialized: IPlugin | null = null;
    let importPromise: Promise<IPlugin> | null = null;

    const ensureMaterialized = async (): Promise<IPlugin> => {
        if (materialized) return materialized;
        if (!importPromise) {
            importPromise = (async () => {
                const real = await loader();
                if (!real) {
                    throw new Error(`Failed to materialize plugin "${manifest.id}"`);
                }
                materialized = real;
                if (onFirstMaterialize) {
                    await onFirstMaterialize(manifest.id, real);
                }
                return real;
            })().catch((err) => {
                // Reset so a later call can retry (e.g. transient FS error).
                importPromise = null;
                throw err;
            });
        }
        return importPromise;
    };

    // PluginManifest (the package.json `everworks.plugin` block) does not
    // carry the JSON-Schema or configurationMode today — those live on the
    // plugin class. Until a sync caller forces materialization, expose an
    // empty schema. See PR body "Known caveat — settingsSchema sync access".
    const manifestExt = manifest as unknown as Record<string, unknown>;
    const stub = {
        get id() {
            return manifest.id;
        },
        get name() {
            return manifest.name;
        },
        get version() {
            return manifest.version;
        },
        get category() {
            return manifest.category;
        },
        get capabilities() {
            return manifest.capabilities;
        },
        get settingsSchema() {
            return manifestExt.settingsSchema ?? {};
        },
        get configurationMode() {
            return manifestExt.configurationMode;
        },
        get __isMaterialized() {
            return materialized !== null;
        },
        __materialize: ensureMaterialized,
    } as unknown as LazyPluginStub;

    return new Proxy(stub, {
        get(target, prop, receiver) {
            if (prop in target) {
                return Reflect.get(target, prop, receiver);
            }
            // Special-case onUnload: skip materialization if never loaded —
            // a plugin that was never used has no resources to release.
            if (prop === 'onUnload') {
                return async () => {
                    if (!materialized) return;
                    const real = materialized as IPlugin;
                    return real.onUnload();
                };
            }
            // For every other method (lifecycle hooks + plugin-specific
            // subclass methods like generate/extract/etc.), materialize then
            // forward.
            const propKey = prop as keyof IPlugin;
            const isLifecycle = FORWARDED_LIFECYCLE_METHODS.has(propKey);

            return (...args: unknown[]) => {
                return ensureMaterialized().then((real) => {
                    const target = real as unknown as Record<string | symbol, unknown>;
                    const fn = target[prop];
                    if (typeof fn !== 'function') {
                        if (isLifecycle) {
                            // Optional lifecycle method missing on real plugin —
                            // mirror native "undefined" behavior.
                            return undefined;
                        }
                        throw new TypeError(
                            `Plugin "${manifest.id}" has no method "${String(prop)}"`,
                        );
                    }
                    return (fn as (...a: unknown[]) => unknown).apply(real, args);
                });
            };
        },
        has(target, prop) {
            if (prop in target) return true;
            // Optimistic: assume the real plugin has it. Callers that probe
            // via `in` typically check for optional lifecycle methods, and
            // we'd rather over-report than force materialization for a probe.
            return true;
        },
    }) as LazyPluginStub;
}
