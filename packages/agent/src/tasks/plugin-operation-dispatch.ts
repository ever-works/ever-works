/**
 * EW-693 / T27 — the long-running plugin operation job, named ONCE.
 *
 * `PluginExecutionRouterService` dispatches it through the active job runtime
 * (looked up by method name on `IJobRuntimeProvider.dispatchers`, the same way
 * `dispatchAppForkReadiness` is — see `app-works.module.ts`), the Trigger.dev
 * provider implements the method (`TriggerService.dispatchPluginOperation`),
 * and the worker task registers under the id. All three import these constants,
 * so the router, the dispatch site and the `task({ id })` registration cannot
 * disagree about a string on the wire.
 *
 * Deliberately dependency-free: the plugins module imports it, and so does the
 * worker, without pulling anything else in.
 */

/** The Trigger.dev task id `run-plugin-operation` registers under. */
export const PLUGIN_OPERATION_TASK_ID = 'run-plugin-operation' as const;

/** The method the active job runtime's `dispatchers` exposes for this job. */
export const PLUGIN_OPERATION_DISPATCH_METHOD = 'dispatchPluginOperation' as const;

/**
 * How long a run may wait in the QUEUE before it expires (the dispatch's
 * `ttl`). The run's `maxDuration` does not count queue time.
 */
export const PLUGIN_OPERATION_QUEUE_TTL_SECONDS = 15 * 60;

/** The task's `maxDuration`: the longest one operation may execute. */
export const PLUGIN_OPERATION_MAX_DURATION_SECONDS = 60 * 60;

/**
 * How long the router waits for a run by default: its whole legitimate
 * lifetime — the queue TTL plus `maxDuration` — plus 5 minutes for the worker
 * to boot and hydrate its plugins. Anything shorter could give up on a run
 * that goes on to succeed.
 */
export const PLUGIN_OPERATION_DEFAULT_WAIT_MS =
    (PLUGIN_OPERATION_QUEUE_TTL_SECONDS + PLUGIN_OPERATION_MAX_DURATION_SECONDS + 5 * 60) * 1000;

/** What one long-running plugin operation run is asked to do. Data only — it crosses a process boundary. */
export interface PluginOperationPayload {
    readonly pluginId: string;
    /**
     * An operation the plugin DECLARES in its manifest
     * (`everworks.plugin.operations` — see `resolvePluginOperation`).
     */
    readonly operation: string;
    readonly args?: Record<string, unknown>;
    /**
     * T26 / EW-742 P3: the tenant the router dispatched for, present only on a
     * tenant call. The run itself was started through that tenant's view of the
     * job runtime (`TenantAwareRuntimeResolver`).
     */
    readonly tenantId?: string;
    /**
     * FR-5 (tenant-job-runtime-overlay spec) enqueue-time capture, from
     * `RuntimeBindingStamperService.stamp(tenantId)`: present on a tenant call
     * when the stamper is bound, `null` when no overlay is active for the
     * tenant (or the lookup failed). The Trigger.dev worker does not read them:
     * it is push-model, and the run already executes in the project it was
     * dispatched to. They are recorded for the credential-rotation drain.
     */
    readonly providerId?: string | null;
    readonly credentialVersion?: number | null;
}

/**
 * The dispatcher method, as the router calls it: the run id, or `null` when
 * the runtime could not accept the run (not configured, the enqueue failed).
 */
export type PluginOperationDispatch = (payload: PluginOperationPayload) => Promise<string | null>;
