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

/**
 * Optional hook fired when materialization fails (loader throws or returns
 * null). Without this, a persistently-failing plugin holds a `'loaded'` slot
 * in the registry forever — readiness filters still return it and every
 * subsequent call re-throws into application code. Bootstrap wires this to
 * `registry.updateState(id, 'error')` + DB upsert so the failure surfaces.
 */
export type OnMaterializeError = (pluginId: string, error: Error) => Promise<void>;

/**
 * Lifecycle methods that should fall through to the materialized plugin if
 * defined. `onUnload` is handled separately (it must NOT force materialization
 * for a plugin that was never used), so it's intentionally omitted here.
 */
const FORWARDED_LIFECYCLE_METHODS = new Set<keyof IPlugin>([
    'onLoad',
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
    onMaterializeError?: OnMaterializeError,
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
            })().catch(async (err) => {
                // Reset so a later call can retry (e.g. transient FS error).
                importPromise = null;
                if (onMaterializeError) {
                    // Best-effort: surface the failure to the registry / DB so
                    // readiness filters stop returning the broken stub. We
                    // swallow hook errors so the original loader failure is
                    // what reaches the caller.
                    try {
                        await onMaterializeError(
                            manifest.id,
                            err instanceof Error ? err : new Error(String(err)),
                        );
                    } catch {
                        // ignore
                    }
                }
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
            // Once the real plugin is materialized, its class-level JSON-Schema
            // is the source of truth (the manifest/package.json does not carry
            // it). Falling back to the manifest while cold keeps sync metadata
            // reads cheap; delegating after materialization is what lets
            // settings resolution (incl. x-envVar bindings like
            // PLUGIN_OPENROUTER_API_KEY) see the real schema instead of `{}`.
            const real = materialized as unknown as Record<string, unknown> | null;
            if (real && real.settingsSchema !== undefined) {
                return real.settingsSchema;
            }
            return manifestExt.settingsSchema ?? {};
        },
        get configurationMode() {
            const real = materialized as unknown as Record<string, unknown> | null;
            if (real && real.configurationMode !== undefined) {
                return real.configurationMode;
            }
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
            // The stub is a plain object, NOT a Promise/thenable. When a
            // caller `await`s this proxy (or passes it to Promise.resolve, or
            // returns it from an async function), the runtime reads `then` to
            // detect a thenable. If the forwarding wrapper below were returned
            // for `then`, the proxy would look thenable: the runtime would
            // invoke `then(resolve, reject)`, materialize, find no real `then`
            // method, and throw `TypeError: Plugin "<id>" has no method "then"`
            // from an async tick — an UNCAUGHT rejection that crashes the whole
            // API process. The same hazard applies to inspection/coercion via
            // well-known symbols. Return undefined for those so the proxy is
            // treated as an ordinary value and is never spuriously invoked.
            if (
                prop === 'then' ||
                prop === 'catch' ||
                prop === 'finally' ||
                typeof prop === 'symbol'
            ) {
                return undefined;
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
                    const realPlugin = real as unknown as Record<string | symbol, unknown>;
                    const fn = realPlugin[prop];
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
