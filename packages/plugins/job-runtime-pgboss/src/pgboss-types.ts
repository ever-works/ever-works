/**
 * EW-742 P3.2 follow-up — structural pg-boss shapes the plugin depends on.
 *
 * We do NOT take a hard dependency on `pg-boss` from this plugin package.
 * The operator installs `pg-boss` in their worker app and injects a
 * fully-constructed `PgBossInstance` (the result of `new PgBoss(opts)`)
 * via `PgBossDispatcherFactory` / `PgBossWorkerHostFactory`.
 *
 * Reasons mirror the BullMQ plugin:
 *   - Keeps the plugin package install footprint tiny.
 *   - Lets the operator pin their own pg-boss major (8.x vs 9.x has
 *     wire-incompatible defaults around schema).
 *   - Per-tenant schema isolation (ADR-017 Q2) means the operator may
 *     hold N PgBoss instances — one per tenant schema — so the
 *     plugin can't own the instance itself.
 *
 * Only the surface area the plugin actually calls is typed here. The
 * operator's code receives the real types from `pg-boss`.
 */

/**
 * Structural subset of `PgBoss` the plugin uses. Maps to pg-boss >=8.0.
 */
export interface PgBossInstance {
	/** Enqueue one job. Returns the pg-boss job id, or `null` on dedup hit. */
	send(name: string, data: unknown, options?: Readonly<Record<string, unknown>>): Promise<string | null>;
	/**
	 * Register a worker. `handler` is invoked with one job at a time
	 * (or the batched array — operator-side concern).
	 */
	work(
		name: string,
		options: Readonly<Record<string, unknown>>,
		handler: (job: PgBossJobView | readonly PgBossJobView[]) => Promise<unknown>
	): Promise<string>;
	/** Cancel an in-flight job by id. Idempotent — returns void either way. */
	cancel(id: string): Promise<void>;
	/** Lookup a single job by id. Returns shape includes a `state` field. */
	getJobById?(id: string): Promise<PgBossJobRecord | null>;
	/** Register a cron-like recurring job. */
	schedule?(name: string, cron: string, data?: unknown, options?: Readonly<Record<string, unknown>>): Promise<void>;
	/** Start the pg-boss instance (begin polling). */
	start(): Promise<unknown>;
	/** Stop the pg-boss instance gracefully. */
	stop(options?: Readonly<Record<string, unknown>>): Promise<void>;
}

/** Job view passed to the operator-supplied handler. */
export interface PgBossJobView {
	readonly id: string;
	readonly name: string;
	readonly data: unknown;
}

/**
 * pg-boss `getJobById` result — `state` is the canonical lifecycle
 * field we project onto our `JobRunStatus` union.
 */
export interface PgBossJobRecord {
	readonly id: string;
	readonly name: string;
	readonly state: string;
	readonly data?: unknown;
}

/** Common ctor opts for both factories. */
export interface PgBossFactoryOptions {
	/**
	 * Operator-owned pg-boss instance. Already constructed with the
	 * right `connectionString` / `schema` / `application_name`.
	 * The factory does NOT call `boss.start()` — that's the operator's
	 * responsibility (and they may share one instance across both
	 * factories).
	 */
	readonly boss: PgBossInstance;
	/**
	 * Default send options applied to every `send(...)`. Per-call
	 * options shallow-merge over these.
	 */
	readonly defaultSendOptions?: Readonly<Record<string, unknown>>;
	/**
	 * Default work options applied to every `work(...)`. Per-call
	 * options shallow-merge over these.
	 */
	readonly defaultWorkOptions?: Readonly<Record<string, unknown>>;
}
