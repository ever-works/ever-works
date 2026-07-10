/**
 * EW-742 P3.2 follow-up — structural Temporal shapes the plugin depends on.
 *
 * We do NOT take a hard dependency on `@temporalio/client` or
 * `@temporalio/worker` from this plugin package. The operator installs
 * those in their app and injects a fully-constructed `WorkflowClient`
 * (and optionally `Worker`s) through the factories below.
 *
 * Reasons:
 *   - `@temporalio/worker` ships native code (`@temporalio/core-bridge`)
 *     which has heavy install + per-platform compatibility constraints.
 *   - Operators may want to share one `WorkflowClient` across many
 *     services; the plugin shouldn't own it.
 *   - Namespace-per-tenant (ADR-017 Q1) means the operator may hold N
 *     clients (one per namespace) and dispatch through the right one.
 *
 * Only the surface area the plugin actually calls is typed here. The
 * operator's code receives the real types from `@temporalio/*`.
 */

/**
 * Structural subset of `@temporalio/client.WorkflowHandle`.
 */
export interface TemporalWorkflowHandle {
	readonly workflowId: string;
	cancel(): Promise<void>;
	terminate?(reason?: string): Promise<void>;
	describe(): Promise<TemporalWorkflowExecutionDescription>;
}

/**
 * Structural subset of `WorkflowExecutionDescription` we read.
 * `status.name` is the canonical Temporal lifecycle value:
 *   RUNNING / COMPLETED / FAILED / CANCELED / TERMINATED /
 *   CONTINUED_AS_NEW / TIMED_OUT.
 */
export interface TemporalWorkflowExecutionDescription {
	readonly status: { readonly name: string };
}

/**
 * Structural subset of `@temporalio/client.WorkflowClient`.
 * Only the methods the plugin/factories use are typed.
 */
export interface TemporalWorkflowClient {
	start(workflowType: string, options: TemporalStartWorkflowOptions): Promise<TemporalWorkflowHandle>;
	getHandle(workflowId: string): TemporalWorkflowHandle;
}

/** Structural subset of `WorkflowStartOptions` — the keys the dispatcher accepts. */
export interface TemporalStartWorkflowOptions {
	readonly taskQueue: string;
	readonly workflowId: string;
	readonly args?: readonly unknown[];
	readonly searchAttributes?: Readonly<Record<string, readonly unknown[]>>;
	readonly memo?: Readonly<Record<string, unknown>>;
	readonly workflowExecutionTimeout?: string | number;
	readonly workflowRunTimeout?: string | number;
	readonly workflowTaskTimeout?: string | number;
	readonly retry?: Readonly<Record<string, unknown>>;
}

/**
 * Structural subset of `@temporalio/worker.Worker` — only the methods
 * the worker-host factory uses.
 */
export interface TemporalWorker {
	run(): Promise<void>;
	shutdown(): void | Promise<void>;
}

/**
 * Operator-side: a "worker spec" the plugin's WorkerHostFactory needs
 * in order to materialise a `TemporalWorker`. The plugin doesn't
 * construct `Worker.create(...)` itself — that requires
 * `@temporalio/worker` which carries native deps. Instead the operator
 * provides a `build()` callback that returns the worker.
 */
export interface TemporalWorkerSpec {
	readonly taskQueue: string;
	build(): Promise<TemporalWorker>;
}

/** Common ctor opts for the dispatcher factory. */
export interface TemporalDispatcherFactoryOptions {
	readonly client: TemporalWorkflowClient;
	/**
	 * Default task queue used by `forWorkflow(...)` when the operator
	 * doesn't pass one explicitly. Per-tenant routing usually passes
	 * the queue per-call.
	 */
	readonly defaultTaskQueue?: string;
	/**
	 * Default workflow options merged under per-call options. Same
	 * field-by-field merge semantics as the BullMQ/pg-boss factories.
	 */
	readonly defaultWorkflowOptions?: Partial<Omit<TemporalStartWorkflowOptions, 'taskQueue' | 'workflowId' | 'args'>>;
}
