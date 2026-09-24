/**
 * EW-693 — which plugin method a caller may invoke BY NAME, shared by the two
 * places that do it: `PluginExecutionRouterService.dispatchSync` (in-process)
 * and the `run-plugin-operation` worker task (job runtime). One definition, so
 * the two paths cannot disagree about what is callable.
 *
 * Why it exists: the plugin registry hands out LAZY PROXIES whose `get` answers
 * a forwarding function for ANY property name, so `typeof plugin[op] ===
 * 'function'` is always true. Checked that way, "operation not found" could
 * never be answered, and `constructor`, `__materialize`, `onUnload` or
 * `toString` were callable from a request. Operations are resolved on the
 * MATERIALISED plugin instead.
 */

/** Lifecycle and plumbing names that are never operations. */
const NOT_OPERATIONS: ReadonlySet<string> = new Set([
    'constructor',
    'onLoad',
    'onUnload',
    'onEnable',
    'onDisable',
    'healthCheck',
    'getManifest',
    'getSettings',
    'validateSettings',
    'validateConnection',
    'configure',
    'initialize',
    'dispose',
]);

/**
 * Plain identifiers, optionally dot-separated (`pipeline.run` — the router's
 * taxonomy names operations that way): no `_` / `$` prefix, no symbols. A dotted
 * name is looked up as ONE literal key, never walked as a path.
 */
const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;

/**
 * The function `plugin` exposes as `operation`, or `null`. Walks the instance
 * and its prototype chain up to — never including — `Object.prototype` (or
 * `Function.prototype`), and accepts only a DATA property holding a function:
 * a getter is not an operation, and neither is a lifecycle hook, an
 * `_`-prefixed name or anything that is not a plain identifier. Public helper
 * methods of a plugin class remain callable; a manifest-declared operation
 * list would narrow that further.
 */
export function resolvePluginOperation(
    plugin: object,
    operation: unknown,
): ((...args: unknown[]) => unknown) | null {
    if (typeof operation !== 'string' || !OPERATION_NAME.test(operation)) return null;
    if (NOT_OPERATIONS.has(operation)) return null;
    for (
        let owner: object | null = plugin;
        owner && owner !== Object.prototype && owner !== Function.prototype;
        owner = Object.getPrototypeOf(owner) as object | null
    ) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, operation);
        if (descriptor) {
            return typeof descriptor.value === 'function'
                ? (descriptor.value as (...args: unknown[]) => unknown)
                : null;
        }
    }
    return null;
}

/**
 * The real plugin behind a registry entry: a lazy proxy is materialised (its
 * `__materialize` loads and caches the real instance); anything else is
 * returned as it is. Rejects when the plugin will not load.
 */
export async function materializePlugin(plugin: unknown): Promise<object> {
    const lazy = plugin as { __materialize?: unknown };
    if (typeof lazy.__materialize === 'function') {
        return (await (lazy.__materialize as () => Promise<object>)()) as object;
    }
    return plugin as object;
}
