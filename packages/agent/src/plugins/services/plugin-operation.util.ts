import type {
    PluginExecutionProfile,
    PluginManifest,
    PluginOperationDeclaration,
    ValidationError,
} from '@ever-works/plugin';

/**
 * EW-693 — which plugin method a caller may invoke BY NAME, shared by the two
 * places that do it: `PluginExecutionRouterService.dispatchSync` (in-process)
 * and the `run-plugin-operation` worker task (job runtime). One definition, so
 * the two paths cannot disagree about what is callable.
 *
 * ## An allowlist: the manifest's `operations`
 *
 * An operation must be DECLARED in the plugin's manifest
 * (`everworks.plugin.operations`); nothing else is callable, whatever the class
 * defines. A denylist cannot work here: TypeScript `private`/`protected` are
 * erased at runtime, and this codebase marks internal methods that way rather
 * than with an `_` prefix — so a prototype walk reached helpers such as a CLI
 * plugin's prompt runner (which spawns a process with caller-chosen flags), the
 * `emitEvent`/`log*` helpers every `BasePlugin` inherits, and function-valued
 * class fields. The name rules and lifecycle denylist below still apply to a
 * declared name, as defence in depth.
 *
 * ## Resolved on the materialised plugin
 *
 * The plugin registry hands out LAZY PROXIES whose `get` answers a forwarding
 * function for ANY property name, so `typeof plugin[op] === 'function'` is
 * always true. Checked that way, "operation not found" could never be answered,
 * and `constructor`, `__materialize`, `onUnload` or `toString` were callable
 * from a request. Operations are resolved on the MATERIALISED plugin instead.
 */

/** Lifecycle and plumbing names that are never operations, declared or not. */
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

const EXECUTION_PROFILES: readonly PluginExecutionProfile[] = ['sync', 'long-running'];

/** Whether `name` could ever be an operation (the name rules and the denylist). */
function isOperationName(name: unknown): name is string {
    return typeof name === 'string' && OPERATION_NAME.test(name) && !NOT_OPERATIONS.has(name);
}

/**
 * The manifest's declaration of `operation`, or `null` when it declares none by
 * that name (or the name could never be an operation).
 */
export function findOperationDeclaration(
    manifest: Pick<PluginManifest, 'operations'> | null | undefined,
    operation: unknown,
): PluginOperationDeclaration | null {
    if (!isOperationName(operation)) return null;
    const declared = manifest?.operations;
    if (!Array.isArray(declared)) return null;
    return (
        (declared as readonly unknown[]).find(
            (entry): entry is PluginOperationDeclaration =>
                !!entry &&
                typeof entry === 'object' &&
                (entry as { name?: unknown }).name === operation,
        ) ?? null
    );
}

/**
 * The function `plugin` exposes as `operation`, or `null`.
 *
 * `operation` must be DECLARED in `manifest.operations` (see the file header),
 * and be a name that could ever be an operation. The function is then looked
 * up on the instance and its prototype chain up to — never including —
 * `Object.prototype` (or `Function.prototype`), as a DATA property holding a
 * function: a getter is not an operation.
 */
export function resolvePluginOperation(
    plugin: object,
    operation: unknown,
    manifest: Pick<PluginManifest, 'operations'> | null | undefined,
): ((...args: unknown[]) => unknown) | null {
    if (!findOperationDeclaration(manifest, operation)) return null;
    const name = operation as string;
    for (
        let owner: object | null = plugin;
        owner && owner !== Object.prototype && owner !== Function.prototype;
        owner = Object.getPrototypeOf(owner) as object | null
    ) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, name);
        if (descriptor) {
            return typeof descriptor.value === 'function'
                ? (descriptor.value as (...args: unknown[]) => unknown)
                : null;
        }
    }
    return null;
}

/**
 * Why `operation` cannot be called, for an OPERATION_NOT_FOUND message: not
 * declared at all, or declared but not implemented by the plugin class.
 */
export function describeMissingOperation(
    pluginId: string,
    operation: unknown,
    manifest: Pick<PluginManifest, 'operations'> | null | undefined,
): string {
    return findOperationDeclaration(manifest, operation)
        ? `Plugin "${pluginId}" declares operation "${String(operation)}" but does not implement it.`
        : `Plugin "${pluginId}" does not declare operation "${String(operation)}" ` +
              '(only the operations its manifest lists in `everworks.plugin.operations` can be called by name).';
}

/**
 * The manifest's `executionProfile` for `operation` alone, or `null` when the
 * declaration names none (or `operation` is not declared).
 */
export function declaredOperationProfile(
    manifest: Pick<PluginManifest, 'operations'> | null | undefined,
    operation: unknown,
): PluginExecutionProfile | null {
    const profile = findOperationDeclaration(manifest, operation)?.executionProfile;
    return profile === 'sync' || profile === 'long-running' ? profile : null;
}

/**
 * Manifest validation for `everworks.plugin.operations`: an array of
 * `{ name, executionProfile? }`, each name a possible operation, none twice.
 */
