import type {
	TemporalDispatcherFactoryOptions,
	TemporalStartWorkflowOptions,
	TemporalWorkflowClient,
	TemporalWorkflowHandle
} from './temporal-types.js';

/**
 * EW-742 P3.2 follow-up — operator-facing factory that turns a
 * Temporal `WorkflowClient` into per-workflow dispatcher functions.
 *
 * # Usage (operator-side)
 *
 * ```ts
 * import { Connection, WorkflowClient } from '@temporalio/client';
 * import { TemporalJobRuntimePlugin, TemporalDispatcherFactory } from '@ever-works/job-runtime-temporal-plugin';
 *
 * const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
 * const client = new WorkflowClient({ connection, namespace: process.env.TEMPORAL_NAMESPACE });
 *
 * const factory = new TemporalDispatcherFactory({ client, defaultTaskQueue: 'ew' });
 * const plugin = new TemporalJobRuntimePlugin().useDispatchers({
 *   dispatchKbEmbedDocument: async (payload) => {
 *     const handle = await factory.start('kbEmbedDocumentWorkflow', {
 *       workflowId: `kb-embed:${payload.workId}`,
 *       args: [payload]
 *     });
 *     return handle.workflowId;
 *   }
 * }).useDispatcherFactory(factory);
 * ```
 *
 * # Per-tenant namespace routing
 *
 * For ADR-017 Q1 namespace-per-tenant, build one `WorkflowClient` per
 * tenant namespace and wrap each in its own factory; thread per-tenant
 * factories through `TemporalJobRuntimePluginOptions.dispatchersBuilder`.
 */
export class TemporalDispatcherFactory {
	constructor(private readonly opts: TemporalDispatcherFactoryOptions) {}

	/** Underlying client — exposed for operator advanced usage. */
	get client(): TemporalWorkflowClient {
		return this.opts.client;
	}

	/**
	 * Start a workflow. Returns the `WorkflowHandle` so the operator
	 * can decide whether to map its `workflowId` onto the agent's
	 * dispatcher-return value (typical) or block on completion.
	 */
	async start(workflowType: string, options: Partial<TemporalStartWorkflowOptions> & { workflowId: string }): Promise<TemporalWorkflowHandle> {
		const taskQueue = options.taskQueue ?? this.opts.defaultTaskQueue;
		if (!taskQueue) {
			throw new Error(
				`TemporalDispatcherFactory: no taskQueue supplied for workflow '${workflowType}' (workflowId=${options.workflowId}). ` +
					'Pass `taskQueue` per-call or set `defaultTaskQueue` on the factory.'
			);
		}
		const merged: TemporalStartWorkflowOptions = {
			...(this.opts.defaultWorkflowOptions ?? {}),
			...options,
			taskQueue
		};
		return this.opts.client.start(workflowType, merged);
	}

	/**
	 * Cancel a workflow by id. Returns `true` when the cancel call
	 * resolves; `false` when the Temporal client throws (typical for
	 * unknown workflow ids or already-terminal runs).
	 */
	async cancel(workflowId: string): Promise<boolean> {
		try {
			const handle = this.opts.client.getHandle(workflowId);
			await handle.cancel();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Look up a workflow's lifecycle status. Returns the raw Temporal
	 * status name (e.g. `RUNNING`, `COMPLETED`); the plugin's
	 * `getRunStatus` projects onto our 6-state `JobRunStatus` union.
	 */
	async describe(workflowId: string): Promise<string | null> {
		try {
			const handle = this.opts.client.getHandle(workflowId);
			const desc = await handle.describe();
			return desc.status.name;
		} catch {
			return null;
		}
	}
}
