/**
 * EW-742 P3.2 follow-up — structural Inngest shapes the plugin depends on.
 *
 * We do NOT take a hard dependency on `inngest` from this plugin
 * package. The operator installs `inngest` in their app and injects a
 * fully-constructed `Inngest` client through the factories below.
 *
 * Reasons mirror the BullMQ / pg-boss / Temporal plugins. Inngest is
 * additionally distinguished by the **serverless** dispatch model:
 *   - Outbound: HTTP POST via `inngest.send(events)`.
 *   - Inbound: Inngest invokes the operator's `serve()` HTTP route
 *     when an event matches a registered function.
 *
 * There is no separate worker host process. The plugin's
 * `startWorkerHost` stays a no-op even when operator hooks are wired.
 *
 * For tenant-scoped overlay (SaaS only — self-host is blocked at
 * `available-providers` per ADR-017 providers.md), the operator builds
 * one `Inngest` client per tenant (using the tenant's eventKey +
 * signingKey from the credential snapshot) and routes through the
 * right client via `dispatchersBuilder`.
 */

export interface InngestSendEvent {
	readonly name: string;
	readonly data: unknown;
	/** Optional Inngest event id — providers use it for idempotency. */
	readonly id?: string;
	readonly user?: Readonly<Record<string, unknown>>;
	/** Pass-through fields for v3 SDK (`v`, `ts`, etc.). */
	readonly [extra: string]: unknown;
}

export interface InngestSendResult {
	/** Server-assigned ids — one per event in input order. */
	readonly ids: readonly string[];
}

/**
 * Structural subset of `Inngest` client. Maps to inngest >=3.0.
 */
export interface InngestClient {
	send(event: InngestSendEvent | readonly InngestSendEvent[]): Promise<InngestSendResult>;
	/**
	 * v3 `createFunction` signature — used only by the operator's
	 * function-definition glue; the plugin holds the array of returned
	 * function objects for `serve()`-time pickup.
	 */
	createFunction?(
		config: Readonly<Record<string, unknown>>,
		trigger: Readonly<Record<string, unknown>>,
		handler: (...args: unknown[]) => Promise<unknown>
	): unknown;
}

/** Returned by `client.createFunction(...)` — opaque object the operator hands to `serve(...)`. */
export type InngestFunction = unknown;

export interface InngestDispatcherFactoryOptions {
	readonly client: InngestClient;
	/**
	 * Default event-name prefix prepended to every `send(name, ...)`.
	 * E.g. `'ever.works'` produces `'ever.works/kb-embed-document'`.
	 * Leave undefined for raw names.
	 */
	readonly eventNamespace?: string;
}
