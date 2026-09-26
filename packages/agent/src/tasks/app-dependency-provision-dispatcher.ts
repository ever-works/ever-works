import type { AppDependencyProvisionPayload } from './app-dependency-provision.types';

/**
 * APW-07 T17 — producer-side interface for the `app-dependency-provision` job
 * (plan §7:864-877, `tasks.md:257-266`), implemented by the configured
 * job-runtime provider (Constitution IV).
 *
 * `AppDependenciesService` calls `dispatchAppDependencyProvision(...)` from
 * `reconcile`, `configure`, `retry` and `requestDataDeletion`, and the running
 * job calls it again to schedule its own delayed re-dispatch. The work dials a
 * cluster (or an external server) and can retry for a quarter of an hour, so it
 * can never happen inside the request that asked for it.
 *
 * ## Errors PROPAGATE — this is the APW07-G24 shape
 *
 * Unlike the KB media dispatchers (`string | null`, where a `null` is a
 * deferral the reconciliation job eventually catches), this one throws. A
 * silently dropped provisioning dispatch leaves a dependency row at `pending`
 * with **nothing** scheduled behind it: `reconcile` already reported success,
 * the card shows *Provisioning* forever, and the only other thing that would
 * ever notice is the user re-opening the page. So the caller (`AppDependenciesService`,
 * which records `dispatchUnavailable`) and the job runtime see the failure and
 * can answer for it. `packages/tasks/src/trigger/trigger-tenant-client.factory.ts`
 * carries the same propagate shape rather than going through `softDispatch`.
 *
 * Mirrors {@link KbReembedWorkDispatcher} — the other loud-error dispatcher in
 * this package — so the binding factory in `job-runtime.providers.ts` wires it
 * with no special case.
 */
export interface AppDependencyProvisionDispatcher {
    /**
     * Enqueue one dependency provisioning run.
     *
     * @returns the job runtime's run id. Empty is a failure, not a deferral.
     * @throws when the runtime is disabled, when production is not attested as
     *   isolated (`EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED`, APW-06 plan §6.2:950-952)
     *   or when the runtime's own enqueue rejects.
     */
    dispatchAppDependencyProvision(payload: AppDependencyProvisionPayload): Promise<string>;
}

export const APP_DEPENDENCY_PROVISION_DISPATCHER = Symbol('APP_DEPENDENCY_PROVISION_DISPATCHER');
