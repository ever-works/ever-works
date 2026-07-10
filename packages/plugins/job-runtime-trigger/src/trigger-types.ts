/**
 * EW-686 P2 — structural Trigger.dev shapes the plugin depends on.
 *
 * We do NOT take a hard dependency on `@trigger.dev/sdk` from this
 * plugin package. The operator installs `@trigger.dev/sdk` in their app
 * and injects a fully-constructed Trigger.dev client through the
 * factories below.
 *
 * Reasons mirror the BullMQ / pg-boss / Temporal / Inngest plugins.
 * Trigger.dev is additionally distinguished by the **push-model**
 * dispatch model with cloud-hosted workers:
 *   - Outbound: `client.tasks.trigger(taskId, payload, opts)` enqueues
 *     a run and returns a handle `{ id }`.
 *   - Inbound: Trigger.dev's cloud invokes the operator's deployed
 *     task package on its own machines — the operator does NOT run a
 *     poller from the API.
 *
 * There is no separate worker host process. The plugin's
 * `startWorkerHost` stays a no-op even when operator hooks are wired
 * (mirrors Inngest).
 *
 * For tenant-scoped overlay (per ADR-017 providers.md § Trigger.dev),
 * the operator builds one Trigger.dev client per tenant project (using
 * the tenant's project-scoped access token from the credential
 * snapshot) and routes through the right client via `dispatchersBuilder`.
 */

/**
 * Result of a successful `tasks.trigger` call — the Trigger.dev SDK
 * returns a run handle whose `id` is the runId every other contract
 * method (`cancel`, `getRunStatus`) keys on.
 */
export interface TriggerRunHandle {
	readonly id: string;
	/** Pass-through fields from the SDK (publicAccessToken, etc.). */
	readonly [extra: string]: unknown;
}

/**
 * Per-trigger options accepted by `client.tasks.trigger`. Mirrors the
 * fields of `@trigger.dev/sdk` v4 `TriggerOptions`. Optional everywhere
 * so the dispatcher can spread translated values onto it.
 */
export interface TriggerTaskOptions {
	readonly idempotencyKey?: string;
	readonly concurrencyKey?: string;
	readonly tags?: readonly string[];
	readonly maxDuration?: number;
	readonly machine?: string;
	readonly queue?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly [extra: string]: unknown;
}

/**
 * Status as reported by `client.runs.retrieve(...)`. Trigger.dev SDK v4
 * exposes a `status` field on the returned run record; the plugin's
 * `getRunStatus` projects this onto the contract's 6-value
 * `JobRunStatus` union. Kept as a free-form string here so future SDK
 * widenings don't break compilation — the mapper falls back to
 * `'unknown'`.
 */
export interface TriggerRunRecord {
	readonly id: string;
	readonly status: string;
	readonly [extra: string]: unknown;
}

/**
 * The `tasks` subnamespace of the Trigger.dev client — only the calls
 * the plugin makes are typed.
 */
export interface TriggerTasksApi {
	trigger(taskId: string, payload: unknown, options?: TriggerTaskOptions): Promise<TriggerRunHandle>;
}

/**
 * The `runs` subnamespace of the Trigger.dev client — only the calls
 * the plugin makes are typed.
 */
export interface TriggerRunsApi {
	cancel(runId: string): Promise<unknown>;
	retrieve(runId: string): Promise<TriggerRunRecord>;
}

/**
 * Structural subset of the Trigger.dev SDK client (v4). Maps to
 * `@trigger.dev/sdk` >=4.0. Operators inject the real client; the
 * plugin only reaches into `tasks` and `runs`.
 */
export interface TriggerClient {
	readonly tasks: TriggerTasksApi;
	readonly runs: TriggerRunsApi;
}

export interface TriggerDispatcherFactoryOptions {
	readonly client: TriggerClient;
	/**
	 * Default queue handed to every `tasks.trigger(...)` when the per-
	 * call options don't override it. Leave undefined for the
	 * task-default queue.
	 */
	readonly defaultTaskQueue?: string;
}
