import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
    materializePlugin,
    PluginInstallerService,
    PluginRegistryService,
    resolvePluginOperation,
} from '@ever-works/agent/plugins';
import { getOptionalProvider } from '@ever-works/agent/utils';
import { TriggerRunPluginOperationModule } from '../../trigger/worker/modules/trigger-run-plugin-operation.module';
import { TriggerPluginHydratorService } from '../../trigger/worker/services/trigger-plugin-hydrator.service';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

export interface RunPluginOperationPayload {
    pluginId: string;
    operation: string;
    args?: Record<string, unknown>;
}

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
 * | `WORKER_INSTALL_FAILED`       | a bound installer threw (none is bound — see the module)      |
 * | `WORKER_PLUGIN_HYDRATE_FAILED`| loading the bundled plugins threw                             |
 * | `PLUGIN_NOT_REGISTERED`       | the plugin is not in this worker (not bundled in the image)  |
 * | `WORKER_PLUGIN_LOAD_FAILED`   | the plugin is registered in `error` state, or will not load   |
 * | `OPERATION_NOT_FOUND`         | the plugin has no callable operation of that name             |
 * | `WORKER_PLUGIN_THREW`         | the operation itself threw                                    |
 *
 * ## The context: `TriggerRunPluginOperationModule`
 *
 * It used to boot `TriggerInternalModule`, which binds neither the plugin
 * registry nor the installer, so every run answered PLUGIN_NOT_REGISTERED
 * (runtime probe). The new module binds the registry and the hydrator, and
 * "install" in the worker is HYDRATION: every first-party plugin is bundled
 * into the worker image, and `hydrator.initialize()` registers them. The boot
 * passes `abortOnError: false` inside a `try`: Nest's default turns a boot
 * failure into `process.exit(1)`, which no envelope survives.
 *
 * ## Which operations can be called
 *
 * The registry hands out lazy proxies whose `get` answers a forwarding
 * function for ANY property name, so `typeof plugin[op] === 'function'` was
 * always true: OPERATION_NOT_FOUND could never be answered, and `constructor`,
 * `__materialize`, `onUnload` or `toString` could be called from a payload.
 * Operations are now resolved on the MATERIALISED plugin, as a function it or
 * its classes define — never `Object.prototype` — and never a lifecycle hook,
 * an `_`-prefixed name or anything that is not a plain identifier. (Public
 * helper methods of a plugin class remain callable; a manifest-declared
 * operation list would narrow that further.)
 *
 * `maxDuration` is set high enough for the longest legitimate platform
 * operation. `retry: { maxAttempts: 1 }`: a plugin operation can have side
 * effects, and a crashed attempt is reported to the router as failed rather
 * than silently run again.
 */

function fail(code: string, message: string): RunPluginOperationOutcome {
    return { ok: false, error: { code, message } };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Everything after the boot, against an already-built context: install (only if
 * an installer is bound), hydrate, look up, load, resolve the operation, call it.
 * Exported so the boot spec can drive it against the REAL module.
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
    const hydrator = getOptionalProvider<TriggerPluginHydratorService>(
        appContext,
        TriggerPluginHydratorService,
    );
    const registry = getOptionalProvider<PluginRegistryService>(appContext, PluginRegistryService);

    if (installer) {
        try {
            await installer.ensurePluginAvailable(pluginId);
        } catch (err) {
            return fail('WORKER_INSTALL_FAILED', errorText(err));
        }
    }
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

    const registered = registry?.get(pluginId);
    if (!registered) {
        // The code stays PLUGIN_NOT_REGISTERED; the message names the cause.
        const message = !registry
            ? `Plugin "${pluginId}" cannot be resolved: no plugin registry is bound in this worker context.`
            : installer
              ? `Plugin "${pluginId}" not registered in worker after ensurePluginAvailable.`
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

    const method = resolvePluginOperation(plugin, operation);
    if (!method) {
        return fail(
            'OPERATION_NOT_FOUND',
            `Plugin "${pluginId}" does not implement operation "${String(operation)}".`,
        );
    }

    try {
        const result = await method.call(plugin, payload.args);
        return { ok: true, result };
    } catch (err) {
        return fail('WORKER_PLUGIN_THREW', errorText(err));
    }
}

export const runPluginOperationTask = task<'run-plugin-operation', RunPluginOperationPayload>({
    id: 'run-plugin-operation',
    maxDuration: 3600,
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
