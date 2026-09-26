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
 *
 * ## Reading a member the manifest does not carry
 *
 * - **Once materialised** (`__isMaterialized`, which is already true while the
 *   first-materialise hook — onLoad — runs), every such read answers the REAL
 *   instance's value: a data member (`providerName`, `handledConfigFields`, a
 *   getter) is that value, a method is the real method bound to the real
 *   instance (a sync method stays sync), and a member the plugin lacks is
 *   `undefined` — so `typeof`/`in`/`?.()` probes of optional members are
 *   truthful.
 * - **While cold**, the proxy cannot tell a data member from a method without
 *   importing the plugin, and method calls on a cold proxy (plugin-specific
 *   ones included) must keep working. So such a read answers an async
 *   forwarding wrapper: calling it loads the plugin and forwards the call
 *   (rejecting with `has no method` when the member is not a function), the
 *   read itself imports nothing, and `in` answers `true`. A caller that needs a
 *   data member, a sync result or a truthful probe loads the plugin first
 *   (`__materialize`, `materializePlugin`, `loadRegisteredPlugins`).
 *
 * `then`/`catch`/`finally` and symbol-keyed reads answer `undefined` in both
 * states, and `toJSON` answers `undefined` while cold (see the `get` trap).
 * Names the stub itself carries — the manifest getters, `__isMaterialized`,
 * `__materialize` and the `Object.prototype` members such as `constructor`
 * and `toString` — are answered by the stub in both states.
 */
export interface LazyPluginStub extends IPlugin {
    /** True once the underlying real plugin instance has been materialized. */
    readonly __isMaterialized: boolean;
    /**
     * Force materialization (import + onLoad) and return the real plugin.
     * Concurrent callers share a single import + onLoad invocation — but by
     * default a caller that arrives while the first-materialise hook (onLoad)
     * is still running gets the instance at once, BEFORE onLoad has settled:
     * the hook itself calls the plugin through this proxy, so it cannot wait.
     *
     * `{ waitForLoad: true }` resolves only once that first materialization
     * has FINISHED, the hook (onLoad and its state bookkeeping) included — for
     * a caller that must not run anything before onLoad has settled (the
     * execution router, the `run-plugin-operation` worker task). Never pass it
     * from inside the plugin's own onLoad: it would wait on itself.
     */
    __materialize(options?: { readonly waitForLoad?: boolean }): Promise<IPlugin>;
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
 * A plugin's own string member — `providerName`, `sourceName` — for a reader
 * that cannot await a load (a sync provider listing, an error message).
 * Answers the value on a real or materialised plugin, and `undefined` when the
 * member is not a string: on a COLD lazy proxy that read is the forwarding
 * wrapper (a function — see {@link LazyPluginStub}), which a caller would
 * otherwise hand on as the name. The read imports nothing; the caller falls
 * back to the manifest name.
 */
export function readPluginString(plugin: unknown, key: string): string | undefined {
    if (!plugin || typeof plugin !== 'object') return undefined;
    const value = (plugin as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

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
        // `importPromise` settles only after `onFirstMaterialize`, and stays set
        // once it succeeded; `ensureMaterialized` covers "not started yet" and
        // "the hook failed" (it then answers the instance, and the failure
        // hook has recorded the error state).
        __materialize: (options?: { readonly waitForLoad?: boolean }) =>
            options?.waitForLoad ? (importPromise ?? ensureMaterialized()) : ensureMaterialized(),
    } as unknown as LazyPluginStub;

    // A materialised plugin's methods, bound to it once each, so a method read
    // twice through the proxy is the same function (`proxy.fn === proxy.fn`).
    const boundMethods = new WeakMap<(...args: unknown[]) => unknown, unknown>();
    const readMaterialized = (real: IPlugin, prop: string): unknown => {
        const value = Reflect.get(real as object, prop, real);
        if (typeof value !== 'function') return value;
        const method = value as (...args: unknown[]) => unknown;
        let bound = boundMethods.get(method);
        if (!bound) {
            bound = method.bind(real);
            boundMethods.set(method, bound);
        }
        return bound;
    };

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
            // Materialised: answer the real instance's member — its value, its
            // method bound to it, or `undefined` when it has none. Answering the
            // forwarding wrapper below here too made a data member read as a
            // function, a sync method return a Promise (the generator form
            // dropped agent-pipeline's fields) and every optional-member probe
            // say yes, long after the plugin had loaded.
            if (materialized) {
                return readMaterialized(materialized, prop);
            }
            // Cold `toJSON`: `JSON.stringify` calls it when it is a function,
            // so the wrapper below would import the plugin, serialise its
            // Promise as `{}` and leave that Promise to reject with `has no
            // method "toJSON"` — uncaught, as for `then` above. Answer
            // `undefined` so a cold stub serialises its manifest fields; a
            // plugin's own `toJSON` is honoured once it has loaded.
            if (prop === 'toJSON') {
                return undefined;
            }
            // Cold: the member's kind is unknown until the import. Answer a
            // wrapper that materializes then forwards, which serves every
            // method (lifecycle hooks + plugin-specific subclass methods like
            // generate/extract/etc.). A data member cannot be read cold — see
            // the LazyPluginStub docstring.
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
            // Materialised: the real instance answers, as the `get` trap does.
            if (materialized) return prop in (materialized as object);
            // Cold: optimistic — assume the real plugin has it. Callers that
            // probe via `in` typically check for optional lifecycle methods,
            // and we'd rather over-report than force materialization for a
            // probe.
            return true;
        },
    }) as LazyPluginStub;
}
