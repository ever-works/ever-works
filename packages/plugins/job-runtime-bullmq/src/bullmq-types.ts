/**
 * EW-742 P3.2 follow-up — structural BullMQ shapes the plugin depends on.
 *
 * We do NOT take a hard dependency on `bullmq` / `ioredis` from this
 * plugin package. The operator installs `bullmq` in their worker app
 * and injects the `Queue` + `Worker` constructors via
 * `BullMqDispatcherFactory` / `BullMqWorkerHostFactory`.
 *
 * Reasons:
 *   - Keeps the plugin package install footprint tiny (no native
 *     ioredis transitive dep for callers that don't enable BullMQ).
 *   - Lets the operator pin their own bullmq version to match their
 *     Redis instance — bullmq 4.x and 5.x have wire-incompatible
 *     defaults.
 *   - Mirrors what `@ever-works/job-runtime-temporal-plugin` does
 *     for `@temporalio/client` and Inngest does for `inngest`.
 *
 * Only the surface area the plugin actually calls is typed here.
 * Operator-side code receives the real types from `bullmq`.
 */

/**
 * Structural subset of `bullmq.Queue` the plugin uses.
 * Maps to bullmq >=4.0 (no breaking changes to `add` between 4.x/5.x).
 */
export interface BullMqQueueAdapter {
	add(name: string, data: unknown, opts?: Readonly<Record<string, unknown>>): Promise<{ id?: string | null }>;
	getJob?(id: string): Promise<{ remove(): Promise<void>; getState(): Promise<string> } | undefined>;
	close(): Promise<void>;
}

/**
 * Structural subset of `bullmq.Worker` the plugin uses.
 *
 * Note: `on` returns the worker itself in bullmq; we relax to `void`
 * because we never chain off the return value.
 */
export interface BullMqWorkerAdapter {
	on(event: 'completed' | 'failed' | 'error' | 'ready', cb: (...args: unknown[]) => void): void;
	close(): Promise<void>;
	waitUntilReady?(): Promise<void>;
}

/** Job object handed to the worker handler — minimal shape we depend on. */
export interface BullMqJobView {
	readonly id?: string;
	readonly name: string;
	readonly data: unknown;
}

/**
 * Constructor signatures injected by the operator. We don't import the
 * real `Queue` / `Worker` types so callers can pass either bullmq 4.x or
 * 5.x without the plugin pinning to one.
 */
export interface BullMqDeps {
	readonly Queue: new (name: string, opts?: Readonly<Record<string, unknown>>) => BullMqQueueAdapter;
	readonly Worker: new (
		name: string,
		processor: (job: BullMqJobView) => Promise<unknown>,
		opts?: Readonly<Record<string, unknown>>
	) => BullMqWorkerAdapter;
}

/** Operator-side connection — anything `bullmq` accepts (IORedis instance or `{ host, port }` config). */
export type BullMqConnection = unknown;

/** Common ctor opts for both the dispatcher factory and worker host factory. */
export interface BullMqFactoryOptions {
	readonly connection: BullMqConnection;
	/**
	 * Redis key prefix — used as `opts.prefix` on every `new Queue` and
	 * `new Worker`. When per-tenant prefix isolation is in play, the
	 * operator builds one factory per tenant prefix (see
	 * `BullMqJobRuntimePlugin.dispatchersBuilder` for the binding hook).
	 */
	readonly prefix?: string;
	/**
	 * Default jobs options applied to every `Queue.add` made through this
	 * factory's dispatchers. Per-call opts (passed via the dispatcher
	 * function's options arg) override these field-by-field.
	 */
	readonly defaultJobOptions?: Readonly<Record<string, unknown>>;
}
