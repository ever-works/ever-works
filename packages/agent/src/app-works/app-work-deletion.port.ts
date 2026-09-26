/**
 * APW-01 T39 — the App Work deletion port (plan §7 `:954-982`, Resolution R-15).
 *
 * Deleting an App Work is not only a row delete: the App runtime must first remove the
 * Work's cluster workloads (Deployments, Services, Ingresses, Jobs, CronJobs, network
 * policies and its environment Secret) on whatever target it deploys to, ask the App
 * dependency layer to release or deprovision what it holds, and — only when the member
 * asked — delete the stored data. That work belongs to **APW-06**
 * (`AppRuntimeDeletionService`, `packages/agent/src/app-runtime/app-runtime-deletion.service.ts`)
 * and **APW-07** (App dependencies). The service exists, and its
 * `APP_WORK_DELETION_PORT_PROVIDER` is the binding of THIS token; no API module provides
 * it yet (APW-06 T33 adds it), so in a running API the token is still unbound.
 *
 * So this epic declares the SEAM and nothing else, exactly as it did for
 * `APP_SOURCE_CATALOG_PORT` (T11) and `APP_PROMPTED_VALUES_PORT` (T11): a symbol, a
 * request shape, an outcome shape, and the rule that an unbound token means "the App
 * runtime is not here yet, so nothing can be running" — which is why
 * `WorkLifecycleService.deleteWork` treats unbound as `done` and keeps today's
 * behaviour byte-identical until the binding lands.
 *
 * 🛑 **This file is the ONLY declaration of the token.** The runtime imports it from
 * here and re-exports it; it once declared its own `Symbol('APP_WORK_DELETION_PORT')`,
 * which Nest treats as a different token, so its provider could never have reached the
 * injection in `WorkLifecycleService`. `app-works-port-dormancy.spec.ts` fails on any
 * two `Symbol()` declarations under `packages/agent/src` that share a description.
 *
 * ## The contract, in two sentences
 *
 * `requestDeletion` is called **before any repository step** and never touches a
 * repository itself. It answers `done` (nothing left to remove — delete the Work row
 * now) or `pending` (the removal is dispatched; the row must stay until APW-06 calls
 * `WorkLifecycleService.completeAppWorkDeletion(workId)`).
 *
 * ## Why `deleteStoredData` is a boolean and not the flag itself
 *
 * The typed-slug confirmation of FR-40b is enforced by the service **before** this port
 * is called, so a `true` here means "the member ticked the box AND typed the slug".
 * Passing the raw DTO through would let a future second caller re-decide that.
 *
 * Nothing here is persisted, fetched or dialled: plain JSON shapes and one symbol, and
 * the file imports nothing — so the App runtime can import the token from here without
 * adding an import cycle (the same reason the sibling ports live beside their tokens).
 */

/** What the App runtime is asked to remove, and for whom. */
export interface AppWorkDeletionRequest {
    /** The Work whose workloads must go. */
    workId: string;
    /** The member who asked — the runtime acts with their credentials. */
    userId: string;
    /**
     * `true` only on the explicit flag, never on an omitted one (FR-39, FR-40a); the
     * typed slug was already confirmed by the caller (FR-40b).
     */
    deleteStoredData: boolean;
}

/** What the removals recorded, in the vocabulary the runtime owns (plan §3.2). */
export interface AppWorkDeletionOutcome {
    /** `done`: nothing left to remove, delete the row now. `pending`: removal dispatched, keep the row. */
    status: 'pending' | 'done';
    /** The target the removal was issued against — what the member is told, never inferred. */
    target: 'none' | 'your-cluster' | 'ever-works-apps';
    /** A reason CODE only, so nothing a value carries can reach a log or a response. */
    reason?: string;
}

/** The App runtime's deletion entry point (APW-06 binds this token). */
export interface AppWorkDeletionPort {
    /** Never touches a repository. Idempotent while a deletion is already pending. */
    requestDeletion(input: AppWorkDeletionRequest): Promise<AppWorkDeletionOutcome>;
}

/** The injection token. Unbound ⇒ no App runtime exists yet ⇒ deletion is taken as `done`. */
export const APP_WORK_DELETION_PORT = Symbol('APP_WORK_DELETION_PORT');
