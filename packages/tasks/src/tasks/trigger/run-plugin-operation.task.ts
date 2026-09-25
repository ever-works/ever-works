import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { resolvePluginDistribution, type PluginManifest } from '@ever-works/plugin';
import {
    describeMissingOperation,
    materializePlugin,
    PluginInstallerService,
    PluginInstallRefusedError,
    PluginLoaderService,
    pluginLoadFailure,
    PluginRegistryService,
    resolvePluginOperation,
    type LoadResult,
} from '@ever-works/agent/plugins';
import {
    PLUGIN_OPERATION_MAX_DURATION_SECONDS,
    PLUGIN_OPERATION_TASK_ID,
    type PluginOperationPayload,
} from '@ever-works/agent/tasks';
import { getOptionalProvider } from '@ever-works/agent/utils';
import { TriggerRunPluginOperationModule } from '../../trigger/worker/modules/trigger-run-plugin-operation.module';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * The payload, as the router and the dispatcher build it — the one shared
 * definition in `@ever-works/agent/tasks`, so the three cannot drift apart.
 */
export type RunPluginOperationPayload = PluginOperationPayload;

export interface RunPluginOperationOutcome {
    ok: boolean;
    result?: unknown;
    error?: { message: string; code: string };
}

/**
 * EW-693 / T27 — long-running plugin call task.
 *
 * Dispatched by `PluginExecutionRouterService` for a plugin operation routed to
 * the job runtime (an explicit long-running profile, or the manifest's
 * `executionProfile`). Runs inside the Trigger.dev worker, a SEPARATE Node
 * process from the API, and answers the router with a deterministic
 * `{ ok, result | error }` envelope — it never throws, so every failure is a
 * named answer rather than an exception in Trigger.dev's retry path:
 *
 * | code                          | when                                                          |
 * |-------------------------------|---------------------------------------------------------------|
 * | `INVALID_PAYLOAD`             | no plugin id or operation name                                |
 * | `WORKER_CONTEXT_BOOT_FAILED`  | the worker context cannot boot (e.g. an env var missing)      |
 * | `WORKER_PLUGIN_HYDRATE_FAILED`| loading the plugins in the worker image threw                 |
 * | `WORKER_INSTALL_REFUSED`      | dynamic mode, plugin not in the image: the installer refused before any download — the platform's record pins no exact version and integrity (FR-10) or pins something other than a plain package name and exact semver version, or the allowlist does not admit the package (FR-11) |
 * | `WORKER_INSTALL_FAILED`       | dynamic mode, plugin not in the image: fetching the pinned version failed, or the fetched package could not be registered |
 * | `PLUGIN_NOT_REGISTERED`       | the plugin is not in this worker: not in the image, and (bundled mode) nothing is installed at runtime |
 * | `WORKER_PLUGIN_LOAD_FAILED`   | the plugin is in `error` state, will not load, or its `onLoad` failed while loading |
 * | `OPERATION_NOT_FOUND`         | the manifest does not declare the operation, or the class lacks it |
 * | `WORKER_PLUGIN_THREW`         | the operation itself threw                                    |
 *
 * ## The context: `TriggerRunPluginOperationModule`
 *
 * It used to boot `TriggerInternalModule`, which binds neither the plugin
 * registry nor the installer, so every run answered PLUGIN_NOT_REGISTERED
 * (runtime probe). The module binds the registry, the hydrator and (T27) the
 * installer. The boot passes `abortOnError: false` inside a `try`: Nest's
 * default turns a boot failure into `process.exit(1)`, which no envelope
 * survives.
 *
 * ## Where the plugin comes from
 *
 * 1. **Hydrate** — `hydrator.initialize()` registers the plugins in the worker
 *    image (`prepare-plugins.js`: every first-party plugin in bundled mode,
 *    the core ones only when the image is built for dynamic mode).
 * 2. **The image wins.** A plugin the image carries is run as it is; the
 *    installer is not asked. The image's content is fixed when the worker is
 *    DEPLOYED (`prepare-plugins.js` reads PLUGIN_DISTRIBUTION_MODE then), the
 *    runtime installs follow the mode the worker RUNS with. So in dynamic mode
 *    a distributable plugin found in the image means the image was built
 *    without PLUGIN_DISTRIBUTION_MODE=dynamic, and its copy runs instead of
 *    the version the API pinned: that is logged once per plugin version per
 *    process (read from the manifest — no API call).
 * 3. **Dynamic mode, plugin not in the image (T27's runtime-installed
 *    half).** `installer.ensureLocalInstall` installs the version the API
 *    PINNED (exact version + integrity, allowlist first) into THIS worker's
 *    own store — a local copy answers without a download — and never writes
 *    the API's shared install row. `loader.registerFromPath` registers the
 *    extracted directory, and the registry is read again. The API-side
 *    `ensurePluginAvailable` is deliberately not used: it can run a full
 *    install, which writes that row over the internal API.
 *
 * In bundled mode (the default) step 3 never runs.
 *
 * ## Which operations can be called
 *
 * The registry hands out lazy proxies whose `get` answers a forwarding
 * function for ANY property name, so `typeof plugin[op] === 'function'` was
 * always true: OPERATION_NOT_FOUND could never be answered, and `constructor`,
 * `__materialize`, `onUnload` or `toString` could be called from a payload.
 * Operations are now resolved on the MATERIALISED plugin, and only one the
 * plugin DECLARES in its manifest (`everworks.plugin.operations`) — an
 * allowlist, because TypeScript `private`/`protected` are erased at runtime and
 * a prototype walk otherwise reaches every helper a plugin class or its base
 * classes carry. A declared name still has to be a plain identifier, not
 * `_`-prefixed and not a lifecycle hook (`resolvePluginOperation`).
 *
 * ## A plugin whose `onLoad` fails
 *
 * A lazily registered plugin runs `onLoad` inside its first materialisation.
 * A throw there is caught and recorded as the registry entry's `error` state —
 * `__materialize` still resolves — so the state is read again AFTER
 * materialising, and such a plugin answers WORKER_PLUGIN_LOAD_FAILED instead of
 * running an operation on an instance whose initialisation failed.
 *
 * `maxDuration` (`PLUGIN_OPERATION_MAX_DURATION_SECONDS`) is set high enough
 * for the longest legitimate platform operation; the router's default wait is
 * derived from it. `retry: { maxAttempts: 1 }`: a plugin operation can have
 * side effects, and a crashed attempt is reported to the router as failed
 * rather than silently run again.
 */

