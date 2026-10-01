import { AsyncLocalStorage } from 'node:async_hooks';
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
 * ## The first load
 *
 * The first use imports the plugin, marks the proxy materialised
 * (`__isMaterialized`), then runs the first-materialise hook — the loader's
 * manifest fold, `onLoad` (the lifecycle manager's `callOnLoad`) and the
 * manifest DB upsert. The first load has SETTLED once that hook has finished,
 * successfully or not. Until then:
 *
 * - a caller OUTSIDE that load — another request, another plugin — waits for
 *   it: `__materialize()` (with or without `waitForLoad`) and every method it
 *   calls through the proxy resolve only once the load has settled. So it never
 *   runs the plugin before `onLoad` has run, and when `onLoad` failed, the
 *   registry entry already says `error` by the time it is answered (callers
 *   re-check it with `pluginLoadFailure`).
 * - code running INSIDE it — the hook, the plugin's own `onLoad`, anything they
 *   await (`context.getSettings` → `loadPluginSchema`, a call to the plugin
 *   through the proxy) — is answered at once: it could never wait on itself.
 *   An `AsyncLocalStorage` marker, set while the hook runs, tells the two
 *   apart. A `waitForLoad` from in there REJECTS instead of hanging.
 * - a caller inside ANOTHER plugin's first load waits too, unless that wait
 *   would close a cycle (this plugin's first load already waits, directly or
 *   through other first loads, on the caller's): then a plain call is answered
 *   at once and a `waitForLoad` rejects, rather than both hanging. A first load
 *   STARTED from inside this plugin's first load (its onLoad loads a second
 *   plugin) counts as one it waits on: when that second plugin's load then
 *   waits back on this one, the wait is refused the same way, and the error
 *   names the second plugin as the waiter.
 *
 * The marker is inherited by everything a first load starts, awaited or not:
 * work an `onLoad` begins WITHOUT awaiting it (a background task, a timer)
 * counts as inside that load until the load settles. Until then, such work is
 * answered this plugin at once (possibly before its `onLoad` has finished),
 * and a `waitForLoad` it makes on this plugin, or on a plugin whose first load
 * it started, is refused as above even when nothing would actually hang. So
 * work an `onLoad` leaves running should not `waitForLoad` other plugins
 * before that `onLoad` has settled; a plain use of them works.
 *
 * When the first load FAILED — `onLoad` threw and the lifecycle's `callOnLoad`
 * put the registry entry in `error` (`firstLoadFailure` answers why) — a
 * method called through the proxy by a caller that waited for that load is
 * refused with that reason instead of running on the half-initialised
 * instance: the eager boot never selected such a plugin. `__materialize`
 * still resolves (callers re-check the entry with `pluginLoadFailure`), and
 * once settled the proxy answers the real members as for any loaded plugin.
 *
 * ## Reading a member the manifest does not carry
 *
 * - **Once the first load has settled** (and from inside it), every such read
 *   answers the REAL instance's value: a data member (`providerName`,
 *   `handledConfigFields`, a getter) is that value, a method is the real method
 *   bound to the real instance (a sync method stays sync), and a member the
 *   plugin lacks is `undefined` — so `typeof`/`in`/`?.()` probes of optional
 *   members are truthful.
 * - **While the first load is settling**, a caller outside it reads a data
 *   member's real value, but a method as an async wrapper that waits for the
 *   load, then calls the real method (a sync method's result arrives as a
 *   Promise meanwhile).
 * - **While cold**, the proxy cannot tell a data member from a method without
 *   importing the plugin, and method calls on a cold proxy (plugin-specific
 *   ones included) must keep working. So such a read answers an async
 *   forwarding wrapper: calling it loads the plugin and forwards the call
 *   (rejecting with `has no method` when the member is not a function), the
 *   read itself imports nothing, and `in` answers `true`. A caller that needs a
 *   data member, a sync result or a truthful probe loads the plugin first
 *   (`__materialize`, `materializePlugin`, `loadRegisteredPlugins`).
 *
 * `then`/`catch`/`finally` and symbol-keyed reads answer `undefined` in every
 * state, and `toJSON` answers `undefined` while cold (see the `get` trap).
 * Names the stub itself carries — the manifest getters, `__isMaterialized`,
 * `__materialize` and the `Object.prototype` members such as `constructor`
 * and `toString` — are answered by the stub in every state.
 */
