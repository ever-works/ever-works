import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import {
	PluginInstallerService,
	PluginRegistryService
} from '@ever-works/agent/plugins';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
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
 * Dispatched by `PluginExecutionRouterService.dispatchLongRunning`
 * when the manifest's `executionProfile === 'long-running'` (or the
 * operation taxonomy classifies the call that way). Runs inside the
 * Trigger.dev worker, which is a SEPARATE Node process from the API
 * — so the worker has its OWN per-replica plugin store. The task
 * therefore calls `installer.ensurePluginAvailable(pluginId)` FIRST
 * (FR-13 — lazy install-on-use; the same pinned version + integrity
 * pulled into the API store is pulled into the worker store).
 *
 * Return value matches `PluginExecutionResult` so the router can
 * forward the outcome to its caller verbatim. Throwing here would
 * bubble through Trigger.dev's own retry/error path — instead we
 * always return an `{ ok: false, error }` envelope so the router
 * gets a deterministic shape.
 *
 * `maxDuration` is set high enough for the longest legitimate
 * platform operation (full site generation pipelines ran ~25 minutes
 * historically); operators tighten this per-plugin via the manifest
 * if needed.
 */
export const runPluginOperationTask = task<'run-plugin-operation', RunPluginOperationPayload>({
	id: 'run-plugin-operation',
	maxDuration: 3600,
	run: async (payload): Promise<RunPluginOperationOutcome> => {
		const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
		appContext.useLogger(createTriggerLogger(`RunPluginOperation:${payload.pluginId}`));

		try {
			const installer = appContext.get(PluginInstallerService, { strict: false });
			const registry = appContext.get(PluginRegistryService, { strict: false });

			if (installer) {
				try {
					await installer.ensurePluginAvailable(payload.pluginId);
				} catch (err) {
					return {
						ok: false,
						error: {
							message: err instanceof Error ? err.message : String(err),
							code: 'WORKER_INSTALL_FAILED'
						}
					};
				}
			}

			const registered = registry?.get(payload.pluginId);
			if (!registered) {
				return {
					ok: false,
					error: {
						message: `Plugin "${payload.pluginId}" not registered in worker after ensurePluginAvailable.`,
						code: 'PLUGIN_NOT_REGISTERED'
					}
				};
			}

			const plugin = registered.plugin as Record<string, unknown>;
			const method = plugin[payload.operation];
			if (typeof method !== 'function') {
				return {
					ok: false,
					error: {
						message: `Plugin "${payload.pluginId}" does not implement operation "${payload.operation}".`,
						code: 'OPERATION_NOT_FOUND'
					}
				};
			}

			try {
				const result = await (method as (a?: Record<string, unknown>) => unknown).call(
					plugin,
					payload.args
				);
				return { ok: true, result };
			} catch (err) {
				return {
					ok: false,
					error: {
						message: err instanceof Error ? err.message : String(err),
						code: 'WORKER_PLUGIN_THREW'
					}
				};
			}
		} finally {
			await appContext.close();
		}
	}
});