function fail(code: string, message: string): RunPluginOperationOutcome {
    return { ok: false, error: { code, message } };
}

const logger = new Logger('RunPluginOperation');

/** `pluginId@version` pairs already warned about in this process. */
const imageSkewWarned = new Set<string>();

/**
 * Dynamic mode, and the image carries a DISTRIBUTABLE plugin: the image was
 * built without PLUGIN_DISTRIBUTION_MODE=dynamic (build time), so its copy
 * runs, not the version the API pinned. Warn once per plugin version per
 * process — the image does not change while the process lives.
 */
function warnImageVersionSkew(pluginId: string, manifest: PluginManifest | undefined): void {
    if (!manifest || resolvePluginDistribution(manifest) !== 'registry') return;
    const version = typeof manifest.version === 'string' ? manifest.version : 'unknown';
    const key = `${pluginId}@${version}`;
    if (imageSkewWarned.has(key)) return;
    imageSkewWarned.add(key);
    logger.warn(
        `Plugin "${pluginId}" is distributable, but this worker image carries it (version ${version}): ` +
            'the image was built without PLUGIN_DISTRIBUTION_MODE=dynamic, so the image’s copy runs ' +
            'instead of the version the platform pinned. Redeploy the worker with ' +
            'PLUGIN_DISTRIBUTION_MODE=dynamic set for `pnpm deploy:trigger` to run the pinned version.',
    );
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * T27 — install a plugin the worker image does not carry (dynamic mode) and
 * register it. Answers a failure envelope, or `null` once the plugin is
 * registered (the caller reads the registry again).
 */
async function installAtRuntime(
    pluginId: string,
    installer: PluginInstallerService,
    loader: PluginLoaderService | undefined,
): Promise<RunPluginOperationOutcome | null> {
    let installPath: string;
    try {
        installPath = (await installer.ensureLocalInstall(pluginId)).installPath;
    } catch (err) {
        return err instanceof PluginInstallRefusedError
            ? fail('WORKER_INSTALL_REFUSED', errorText(err))
            : fail('WORKER_INSTALL_FAILED', errorText(err));
    }
    if (!loader) {
        return fail(
            'WORKER_INSTALL_FAILED',
            `Plugin "${pluginId}" was installed at ${installPath}, but no plugin loader is bound in this worker context to register it.`,
        );
    }
    let loaded: LoadResult;
    try {
        loaded = await loader.registerFromPath(installPath, { expectedId: pluginId });
    } catch (err) {
        loaded = { success: false, pluginId, error: errorText(err) };
    }
    if (!loaded.success) {
        return fail(
            'WORKER_INSTALL_FAILED',
            `Plugin "${pluginId}" was installed at ${installPath} but could not be registered: ${
                loaded.error ?? 'unknown error'
            }`,
        );
    }
    return null;
}

/**
 * Everything after the boot, against an already-built context: hydrate, look
 * up, install at runtime (dynamic mode, a plugin not in the image), load,
 * resolve the operation, call it. Exported so the boot spec can drive it
 * against the REAL module.
 */
export async function executePluginOperation(
    appContext: Pick<INestApplicationContext, 'get'>,
    payload: RunPluginOperationPayload,
): Promise<RunPluginOperationOutcome> {
    const { pluginId, operation } = payload;
    // `getOptionalProvider`, not `appContext.get`: the latter THROWS
    // `UnknownElementException` for an absent provider — it never answers
    // `undefined`.
    const installer = getOptionalProvider<PluginInstallerService>(
        appContext,
        PluginInstallerService,
    );
    const loader = getOptionalProvider<PluginLoaderService>(appContext, PluginLoaderService);
    const hydrator = getOptionalProvider<TriggerPluginHydratorService>(
        appContext,
        TriggerPluginHydratorService,
    );
    const registry = getOptionalProvider<PluginRegistryService>(appContext, PluginRegistryService);

    if (hydrator) {
        try {
            await hydrator.initialize();
        } catch (err) {
            return fail(
                'WORKER_PLUGIN_HYDRATE_FAILED',
                `The plugins bundled into this worker could not be loaded: ${errorText(err)}`,
            );
        }
    }

    let registered = registry?.get(pluginId);
    const installsAtRuntime = installer?.getDistributionMode() === 'dynamic';
    if (registered && installsAtRuntime) {
        warnImageVersionSkew(pluginId, registered.manifest);
    }
    if (!registered && registry && installer && installsAtRuntime) {
        const failure = await installAtRuntime(pluginId, installer, loader);
        if (failure) return failure;
        registered = registry.get(pluginId);
    }
    if (!registered) {
        // The code stays PLUGIN_NOT_REGISTERED; the message names the cause.
        const message = !registry
            ? `Plugin "${pluginId}" cannot be resolved: no plugin registry is bound in this worker context.`
            : installsAtRuntime
              ? `Plugin "${pluginId}" is not registered in this worker after installing it.`
              : installer
                ? `Plugin "${pluginId}" is not registered in this worker: it is not bundled in the worker image (PLUGIN_DISTRIBUTION_MODE is "bundled", so no runtime install was attempted).`
                : `Plugin "${pluginId}" is not registered in this worker: it is not bundled in the worker image (no plugin installer is bound, so no install was attempted).`;
        return fail('PLUGIN_NOT_REGISTERED', message);
    }
    if (registered.state === 'error') {
        return fail(
            'WORKER_PLUGIN_LOAD_FAILED',
            `Plugin "${pluginId}" is registered in an error state${
                registered.error ? `: ${errorText(registered.error)}` : '.'
            }`,
        );
    }

    let plugin: object;
    try {
        plugin = await materializePlugin(registered.plugin);
    } catch (err) {
        return fail(
            'WORKER_PLUGIN_LOAD_FAILED',
            `Plugin "${pluginId}" could not be loaded: ${errorText(err)}`,
        );
    }

    // `onLoad` ran inside that first materialisation; its failure is recorded
    // on the registry entry, not thrown — read the state again. The registry
    // mutates its entries in place, so `registered` now carries the state (and
    // manifest) as they are after loading; the boot spec pins that against the
    // real registry.
    const loadFailure = pluginLoadFailure(registered, pluginId);
    if (loadFailure) {
        return fail('WORKER_PLUGIN_LOAD_FAILED', loadFailure);
    }

    const manifest = registered.manifest;
    const method = resolvePluginOperation(plugin, operation, manifest);
    if (!method) {
        return fail('OPERATION_NOT_FOUND', describeMissingOperation(pluginId, operation, manifest));
    }

    try {
        const result = await method.call(plugin, payload.args);
        return { ok: true, result };
    } catch (err) {
        return fail('WORKER_PLUGIN_THREW', errorText(err));
    }
}

export const runPluginOperationTask = task<
    typeof PLUGIN_OPERATION_TASK_ID,
    RunPluginOperationPayload
>({
    id: PLUGIN_OPERATION_TASK_ID,
    maxDuration: PLUGIN_OPERATION_MAX_DURATION_SECONDS,
    // One attempt: a plugin operation can have side effects. See the header.
    retry: { maxAttempts: 1 },
    run: async (payload): Promise<RunPluginOperationOutcome> => {
        if (
            !payload ||
            typeof payload.pluginId !== 'string' ||
            payload.pluginId.length === 0 ||
            typeof payload.operation !== 'string' ||
            payload.operation.length === 0
        ) {
            return fail('INVALID_PAYLOAD', 'A plugin id and an operation name are required.');
        }

        let appContext: INestApplicationContext;
        try {
            appContext = await NestFactory.createApplicationContext(
                TriggerRunPluginOperationModule.forRoot(),
                { abortOnError: false },
            );
        } catch (err) {
            return fail(
                'WORKER_CONTEXT_BOOT_FAILED',
                `The worker context for run-plugin-operation could not boot: ${errorText(err)}`,
            );
        }

        try {
            appContext.useLogger(createTriggerLogger(`RunPluginOperation:${payload.pluginId}`));
            return await executePluginOperation(appContext, payload);
        } catch (err) {
            // Nothing above throws by design; this is the net under that.
            return fail('WORKER_PLUGIN_THREW', errorText(err));
        } finally {
            await appContext.close().catch(() => undefined);
        }
    },
});
