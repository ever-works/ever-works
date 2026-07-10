import type { JobEnqueueOptions } from '@ever-works/plugin';
import type { TriggerClient, TriggerDispatcherFactoryOptions, TriggerTaskOptions } from './trigger-types.js';
import { mapEnqueueOptions } from './trigger-enqueue-options.js';

/**
 * EW-686 P2 — operator-facing factory that wraps a Trigger.dev client
 * (`@trigger.dev/sdk`) and exposes per-task dispatcher functions.
 *
 * # Usage (operator-side app)
 *
 * ```ts
 * import { runs, tasks } from '@trigger.dev/sdk';
 * import {
 *   TriggerJobRuntimePlugin,
 *   TriggerDispatcherFactory
 * } from '@ever-works/job-runtime-trigger-plugin';
 *
 * // Trigger.dev v4 — the SDK reads TRIGGER_SECRET_KEY from env, the
 * // `tasks` / `runs` namespaces are imported as module-level objects.
 * // The plugin only needs a structural { tasks, runs } client:
 * const client = { tasks, runs };
 * const factory = new TriggerDispatcherFactory({
 *   client,
 *   defaultTaskQueue: 'platform-default'
 * });
 *
 * const plugin = new TriggerJobRuntimePlugin().useDispatchers({
 *   dispatchKbEmbedDocument: (payload) =>
 *     factory.dispatch('kb-embed-document', payload)
 * });
 * ```
 *
 * # Per-tenant routing
 *
 * For BYO/override per ADR-017 providers.md § Trigger.dev, build one
 * Trigger.dev client per tenant project (configured with the tenant's
 * `projectAccessToken` from the credential snapshot) and one factory
 * per client; pass the per-tenant factory through
 * `TriggerJobRuntimePluginOptions.dispatchersBuilder` so
 * `bindToTenant(snapshot)` views route to the right Trigger.dev project.
 */
export class TriggerDispatcherFactory {
	constructor(private readonly opts: TriggerDispatcherFactoryOptions) {}

	get client(): TriggerClient {
		return this.opts.client;
	}

	/**
	 * Dispatch a single Trigger.dev task. Returns the run id assigned
	 * by Trigger.dev (`handle.id`) or `null` if the SDK response is
	 * shaped unexpectedly (`handle` missing / no `id`).
	 *
	 * `extraOptions` shallow-merges OVER the factory default queue so
	 * operator-supplied per-call overrides win.
	 */
	async dispatch(taskId: string, payload: unknown, extraOptions?: TriggerTaskOptions): Promise<string | null> {
		const options: TriggerTaskOptions = {
			...(this.opts.defaultTaskQueue !== undefined ? { queue: this.opts.defaultTaskQueue } : {}),
			...(extraOptions ?? {})
		};
		const handle = await this.opts.client.tasks.trigger(taskId, payload, options);
		return handle?.id ?? null;
	}

	/**
	 * EW-742 P4 T31 — dispatch with platform-canonical
	 * `JobEnqueueOptions`. Translates each field onto the Trigger.dev
	 * SDK's native carriers per `providers.md` § Trigger.dev:
	 *
	 *   - `idempotencyKey`     → `idempotencyKey`
	 *   - `tenantId`           → `metadata.tenantId`
	 *   - `concurrencyKey`     → `concurrencyKey`
	 *   - `tags`               → `tags`
	 *   - `maxDurationSeconds` → `maxDuration`
	 *   - `machineHint`        → `machine`
	 *
	 * Per-tenant Trigger.dev CLIENT selection happens BEFORE this call
	 * — the caller picks the right `TriggerClient` (per the snapshot's
	 * `projectAccessToken`) via the plugin's `dispatchersBuilder` hook.
	 *
	 * `extraOptions` is shallow-merged on top so operators can still
	 * pass SDK-native fields (`queue`, custom metadata, etc.) that the
	 * platform enqueue options don't expose. Operator-supplied values
	 * win on key collision (e.g. an explicit `extraOptions.metadata`
	 * fully replaces the translated `metadata.tenantId` — operators
	 * must spread it themselves if they want both).
	 */
	async enqueue(
		taskId: string,
		payload: unknown,
		enqueueOptions: JobEnqueueOptions,
		extraOptions?: TriggerTaskOptions
	): Promise<string | null> {
		const { options: mapped } = mapEnqueueOptions(enqueueOptions);
		const merged: TriggerTaskOptions = {
			...(this.opts.defaultTaskQueue !== undefined ? { queue: this.opts.defaultTaskQueue } : {}),
			...mapped,
			...(extraOptions ?? {})
		};
		const handle = await this.opts.client.tasks.trigger(taskId, payload, merged);
		return handle?.id ?? null;
	}

	/**
	 * Cancel a Trigger.dev run by id. Returns `true` when the SDK call
	 * resolves without throwing (Trigger.dev accepts the cancel
	 * request), `false` if the SDK rejects (unknown / already-terminal
	 * run id).
	 */
	async cancel(runId: string): Promise<boolean> {
		try {
			await this.opts.client.runs.cancel(runId);
			return true;
		} catch {
			return false;
		}
	}
}