export interface LazyPluginStub extends IPlugin {
    /**
     * True once the real plugin has been IMPORTED — already while its
     * first-materialise hook (onLoad) is still running. It says the class's
     * `settingsSchema`, `configurationMode` and runtime manifest are readable,
     * not that onLoad has settled.
     */
    readonly __isMaterialized: boolean;
    /**
     * Force materialization (import + onLoad) and return the real plugin once
     * its first load has SETTLED, the first-materialise hook (onLoad) included.
     * Concurrent callers share a single import + onLoad.
     *
     * Called from inside that first load itself (the plugin's own onLoad, or
     * code it awaits), it answers the instance at once — waiting would wait on
     * itself — while `{ waitForLoad: true }` REJECTS there, with an error that
     * says so. Pass `waitForLoad` when the caller must never be answered
     * before onLoad has settled, wherever it is called from (the execution
     * router, the `run-plugin-operation` worker task, the facades).
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
 * Optional: asked when a method call that waited for the plugin's first load
 * is about to run, once that load has settled — why the plugin cannot be used
 * (its first load failed: `onLoad` threw, and the registry entry is in
 * `error`), or `null` when it can. The registry wires it to its entry's state.
 */
export type FirstLoadFailure = () => string | null;

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

/** One per proxy: names a first load in {@link firstLoadScope} and {@link firstLoadWaits}. */
interface FirstLoadToken {
    readonly pluginId: string;
}

/**
 * The first loads (first-materialise hooks) the current async context runs
 * inside, innermost last. The proxy sets it around its hook; everything the
 * hook starts or awaits inherits it.
 */
const firstLoadScope = new AsyncLocalStorage<readonly FirstLoadToken[]>();

/**
 * The waits in progress between first loads: a first load whose hook is
 * waiting → the first loads it waits for (counted: the same wait can be made
 * more than once at a time). Only used to refuse a wait that closes a cycle.
 */
const firstLoadWaits = new Map<FirstLoadToken, Map<FirstLoadToken, number>>();

function addFirstLoadWait(from: FirstLoadToken, to: FirstLoadToken): void {
    const targets = firstLoadWaits.get(from) ?? new Map<FirstLoadToken, number>();
    targets.set(to, (targets.get(to) ?? 0) + 1);
    firstLoadWaits.set(from, targets);
}

function removeFirstLoadWait(from: FirstLoadToken, to: FirstLoadToken): void {
    const targets = firstLoadWaits.get(from);
    if (!targets) return;
    const remaining = (targets.get(to) ?? 0) - 1;
    if (remaining > 0) targets.set(to, remaining);
    else targets.delete(to);
    if (targets.size === 0) firstLoadWaits.delete(from);
}

/** Whether `start` is, or waits directly or transitively on, one of `targets`. */
function firstLoadReaches(start: FirstLoadToken, targets: readonly FirstLoadToken[]): boolean {
    const seen = new Set<FirstLoadToken>();
    const pending = [start];
    while (pending.length > 0) {
        const token = pending.pop()!;
        if (targets.includes(token)) return true;
        if (seen.has(token)) continue;
        seen.add(token);
        for (const next of firstLoadWaits.get(token)?.keys() ?? []) pending.push(next);
    }
    return false;
}

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
 * Whether `plugin` is a lazy proxy that has not imported its plugin yet: its
 * registry entry carries the package.json manifest alone, and its
 * `settingsSchema` / `configurationMode` answer `{}` / `undefined`. A real
 * plugin instance (bundled, programmatic, eager mode) is never cold.
 */
export function isColdLazyPlugin(plugin: unknown): boolean {
    if (!plugin || typeof plugin !== 'object') return false;
    const lazy = plugin as Partial<Pick<LazyPluginStub, '__isMaterialized' | '__materialize'>>;
    return typeof lazy.__materialize === 'function' && lazy.__isMaterialized === false;
}

/**
 * Build a lazy IPlugin proxy backed by `manifest` for sync reads and `loader`
 * for first-use materialization. `onFirstMaterialize` runs exactly once after
 * a successful import, before the triggering method call is forwarded — this
 * is where the lifecycle manager hooks its onLoad event emission.
 * `firstLoadFailure` tells a method call that waited for that first load
 * whether the load left the plugin unusable (see {@link LazyPluginStub}).
 */
export function createLazyPluginProxy(
    manifest: PluginManifest,
    loader: PluginInstanceLoader,
    onFirstMaterialize?: OnFirstMaterialize,
    onMaterializeError?: OnMaterializeError,
    firstLoadFailure?: FirstLoadFailure,
): LazyPluginStub {
    /** The real plugin once imported. Never reset: a failed HOOK keeps it. */
    let instance: IPlugin | null = null;
    /** The first load (the hook included) has finished, successfully or not. */
    let settled = false;
    let importPromise: Promise<IPlugin> | null = null;
    const token: FirstLoadToken = { pluginId: manifest.id };

    /** Whether the calling code runs inside this plugin's own first load. */
    const insideOwnFirstLoad = (): boolean => firstLoadScope.getStore()?.includes(token) === true;

    /** The shared import + first-materialise hook, started if nothing has yet. */
    const startFirstLoad = (): Promise<IPlugin> => {
        if (!importPromise) {
            importPromise = (async () => {
                const real = await loader();
                if (!real) {
                    throw new Error(`Failed to materialize plugin "${manifest.id}"`);
                }
                instance = real;
                try {
                    if (onFirstMaterialize) {
                        // Everything the hook runs or awaits carries this
                        // plugin's token: that is how a call from inside it
                        // (onLoad reading its own settings) is told from a
                        // caller that must wait for it.
                        const scope = [...(firstLoadScope.getStore() ?? []), token];
                        await firstLoadScope.run(scope, () =>
                            onFirstMaterialize(manifest.id, real),
                        );
                    }
                } finally {
                    settled = true;
                }
                return real;
            })().catch(async (err) => {
                // Reset so a later call can retry (e.g. transient FS error).
                // After a failed HOOK the instance stays and is answered from
                // then on: the failure hook below records the error state.
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

    /**
     * The real plugin once its first load has settled. See "The first load"
     * on {@link LazyPluginStub}: who waits, who is answered at once, and when
     * `waitForLoad` rejects instead of waiting on itself.
     */
    const ensureLoaded = (waitForLoad: boolean): Promise<IPlugin> => {
        if (instance && settled) return Promise.resolve(instance);
        const scope = firstLoadScope.getStore() ?? [];
        // The first load the calling code runs in, innermost: the one that
        // would wait.
        const waiter = scope[scope.length - 1];
        if (instance && waiter === token) {
            if (!waitForLoad) return Promise.resolve(instance);
            return Promise.reject(
                new Error(
                    `Plugin "${manifest.id}" waited for its own first load to finish from ` +
                        'inside that load (its onLoad, or code onLoad awaits), which would ' +
                        'never settle. Use the plugin as it is there: waitForLoad is for ' +
                        'callers outside its first load.',
                ),
            );
        }
        const pending = startFirstLoad();
        if (!waiter) return pending;
        // Called from inside ANOTHER plugin's first load: wait like any other
        // caller, unless this plugin's first load already waits (directly or
        // through other first loads) on the caller's — then neither settles.
        // That includes a caller's load started from inside this plugin's own
        // first load (this token is further out in the scope): this load
        // started it, and may be awaiting it.
        if (firstLoadReaches(token, scope)) {
            if (!waitForLoad && instance) return Promise.resolve(instance);
            return Promise.reject(
                new Error(
                    scope.includes(token)
                        ? `The first load of plugin "${waiter.pluginId}" waited for plugin ` +
                              `"${manifest.id}", but it was started from inside ` +
                              `"${manifest.id}"'s own first load (its onLoad, or work that ` +
                              `onLoad began), which may be waiting for it: that would never ` +
                              `settle. Use "${manifest.id}" without waitForLoad there.`
                        : `The first load of plugin "${waiter.pluginId}" waited for plugin ` +
                              `"${manifest.id}", whose first load is itself waiting for ` +
                              `"${waiter.pluginId}": that would never settle.`,
                ),
            );
        }
        addFirstLoadWait(waiter, token);
        return pending.finally(() => removeFirstLoadWait(waiter, token));
    };

    /**
     * `real`, for a method call that waited through the proxy for the first
     * load — refused when that load has settled and left the plugin unusable
     * (its `onLoad` failed). A call answered before the load settled (the
     * plugin's own load, a refused cycle) is not checked: the outcome is not
     * known yet.
     */
    const usableForCall = (real: IPlugin, prop: string | symbol): IPlugin => {
        if (settled && firstLoadFailure) {
            const failure = firstLoadFailure();
            if (failure) {
                throw new Error(
                    `Not calling "${String(prop)}" after the first load of plugin ` +
                        `"${manifest.id}" failed: ${failure}`,
                );
            }
        }
        return real;
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
            // Once the real plugin is imported, its class-level JSON-Schema is
            // the source of truth (the manifest/package.json does not carry
            // it). Falling back to the manifest while cold keeps sync metadata
            // reads cheap; delegating after the import is what lets settings
            // resolution (incl. x-envVar bindings like PLUGIN_OPENROUTER_API_KEY)
            // see the real schema instead of `{}` — also from the plugin's own
            // onLoad, which runs before its first load has settled.
            const real = instance as unknown as Record<string, unknown> | null;
            if (real && real.settingsSchema !== undefined) {
                return real.settingsSchema;
            }
            return manifestExt.settingsSchema ?? {};
        },
        get configurationMode() {
            const real = instance as unknown as Record<string, unknown> | null;
            if (real && real.configurationMode !== undefined) {
                return real.configurationMode;
            }
            return manifestExt.configurationMode;
        },
        get __isMaterialized() {
            return instance !== null;
        },
        __materialize: (options?: { readonly waitForLoad?: boolean }) =>
            ensureLoaded(options?.waitForLoad === true),
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
                    if (!instance) return;
                    const real = instance as IPlugin;
                    return real.onUnload();
                };
            }
            if (instance) {
                // Loaded (or read from inside its own first load): answer the
                // real instance's member — its value, its method bound to it,
                // or `undefined` when it has none. Answering the forwarding
                // wrapper below here too made a data member read as a
                // function, a sync method return a Promise (the generator form
                // dropped agent-pipeline's fields) and every optional-member
                // probe say yes, long after the plugin had loaded. `toJSON` is
                // read as it is too (`JSON.stringify` calls it synchronously).
                if (settled || insideOwnFirstLoad() || prop === 'toJSON') {
                    return readMaterialized(instance, prop);
                }
                // Imported, first load still settling, caller outside it: a
                // data member reads as it is, but a method must not run before
                // onLoad has — it waits for the first load, then calls the
                // real method (unless that load failed).
                const value = Reflect.get(instance as object, prop, instance);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) =>
                    ensureLoaded(false).then((loaded) => {
                        const real = usableForCall(loaded, prop);
                        const fn = Reflect.get(real as object, prop, real) as (
                            ...a: unknown[]
                        ) => unknown;
                        return fn.apply(real, args);
                    });
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
                return ensureLoaded(false).then((loaded) => {
                    const real = usableForCall(loaded, prop);
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
            // Imported: the real instance answers, as the `get` trap does.
            if (instance) return prop in (instance as object);
            // Cold: optimistic — assume the real plugin has it. Callers that
            // probe via `in` typically check for optional lifecycle methods,
            // and we'd rather over-report than force materialization for a
            // probe.
            return true;
        },
    }) as LazyPluginStub;
}
