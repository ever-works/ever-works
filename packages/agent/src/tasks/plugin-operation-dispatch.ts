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

/** What one long-running plugin operation run is asked to do. Data only — it crosses a process boundary. */
export interface PluginOperationPayload {
    readonly pluginId: string;
    /** A method name the plugin's own classes define (see `resolvePluginOperation`). */
    readonly operation: string;
    readonly args?: Record<string, unknown>;
}

/**
 * The dispatcher method, as the router calls it: the run id, or `null` when
 * the runtime could not accept the run (not configured, the enqueue failed).
 */
export type PluginOperationDispatch = (payload: PluginOperationPayload) => Promise<string | null>;
