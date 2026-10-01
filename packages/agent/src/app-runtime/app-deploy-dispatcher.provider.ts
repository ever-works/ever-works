/**
 * APW-06 §9.2 — the `app-deploy` dispatcher binding, and the isolation gate in
 * front of it.
 *
 * `AppDeployRequestService` and `AppDeployPreconditionsService` both take a
 * dispatcher `@Optional()` and both ask it the same question first: *is there an
 * isolated App cluster worker in this process?* Unbound, the answer is no and
 * every request is refused `422 worker_not_isolated` before a row exists. This
 * file is what makes the answer able to be yes.
 *
 * ## Why a provider of its own, and not an entry in `DISPATCHER_SYMBOLS`
 *
 * Every other `*_DISPATCHER` token is bound by `buildJobRuntimeProviders`, which
 * hands back the active runtime's `dispatchers` view and `null` when no runtime
 * is registered. That is almost right here — but only almost, and the difference
 * is the whole point of §9.2:
 *
 * `dispatchers` carries `dispatchAppDeploy` as soon as `TriggerService` declares
 * the method, **whether or not the operator has attested the worker**. Binding
 * the token straight to that view would open the gate in an unattested
 * production process: the request would pass, create a `work_deployments` row,
 * claim the deploy lock, and only then discover at dispatch time that the job
 * refuses to run. A row and a held lock for work that can never start is
 * strictly worse than the refusal.
 *
 * So the token is bound to a small object carrying the two members the service's
 * probe understands:
 *
 *   - `isEnabled()` — the attestation. `false` in production unless
 *     `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true`, which is the operator
 *     saying this queue's worker has no route to internal networks (plan
 *     §6.2:950-952). Outside production it is always `true`, because a
 *     developer's worker is their own machine.
 *   - `resolve()` — the active runtime's `dispatchers` view, or `null` when no
 *     runtime is registered. The probe then checks that what came back really
 *     carries `dispatchAppDeploy`, so a runtime that has not implemented it
 *     reads as "no isolated worker" rather than crashing at dispatch.
 *
 * Both refusal paths are the SAME answer the request service already gives for
 * an unbound token, which is why binding this can only ever move a request from
 * "refused before a row" to "dispatched" — never to "accepted, then stuck".
 *
 * ## The second copy of the attestation, and why it is not duplication
 *
 * `TriggerService.dispatchAppDeploy` re-checks the same flag and so does the
 * task itself. That is deliberate defence in depth on a boundary where the cost
 * of being wrong is cluster access from a process that should not have it: this
 * gate stops a row being created, the dispatcher stops a message being queued,
 * and the task stops a queued message dialling after the flag flips. Each one
 * refuses for the same stated reason, and none of them is load-bearing alone.
 */

import type { Provider } from '@nestjs/common';

import { config } from '../config';
import { JOB_RUNTIME_PROVIDER_REGISTRY, type JobRuntimeProviderRegistry } from '../tasks';
import { APP_DEPLOY_DISPATCHER } from './app-deploy-request.service';
import { APP_DEPLOY_DISPATCHER_AVAILABILITY } from './app-deploy-preconditions.service';

/**
 * The shape both probes read: `isEnabled()` then `resolve()`.
 *
 * Deliberately NOT `AppDeployDispatcher` — this object never dispatches
 * anything itself. It answers whether something else can.
 */
export interface AppDeployDispatcherGate {
    isEnabled(): boolean;
    resolve(): unknown;
}

/**
 * `true` ⇔ App cluster work may be dispatched from this process.
 *
 * Exported so the gate is testable without a Nest container, and so the one
 * sentence that decides it is readable in one place.
 */
export function appClusterDispatchAttested(): boolean {
    if (process.env.NODE_ENV !== 'production') return true;
    // Optional-chained and failing CLOSED: a partial config in a spec must read
    // as "not attested", never throw.
    return config.everWorks?.apps?.isClusterWorkerIsolated?.() === true;
}

/**
 * The registry, narrowed to the one method this file calls.
 *
 * `register` is the write half and belongs to whoever owns the runtime; a gate
 * that accepted the whole interface would be asking every caller — and every
 * spec — for a method it must never use.
 */
export type AppDeployRuntimeLookup = Pick<JobRuntimeProviderRegistry, 'getActive'>;

/** The gate over one registry — the value both tokens are bound to. */
export function appDeployDispatcherGate(
    registry: AppDeployRuntimeLookup | null | undefined,
): AppDeployDispatcherGate {
    return {
        isEnabled: () => appClusterDispatchAttested(),
        resolve: () => {
            if (!registry) return null;
            try {
                return registry.getActive()?.dispatchers ?? null;
            } catch {
                // A registry that throws is a registry that cannot tell us there
                // is a worker, which is the same answer as not having one.
                return null;
            }
        },
    };
}

/**
 * The two providers, bound to ONE gate instance.
 *
 * One instance on purpose: `AppDeployPreconditionsService` and
 * `AppDeployRequestService` ask the same question moments apart, and two
 * instances could disagree if the runtime were registered between the calls —
 * the request would then pass preconditions and refuse at the dispatch, or
 * worse, the other way round.
 */
export function buildAppDeployDispatcherProviders(): Provider[] {
    const gate = {
        provide: APP_DEPLOY_DISPATCHER,
        useFactory: (registry?: AppDeployRuntimeLookup) => appDeployDispatcherGate(registry),
        inject: [{ token: JOB_RUNTIME_PROVIDER_REGISTRY, optional: true }],
    };

    return [
        gate,
        // The availability probe reads the same object. `useExisting` rather than
        // a second factory, so the two can never answer differently.
        { provide: APP_DEPLOY_DISPATCHER_AVAILABILITY, useExisting: APP_DEPLOY_DISPATCHER },
    ];
}
