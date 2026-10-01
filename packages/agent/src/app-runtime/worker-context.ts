/**
 * APW-06 T20 (with T71) — **the App cluster worker context**: the one bit that decides whether
 * this process may dial a cluster at all.
 *
 * Spec: `docs/specs/features/app-works/APW-06-app-runtime/spec.md` FR-5 ("the API never dials a
 * cluster"), ACC-06-04. Plan: §6.2 (`plan.md:940-949`, the isolated worker), §6.4
 * (`plan.md:966-991`, the `TriggerAppRuntimeModule` bootstrap), §2.3
 * (`plan.md:1261-1270`, "no in-process fallback for App runtime work").
 *
 * ## A process-level flag, and that is the whole point
 *
 * This is **not** an environment variable, and it must never become one. An env var is set by
 * whoever starts the process — a `.env` file, a compose file, a Helm value — so a misconfigured or
 * merely careless API deployment could turn it on and give the request path a route to a cluster
 * (FR-3: a member's pasted kubeconfig would then be dialled *from the API process*, before the
 * §6.1 guard and before any isolated worker). A module-level flag cannot be set that way: the only
 * writer is {@link markAppClusterWorkerContext}, the only caller of that writer is the
 * `TriggerAppRuntimeModule` bootstrap provider's `onModuleInit` (T71,
 * `packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts`), and that module is
 * booted with `NestFactory.createApplicationContext` by the `app-*` tasks alone.
 *
 * The distinction is therefore load-bearing, not stylistic:
 *
 * | | `process.env.*` | this flag |
 * | --- | --- | --- |
 * | who can set it | anything that can write the environment | only the worker's own bootstrap |
 * | when | before any code runs | `onModuleInit`, inside the worker's module graph |
 * | visible to the API | yes, by construction | only if the API imports the bootstrap provider |
 * | wrong value means | cluster I/O in the request path | cluster I/O in the request path |
 *
 * The last row is why `apps/api/src` carries a static test asserting that **no** file under it
 * imports the marker (`packages/agent/src/facades/__tests__/app-runtime.facade.spec.ts`): the flag
 * is safe because of who may call it, and that has to be asserted rather than assumed.
 *
 * ## What reads it
 *
 * - `AppRuntimeFacadeService` (T20) — **every** method call throws {@link AppClusterIoInApiError}
 *   unless this answers `true`. It is constructed in every process that imports `FacadesModule`,
 *   so the refusal is per-call, never at construction.
 * - `AppRuntimeTargetResolver` (T69, `plan.md:1554`) — the same rule, and it imports the guard from
 *   here rather than re-deriving one, so the two can never disagree.
 *
 * Unset is the fail-closed default: a process that never marked itself is not a worker, and
 * {@link isAppClusterWorkerContext} answers `false` for the whole lifetime of the process.
 *
 * Nothing here reads any environment variable, and nothing here reads the managed tier's ceiling
 * (R-5, `CONTRACTS.md` §0:48).
 */

/** The machine-readable code every refusal carries (§6.2, ACC-06-04). */
export const APP_CLUSTER_IO_IN_API = 'APP_CLUSTER_IO_IN_API' as const;

/** What the refusal says when a caller does not name the operation it was about to perform. */
const DEFAULT_REFUSAL_MESSAGE =
    `App cluster I/O is not available in this process (${APP_CLUSTER_IO_IN_API}): it runs on the ` +
    'isolated App runtime worker only.';

/**
 * Thrown by {@link requireAppClusterWorkerContext} — a real `Error` subclass carrying the typed
 * `code`, the shape this package's other refusals use (`AppPortUnavailableError`,
 * `packages/agent/src/app-runtime/ports.ts:84`; `DeploymentContextResolutionError`,
 * `packages/agent/src/facades/deployment-context.resolver.ts:22`).
 *
 * The message never carries a credential, a Work id or a kubeconfig — only the operation name.
 */
export class AppClusterIoInApiError extends Error {
    readonly code = APP_CLUSTER_IO_IN_API;

    constructor(
        operation?: string,
        readonly reason?: string,
    ) {
        super(
            operation
                ? `${DEFAULT_REFUSAL_MESSAGE} ('${operation}' is worker-only.)`
                : DEFAULT_REFUSAL_MESSAGE,
        );
        this.name = 'AppClusterIoInApiError';
    }
}

/**
 * The process-level flag. Deliberately a module-level binding and not a property of a service:
 * a per-instance flag would be one injection away from being armed by a caller, and the whole
 * guarantee is that only the worker's bootstrap can arm it.
 */
let appClusterWorkerContext = false;

/**
 * Mark **this process** as the isolated App runtime worker (T71's bootstrap provider, in
 * `onModuleInit`). Idempotent, and there is deliberately no un-marking function: a worker that
 * unmarked itself could later look like an API process and refuse work it should have run, and
 * nothing needs the transition.
 */
export function markAppClusterWorkerContext(): void {
    appClusterWorkerContext = true;
}

/** `true` only in the process that called {@link markAppClusterWorkerContext}. Unset ⇒ `false`. */
export function isAppClusterWorkerContext(): boolean {
    return appClusterWorkerContext === true;
}

/**
 * The guard every App cluster entry point calls first. Throws {@link AppClusterIoInApiError} when
 * this process is not the worker, and returns `void` when it is.
 *
 * `operation` is the method that refused, so an operator reading the log knows which call was
 * attempted — it is never a value the caller supplied.
 */
export function requireAppClusterWorkerContext(operation?: string): void {
    if (!isAppClusterWorkerContext()) {
        throw new AppClusterIoInApiError(operation);
    }
}