export function validateOperationDeclarations(operations: unknown): ValidationError[] {
    if (!Array.isArray(operations)) {
        return [
            {
                path: 'operations',
                message: 'operations must be an array of { name, executionProfile? }',
                actual: operations,
            },
        ];
    }
    const errors: ValidationError[] = [];
    const seen = new Set<string>();
    operations.forEach((entry: unknown, index) => {
        const path = `operations[${index}]`;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            errors.push({ path, message: 'must be an object { name, executionProfile? }' });
            return;
        }
        const { name, executionProfile } = entry as Record<string, unknown>;
        if (!isOperationName(name)) {
            errors.push({
                path: `${path}.name`,
                message:
                    'must be a method name (letters and digits, optionally dot-separated; ' +
                    'no leading `_` or `$`) and not a lifecycle hook',
                actual: name,
            });
        } else if (seen.has(name)) {
            errors.push({ path: `${path}.name`, message: 'is declared twice', actual: name });
        } else {
            seen.add(name);
        }
        if (
            executionProfile !== undefined &&
            !EXECUTION_PROFILES.includes(executionProfile as PluginExecutionProfile)
        ) {
            errors.push({
                path: `${path}.executionProfile`,
                message: `must be one of: ${EXECUTION_PROFILES.join(', ')}`,
                actual: executionProfile,
                expected: EXECUTION_PROFILES.join(' | '),
            });
        }
    });
    return errors;
}

/**
 * The real plugin behind a registry entry, once it has LOADED: a lazy proxy is
 * materialised with `{ waitForLoad: true }`, so its first-materialise hook
 * (onLoad) has settled before this resolves. A plain `__materialize()` waits
 * for that too — except from inside the plugin's own first load, where it
 * answers at once; `waitForLoad` REJECTS there instead, so a use path reached
 * from a plugin's own onLoad fails loudly rather than run on a half-loaded
 * plugin (or hang). Anything else is returned as it is. Rejects when the
 * plugin will not load. Follow it with {@link pluginLoadFailure}: an onLoad
 * that failed leaves the entry in `error` but still resolves here.
 */
export async function materializePlugin(plugin: unknown): Promise<object> {
    const lazy = plugin as { __materialize?: unknown };
    if (typeof lazy.__materialize === 'function') {
        const materialize = lazy.__materialize as (options: {
            waitForLoad: boolean;
        }) => Promise<object>;
        return (await materialize({ waitForLoad: true })) as object;
    }
    return plugin as object;
}

/**
 * Why a registry entry says `pluginId` cannot run, or `null` when it can.
 *
 * Checked BEFORE materialising (a plugin already in `error`) and AGAIN AFTER:
 * a lazy plugin's `onLoad` runs inside the first-materialise hook, and a throw
 * there is caught by `callOnLoad`, which records `error` on the registry entry
 * — `__materialize` itself still resolves. Without the second check the
 * operation ran on an instance whose initialisation had failed.
 *
 * Pass the entry `PluginRegistryService.get` returned: the registry mutates
 * its entries IN PLACE (`updateState`, `updateRegisteredManifest`), so the
 * same object carries the state and manifest as they are after materialising.
 */
export function pluginLoadFailure(
    entry: { state?: string; error?: unknown } | null | undefined,
    pluginId: string,
): string | null {
    if (!entry || entry.state !== 'error') return null;
    const cause = entry.error instanceof Error ? entry.error.message : entry.error;
    return `Plugin "${pluginId}" is in an error state${cause ? `: ${String(cause)}` : '.'}`;
}

/**
 * The real plugin behind `entry` for a caller about to USE it, or `null` when
 * it cannot be used: its import fails, or its first load leaves the entry in
 * `error` ({@link pluginLoadFailure} — a failing `onLoad` does not reject the
 * materialise, it records `error` on the entry). The eager boot skipped such a
 * plugin; a caller that materialises on first use must skip it too, not run
 * it. `onUnusable` hears why, for a log line.
 *
 * Waits for the first load to settle (a plain `__materialize()` does, outside
 * the plugin's own onLoad). Pass the entry `PluginRegistryService.get`
 * returned — the registry mutates it in place, so it carries the state as it
 * is after the load.
 */
export async function materializeUsablePlugin<T = object>(
    entry: { plugin: unknown; state?: string; error?: unknown },
    pluginId: string,
    onUnusable?: (reason: string) => void,
): Promise<T | null> {
    const before = pluginLoadFailure(entry, pluginId);
    if (before) {
        onUnusable?.(before);
        return null;
    }
    let real: object;
    try {
        const lazy = entry.plugin as { __materialize?: () => Promise<object> };
        real =
            typeof lazy?.__materialize === 'function'
                ? await lazy.__materialize()
                : (entry.plugin as object);
    } catch (error) {
        onUnusable?.(
            `Plugin "${pluginId}" could not be loaded: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return null;
    }
    const after = pluginLoadFailure(entry, pluginId);
    if (after) {
        onUnusable?.(after);
        return null;
    }
    return (real ?? entry.plugin) as T;
}
