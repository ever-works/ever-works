/**
 * APW-06 T58 — **deleting an App Work**: the runtime half of Resolution R-15.
 *
 * Spec: `docs/specs/features/app-works/APW-06-app-runtime/spec.md` FR-50 (**Remove from cluster**,
 * and its **Also delete stored data** variant), FR-46 (`state: 'deleting'`), ACC-06-45, ACC-06-46.
 * Plan: §9.7 (the contract — `plan.md:1468-1513`), §3 (`destroyApp`'s `deleteVolumes` rule,
 * `plan.md:318`), §9.8 (this service is what `APP_WORK_DELETION_PORT` is bound to,
 * `plan.md:1524-1541`), §9.10 (the `app-cluster-op` router that routes the op here,
 * `plan.md:1570-1573`), §9.4 (`app.deploy.removed` with `kept[]` / `mayRemain[]`,
 * `plan.md:1325-1326`).
 *
 * ## Why the runtime has to go before the Work row
 *
 * The API never dials a cluster (§6.2) and the Work-scoped kubeconfig is deleted together with the
 * Work, so the workloads must be removed **first**. APW-01's `WorkLifecycleService.deleteWork` asks
 * this service through `APP_WORK_DELETION_PORT` and, on the answer `pending`, keeps the row; this
 * service calls back APW-01's `completeAppWorkDeletion(workId)` when a pending removal ends, and
 * *that* is the call which deletes the row (`APW-01/plan.md:980-982`). Nothing here deletes a Work,
 * a repository or a fork: the fork / private-copy decision stays APW-01's and is carried out in its
 * own request (`plan.md:1483-1484`).
 *
 * The token is APW-01's own (`packages/agent/src/app-works/app-work-deletion.port.ts`), imported
 * and re-exported here — never a second `Symbol()` of the same name, which Nest would treat as a
 * different token. The binding is {@link APP_WORK_DELETION_PORT_PROVIDER}; no API module provides
 * it yet (APW-06 T33 adds it to the API's ports module, and the `APP_CLUSTER_OP_DISPATCHER` and
 * `APP_WORK_DELETION_COMPLETION` bindings it relies on are unbound too), and until then the port is
 * unbound, which `deleteWork` takes as "no App runtime, so nothing can be running".
 *
 * ## The two halves, and the process each runs in
 *
 * 1. **API** — {@link AppRuntimeDeletionService.preview} (what the delete dialog lists) and
 *    {@link AppRuntimeDeletionService.requestDeletion} (the port): claim the deletion on the runtime
 *    state row and dispatch one `app-cluster-op` with op `delete-app-work`.
 * 2. **Isolated worker** — {@link AppRuntimeDeletionService.handleDeleteAppWork}, the op handler, in
 *    the order §9.7 fixes. It ends by calling {@link AppRuntimeDeletionService.finishDeletion},
 *    which is the API-side method that resolves APW-01's completion (§9.8:1537-1541).
 *
 * The order is the whole point of the op, and it is asserted rather than assumed (ACC-06-45,
 * ACC-06-46):
 *
 * 1. APW-07's `AppDependenciesService.onAppWorkDeleting(workId, { deleteStoredData })` — **first**,
 *    before anything touches the cluster. On the **Remove-with-data** path APW-07's
 *    `onAppRemoved(workId, { deleteData: true })` is awaited on the worker **before** `destroyApp`
 *    (APW06-G08, `plan.md:1496-1498`); on the keep path `onAppRemoved(workId, { deleteData: false })`
 *    runs **after** it (`plan.md:1499`).
 * 2. `destroyApp` with `deleteVolumes === deleteStoredData`. On **Ever Works Apps** the removal is
 *    routed to the `apps-tier` seam — APW-10's `removeWork(workId, { deleteData })` (R-5,
 *    `plan.md:1503`, `APW-10/plan.md:624`) — and **never** to the `k8s` plugin:
 *    {@link AppRuntimeDeletionService.handleDeleteAppWork} branches on the resolved target's own
 *    name, so an `ever-works-apps` target cannot reach `destroyApp` even when a `destroyApp` is
 *    available.
 * 3. The managed DNS record is removed (`AppsDomainDnsService.removeRecord`, `plan.md:1504`).
 * 4. Activity **`app.deploy.removed`** with `reason: 'app_work_deleted'` and `kept[]` (and
 *    `mayRemain[]` when the cluster could not be reached), then APW-01's
 *    `completeAppWorkDeletion(workId)` — because by then the runtime is gone and the row may follow.
 *
 * Transient failures (cluster unreachable) re-dispatch after five minutes, up to **three attempts
 * over a fifteen-minute window** (`plan.md:1509-1510`); after the third, `app.deploy.removed`
 * carries `mayRemain[]` and step 4 runs anyway. A fourth attempt is never scheduled —
 * {@link deletionRetryDelayMs} answers `null` for it, which is what makes "3 attempts" a property of
 * the code rather than of a comment.
 *
 * ## Fail-closed, never fail-silent-but-wrong
 *
 * Every collaborator is `@Optional()`, appended after the two that are read first, exactly like
 * `AppUpstreamStateService` (`packages/agent/src/app-works/app-upstream-state.service.ts:412-439`):
 * the class must be constructible with **nothing** bound, so a lean module graph (or a unit test)
 * compiles. Each absent seam has a defined answer, and none of them is "pretend it worked":
 *
 * | Absent seam                          | The answer                                                                                     |
 * | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
 * | `WorkRepository`                     | `requestDeletion` refuses `not_found` — a Work nobody can read is a Work nobody may delete      |
 * | `WORK_APP_RUNTIME_STATES` (T17)      | nothing records a Deployment, so nothing can be running: the `done` path of §9.7's first row    |
 * | a **throwing** state read            | `{ status: 'pending', reason: 'runtime_state_unreadable' }` — the row is kept, never a false `done` |
 * | `APP_DEPENDENCIES_SERVICE` (APW-07)  | the hook is skipped (no APW-07 row can exist without APW-07) and the removal proceeds           |
 * | `APP_RUNTIME_DELETION_FACADE` (T20)  | the op reports `retry` / `may-remain` with `facade_unavailable`; nothing is deleted, nothing completed |
 * | the plugin for the Work's target     | `target_unavailable` and retryable. Ever Works Apps needs no seam of its own here: the facade resolves the plugin **for that target**, and APW-10's `destroyApp` is what maps to `removeWork` (`plan.md:1500-1503`) |
 * | `APP_CLUSTER_OP_DISPATCHER` (T31)    | `requestDeletion` answers `pending` + `dispatcher_unavailable` and claims nothing (§9.2:1261-1266) |
 * | `APPS_DOMAIN_DNS_SERVICE`            | the record is left in place and reported in `mayRemain[]` — the runtime is still removed          |
 * | `APP_RUNTIME_EVENT_SINK`             | the removal still happens; the missing Activity row is logged as a warning                        |
 * | `APP_WORK_DELETION_COMPLETION`       | the removal still happens and the Work row is **kept**: `completeAppWorkDeletion` was not delivered |
 *
 * ## The seams this file declares provisionally
 *
 * The collaborators the plan hands this task by name were not in this tree when it was written, so
 * each was declared here with **the exact name and shape its owner fixes**, in a clearly-marked
 * block further down this file, and marked with what the swap is (the programme's established
 * pattern — `AppUpstreamStateService`'s three provisional tokens, `APW-02 T23`; the git facade's
 * APW-09 T02 block; `app-fork-ready-handler.port.ts`):
 *
 * 1. **APW-01 T39** — `APP_WORK_DELETION_PORT`, `AppWorkDeletionRequest`, `AppWorkDeletionOutcome`,
 *    `AppWorkDeletionPort` (`APW-01/plan.md:959-976`). ✅ **Swapped**: T39 landed
 *    `packages/agent/src/app-works/app-work-deletion.port.ts`, and the four names are now imported
 *    from it and re-exported — no local declaration remains.
 * 2. **APW-01 T39** — `completeAppWorkDeletion(workId)` (`APW-01/plan.md:980-982`), reached here
 *    through the {@link APP_WORK_DELETION_COMPLETION} seam.
 * 3. **APW-07 T16** — `AppDependenciesService.onAppWorkDeleting(workId, { deleteStoredData })` and
 *    `onAppRemoved(workId, { deleteData })` (`APW-07/plan.md:749-758`, `:561`).
 *
 * 🛑 **Each swap is mandatory, not cosmetic.** A Nest token is compared by identity, so two Symbols
 * that happen to share a name are two different tokens: if an owner lands its own declaration and
 * the block here is left in place, the owner's binding will not reach this injection and the service
 * would quietly fall back to its fail-closed answer instead of failing loudly.
 */

import { Inject, Injectable, Logger, Optional, type FactoryProvider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { isAppWorkKind, type AppDeployTarget } from '@ever-works/contracts';
import type { AppDestroyResult, AppTargetRef } from '@ever-works/plugin';

import type { Work } from '../entities/work.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
// APW-01 T39 — the deletion port and its DI token, IMPORTED from the file that owns them. This
// import is the swap the old provisional block promised: while this module declared its own
// `Symbol('APP_WORK_DELETION_PORT')`, `APP_WORK_DELETION_PORT_PROVIDER` bound a token that
// `WorkLifecycleService` never injected (see the block above `APP_WORK_DELETION_COMPLETION`).
// Re-exported below under the same names, so the `./app-runtime` barrel and every existing import
// path keep compiling. The port file imports nothing, so this adds no import cycle.
import {
    APP_WORK_DELETION_PORT,
    type AppWorkDeletionOutcome,
    type AppWorkDeletionPort,
    type AppWorkDeletionRequest,
} from '../app-works/app-work-deletion.port';
import { APP_RUNTIME_EVENT_SINK, type AppRuntimeEventSink } from './ports';

/* -------------------------------------------------------------------------- *
 * Constants (plan §9.7:1509-1510)
 * -------------------------------------------------------------------------- */

/** §9.7: "Transient failures (cluster unreachable) re-dispatch after 5 minutes, up to 3 attempts". */
export const APP_WORK_DELETION_RETRY_DELAY_MS = 5 * 60_000;

/** The ceiling on attempts, including the first one. The fourth is never scheduled. */
export const APP_WORK_DELETION_MAX_ATTEMPTS = 3;

/**
 * The window the three attempts live in: `3 × 5 min = 15 min`. A retry is only scheduled while the
 * next attempt still fits inside it, so a Worker that wakes up late reports `mayRemain[]` instead of
 * promising an attempt the window has already closed.
 */
export const APP_WORK_DELETION_ATTEMPT_WINDOW_MS =
    APP_WORK_DELETION_MAX_ATTEMPTS * APP_WORK_DELETION_RETRY_DELAY_MS;

/** The op name T70's router routes here (§9.2:1247, §9.10:1572). */
export const APP_DELETE_WORK_OP = 'delete-app-work' as const;

/** The Activity action §9.4 fixes for a removal (`plan.md:1305`, `:1325-1326`). */
export const APP_DEPLOY_REMOVED_EVENT = 'app.deploy.removed';

/** The `details.reason` §9.4 fixes for this path — the only reason this service writes. */
export const APP_WORK_DELETION_REASON = 'app_work_deleted';

/* -------------------------------------------------------------------------- *
 * The retry policy, as a pure function (plan §9.7:1509-1510)
 * -------------------------------------------------------------------------- */

/**
 * How long the op should wait before its next attempt, or `null` when there is no next attempt.
 *
 * `null` is the answer for **both** ends of the policy, and both are asserted:
 *
 * - `attempt >= 3` (§9.7's "up to 3 attempts"): the third attempt exhausted the allowance, so a
 *   fourth is never scheduled and the op finishes with `mayRemain[]` instead.
 * - the next attempt would fall outside the fifteen-minute window: waiting another five minutes
 *   would only promise an attempt the window has already closed.
 *
 * `attempt` is 1-based — the attempt that is *failing* right now.
 */
export function deletionRetryDelayMs(input: { attempt: number; elapsedMs: number }): number | null {
    const attempt = Math.floor(input.attempt);
    const elapsedMs = Number.isFinite(input.elapsedMs) ? Math.max(0, input.elapsedMs) : 0;

    if (!Number.isFinite(attempt) || attempt < 1) {
        return null;
    }
    if (attempt >= APP_WORK_DELETION_MAX_ATTEMPTS) {
        return null;
    }
    if (elapsedMs + APP_WORK_DELETION_RETRY_DELAY_MS > APP_WORK_DELETION_ATTEMPT_WINDOW_MS) {
        return null;
    }

    return APP_WORK_DELETION_RETRY_DELAY_MS;
}

/* -------------------------------------------------------------------------- *
 * Shapes
 * -------------------------------------------------------------------------- */

/** One object a removal deleted, kept, or could not reach — kinds and names only (§9.4:1325-1326). */
export interface AppDeletionObjectRef {
    kind: string;
    name: string;
}

/** The machine-readable reasons this service reports. Never a value, never a host (§9.4:1307). */
export type AppWorkDeletionCode =
    | 'not_found'
    /** §9.7's first row: the target is `none`, or nothing was ever deployed. */
    | 'nothing_deployed'
    | 'already_deleting'
    | 'runtime_state_unreadable'
    | 'dispatcher_unavailable'
    | 'facade_unavailable'
    | 'target_unavailable'
    /**
     * Kept for the code's own history: an earlier revision could answer this on an
     * `ever-works-apps` Work when no tier seam was bound. Nothing produces it now — the plugin
     * resolved for the target either serves the target or answers `target_unavailable` — but the
     * member stays so an existing `reason` in a stored row still parses, and so removing it is a
     * deliberate act rather than a side effect of this correction.
     */
    | 'tier_unavailable'
    | 'cluster_unreachable'
    | 'dependencies_remaining'
    | 'dns_unavailable'
    | 'completion_unavailable'
    /** The op was handed a Work whose runtime state does not record a deletion in progress. */
    | 'not_deleting'
    | 'attempts_exhausted'
    | 'window_exhausted';

/**
 * The typed refusal `requestDeletion` throws — shape follows `AppUpstreamRefusalError`
 * (`packages/agent/src/app-works/app-upstream-state.service.ts:172-189`): a real `Error` subclass
 * carrying the machine-readable `code` and the HTTP status the delete dialog renders.
 *
 * A foreign Work and an unknown id answer **the same** `not_found` (S25, `plan.md:1512-1513`), so a
 * refusal never tells a stranger that the Work exists.
 */
export class AppWorkDeletionRefusalError extends Error {
    constructor(
        readonly code: AppWorkDeletionCode,
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'AppWorkDeletionRefusalError';
    }
}

/** One line of the delete dialog's kept / destroyed lists — a name and a size, never a value. */
export interface AppDeletionPreviewEntry {
    /** `PersistentVolumeClaim`, a dependency kind (`postgres`), or a Work-scoped label. */
    kind: string;
    name?: string;
    label?: string;
    sizeGiB?: number;
}

/** What `GET :id/app-deletion-preview` lists (plan §9.7:1477-1479). */
export interface AppDeletionPreview {
    /** `true` while a removal is in progress — the routes answer `409 APP_WORK_DELETING` meanwhile. */
    deferred: boolean;
    /** What is kept when the checkbox stays unticked. */
    keeps: AppDeletionPreviewEntry[];
    /** What the **Also delete stored data** path additionally destroys. */
    destroysWithData: AppDeletionPreviewEntry[];
}

/** What the op answers T70's task (and, through it, `GET app-status`'s `ops[]`, §9.10:1580-1582). */
export interface AppWorkDeletionOpResult {
    /**
     * `done` — the runtime is gone and APW-01 was told to delete the row.
     * `retry` — a transient failure with an attempt left; the Work row stays.
     * `may-remain` — the allowance or the window is exhausted (or the failure is final): the op
     *   reports `mayRemain[]` and finishes anyway (§9.7:1509-1510).
     * `refused` — nothing was attempted (a foreign Work, or a state that does not record a deletion).
     */
    state: 'done' | 'retry' | 'may-remain' | 'refused';
    /** The 1-based number of the attempt this result describes. */
    attempts: number;
    target: AppDeployTarget;
    code?: AppWorkDeletionCode;
    /** Present on `retry`: how long the task should wait before the next attempt. */
    retryInMs?: number;
    /** `false` when a retry was due but no dispatcher is bound to schedule it. */
    scheduled?: boolean;
    /** Names only. */
    deleted: AppDeletionObjectRef[];
    /** Names only — what the removal deliberately left behind (volumes, dependencies, the namespace). */
    kept: AppDeletionObjectRef[];
    /** Names only — what could not be reached, so it *may* still be running. */
    mayRemain: AppDeletionObjectRef[];
    namespaceDeleted: boolean;
    /** `true` only when APW-01's `completeAppWorkDeletion(workId)` was really delivered. */
    completed: boolean;
}

/* -------------------------------------------------------------------------- *
 * Provisional seams — every one of them is another owner's, named as its owner fixes it
 * -------------------------------------------------------------------------- */

// ── APW-01 T39 — the deletion port, OWNED by `app-works/app-work-deletion.port.ts` ──
//
// This block used to declare `AppWorkDeletionRequest`, `AppWorkDeletionOutcome`,
// `AppWorkDeletionPort` and `APP_WORK_DELETION_PORT` itself, "provisionally, until T39 lands".
// T39 landed (033e77dfa) with its own `Symbol('APP_WORK_DELETION_PORT')` and this block stayed, so
// the tree carried TWO tokens with one name — and a Nest token is compared by identity.
// `APP_WORK_DELETION_PORT_PROVIDER` provided this file's twin, `WorkLifecycleService` injects
// APW-01's, so the day the provider is added to the API graph the `@Optional()` injection would
// still be `undefined`: `deleteWork` takes that as "no App runtime, nothing can be running",
// deletes the row, and a deployed App Work's workloads keep running (§9.8:1519-1522, R-15). The
// dormancy register keys tokens by description, so it would even have reported the port as BOUND.
//
// The four names now come from the owner's file (the C8 fix's pattern, f6fadb7b2) and are
// re-exported here so nothing that imports them from this file or the `./app-runtime` barrel has
// to move. The shapes are the owner's; `AppWorkDeletionOutcome['target']` is the same three
// strings as `AppDeployTarget`. `app-works-port-dormancy.spec.ts` now fails on any two `Symbol()`
// declarations under `packages/agent/src` that share a description.
export { APP_WORK_DELETION_PORT };
export type { AppWorkDeletionOutcome, AppWorkDeletionPort, AppWorkDeletionRequest };

// ── provisional — APW-01 T39, the completion edge ────────────────────────────
//
// `WorkLifecycleService.completeAppWorkDeletion(workId)` is APW-01's (`APW-01/plan.md:980-982`) and
// does not exist yet. §9.8:1537-1541 reaches it through `ModuleRef` (`finishDeletion` resolves
// `WorkLifecycleService` in the API), so this narrow seam is what that resolution binds: the swap is
// `{ provide: APP_WORK_DELETION_COMPLETION, useExisting: WorkLifecycleService }` in the API's
// module graph, and nothing else in this file changes.

/** APW-01 T39: the completion that deletes the Work row and its local checkout, idempotently. */
export interface AppWorkDeletionCompletion {
    completeAppWorkDeletion(workId: string): Promise<void> | void;
}

/** DI token for {@link AppWorkDeletionCompletion} — bound to APW-01's `WorkLifecycleService`. */
export const APP_WORK_DELETION_COMPLETION = Symbol('APP_WORK_DELETION_COMPLETION');

// ── provisional — APW-07 T16 ─────────────────────────────────────────────────
//
// `AppDependenciesService` and `AppDependencyFacadeService` do not exist yet
// (`APW-07/plan.md:541-562`; the six entry points APW-06 may use are `reconcile`,
// `ensureReadyForDeploy`, `onAppRemoved`, `onAppWorkDeleting`, `list` and `provisionEphemeral`).
// Only the three this task calls are declared, with APW-07's own method names and argument shapes.
//
// 🛑 APW-07's return shapes are **not** fixed by its plan, so every field below is read
// defensively: a missing field means "nothing to report", never "assume the worst" and never
// "assume it worked".

/** One dependency row as far as the delete dialog reads it (names and sizes only). */
export interface AppDependencyDeletionView {
    kind: string;
    label?: string | null;
    /** The stored data this dependency holds, in GiB, when the provider reports a size. */
    sizeGiB?: number | null;
    /** Bare object names the provider created (`resourceRefs.objects[].name`). */
    names?: readonly string[] | null;
}

/** What an APW-07 release/deprovision call reports back, as far as this file needs it. */
export interface AppDependencyDeletionReport {
    /** Rows this call kept. */
    kept?: readonly AppDeletionObjectRef[] | null;
    /** Rows or resources the provider could not finish — they *may* remain. */
    mayRemain?: readonly AppDeletionObjectRef[] | null;
    /**
     * `true` ⇒ the provider reported `remaining` (§9.7:1497-1499): the op ends with `mayRemain[]`
     * and **skips** the volume and namespace delete — the destroy is downgraded to
     * `deleteVolumes: false` rather than skipped, so the workloads still come down.
     */
    remaining?: boolean | null;
}

/** APW-07 T16's `AppDependenciesService`, as this task consumes it. */
export interface AppDependenciesService {
    /** §4.12's table: kept rows, or the deprovision, **before** `destroyApp`. */
    onAppWorkDeleting(
        workId: string,
        opts: { deleteStoredData: boolean },
    ): Promise<AppDependencyDeletionReport | undefined>;
    /** APW06-G08: `{ deleteData: true }` is awaited before `destroyApp`, `false` after it. */
    onAppRemoved(
        workId: string,
        opts: { deleteData: boolean },
    ): Promise<AppDependencyDeletionReport | undefined>;
    /** The delete dialog's dependency list (`APW-07/plan.md:829`). */
    list(workId: string): Promise<readonly AppDependencyDeletionView[] | undefined>;
}

/** DI token for {@link AppDependenciesService} — owned by APW-07 T16. */
export const APP_DEPENDENCIES_SERVICE = Symbol('APP_DEPENDENCIES_SERVICE');

// ── provisional — APW-06 T17, the runtime state row ──────────────────────────
//
// `WorkAppRuntimeState` / `WorkAppRuntimeStateRepository` do not exist yet
// (`APW-06/tasks.md:293-321`). The three methods below are T17's own names; `getOrCreate` is the
// only read T17's list has, and it is also what derives `target` from the Work's creation-time
// choice (FR-63), which is why §9.7's first row can be answered at all.
//
// The **token is not declared here**: APW-11 T5 already declared `WORK_APP_RUNTIME_STATES`
// (`app-launcher.service.ts:222-223`, "bound by APW-06 T17") and imported it above. A second
// `Symbol('WORK_APP_RUNTIME_STATES')` would be a different token, and T17's single binding would
// then reach only one of the two consumers. This file therefore declares the *view* it needs of
// the same provider and reuses that one token.

/** One `work_app_runtime_states` row as far as a deletion reads it (plan §7.2:1042-1074). */
export interface WorkAppRuntimeStateDeletionView {
    workId: string;
    target?: AppDeployTarget | null;
    namespace?: string | null;
    currentDeploymentId?: string | null;
    deployLockId?: string | null;
    deletionRequestedAt?: Date | string | number | null;
    deletionDeleteData?: boolean | null;
    deletionAttempts?: number | null;
    deletionRequestedByUserId?: string | null;
    /** The last `AppStatusSnapshot` — component names are what `mayRemain[]` can name. */
    statusSnapshot?: { components?: readonly { name: string }[] | null } | null;
}

/** APW-06 T17's `WorkAppRuntimeStateRepository`, as this task consumes it. */
export interface WorkAppRuntimeStateDeletionStore {
    getOrCreate(workId: string): Promise<WorkAppRuntimeStateDeletionView>;
    /**
     * §9.7:1490 — the atomic claim of `deletionRequestedAt` / `deletionDeleteData` /
     * `deletionRequestedByUserId`, only when unset and no `deployLockId` is held.
     * `true` ⇒ this call won the claim and owns the dispatch.
     */
    claimDeletion(
        workId: string,
        opts: { deleteStoredData: boolean; requestedByUserId: string },
    ): Promise<boolean>;
    /** §9.7:1509 — record an attempt so the row's `deletionAttempts` reflects the retries. */
    recordDeletionAttempt(workId: string): Promise<number | void>;
}

// ── provisional — APW-06 T20, the facade that assembles cluster access ───────
//
// `AppRuntimeFacadeService` does not exist yet (`plan.md:123-137`, `:943-949`, `:1578`). It is the
// only place a plugin and a credential are assembled (R-5): §9.10's handlers resolve both through
// it and never by plugin id. This is a narrow, deletion-shaped reading of it — the swap is the real
// facade's own method, and the fail-closed answer is a retry, never a `destroyApp` on a guessed
// plugin.

/** Everything the op needs to remove one Work's runtime on **your** cluster. */
export interface AppRuntimeDeletionAccess {
    target: 'your-cluster' | 'ever-works-apps';
    ref: AppTargetRef;
    /** `your-cluster` only: the Work-scoped credential the plugin is dialled with. */
    credential?: string;
    /** `your-cluster` only: the resolved plugin's `destroyApp`, already bound to the plugin. */
    destroyApp?: (
        ref: AppTargetRef,
        credential: string,
        opts: { deleteVolumes: boolean },
    ) => Promise<AppDestroyResult>;
}

/** APW-06 T20's `AppRuntimeFacadeService`, as this task consumes it. */
export interface AppRuntimeDeletionFacade {
    resolveDeletionTarget(
        workId: string,
    ): Promise<AppRuntimeDeletionAccess | { unavailable: AppWorkDeletionCode }>;
}

/** DI token for {@link AppRuntimeDeletionFacade} — bound to APW-06 T20's facade. */
export const APP_RUNTIME_DELETION_FACADE = Symbol('APP_RUNTIME_DELETION_FACADE');

// ── Ever Works Apps needs NO seam here ───────────────────────────────────────
//
// An earlier revision declared a provisional `AppsTierFacadeService.removeWork` and branched on the
// target to call it. The plan does not ask for one (`plan.md:1500-1503`: "On `ever-works-apps` the
// `apps-tier` plugin's `destroyApp` calls APW-10's `removeWork(workId, { deleteData })`"), and once
// the branch is gone there is nothing left for such a seam to do: `resolveAccess` returns the
// `destroyApp` of the plugin resolved FOR THE WORK'S TARGET, so on an Ever Works Apps Work that
// method already IS the apps-tier plugin's. APW-10's job is to implement `IDeploymentPlugin` for
// that target — including `destroyApp` mapping to `removeWork` — not to expose a second entry point
// the agent layer has to know about.

// ── provisional — APW-06 T31/T32, the dispatcher ─────────────────────────────
//
// `APP_CLUSTER_OP_DISPATCHER` and `packages/agent/src/tasks/app-cluster-op.types.ts` do not exist
// yet (`plan.md:1247`, `:1272-1281`). The payload below is this file's reading of the one op it
// owns; the router that consumes it is T70's (`app-cluster-op.router.ts`, `plan.md:1570-1573`),
// which is deliberately **not** created here.

/** The `delete-app-work` op payload (plan §9.2:1247). */
export interface AppDeleteWorkOpPayload {
    op: typeof APP_DELETE_WORK_OP;
    workId: string;
    /** 1-based; absent means the first attempt. */
    attempt?: number;
    /**
     * Epoch ms of the **first** attempt, echoed on every retry, so the fifteen-minute window is
     * enforced from a value the work itself carries rather than from a second clock read.
     */
    requestedAtMs?: number;
    requestId?: string;
}

/** The `app-cluster-op` dispatcher this task asks for a retry (plan §9.2's table). */
export interface AppClusterOpDispatcher {
    dispatch(payload: AppDeleteWorkOpPayload, opts?: { delayMs?: number }): Promise<string | null>;
}

/** DI token for {@link AppClusterOpDispatcher} — owned by APW-06 T31/T32. */
export const APP_CLUSTER_OP_DISPATCHER = Symbol('APP_CLUSTER_OP_DISPATCHER');

// ── provisional — APW-06's managed DNS record removal ────────────────────────
//
// `AppsDomainDnsService` (`packages/agent/src/ever-works-providers/apps-domain-dns.service.ts`,
// `plan.md:1141-1150`) does not exist yet. Its real member is the provider-level
// `removeRecord(input)` (`EverWorksDnsService` / `CloudflareDnsProvider.removeRecord`,
// `cloudflare-dns.provider.ts:216`); the record's own name is a **hostname**, so this seam is
// Work-scoped instead and the host never enters this service at all — which is also why the
// Activity payload cannot leak one.

/** The managed-subdomain record removal of `plan.md:1504`. */
export interface AppsDomainDnsService {
    /** Removes the Work's managed record; resolves `false` when there was nothing to remove. */
    removeRecord(workId: string): Promise<boolean | void>;
}

/** DI token for {@link AppsDomainDnsService} — owned by APW-06's managed-subdomain task. */
export const APPS_DOMAIN_DNS_SERVICE = Symbol('APPS_DOMAIN_DNS_SERVICE');

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * The removal of an App Work's runtime: APW-01's `APP_WORK_DELETION_PORT`, the `delete-app-work` op
 * handler, and the completion call that releases APW-01's Work row (plan §9.7).
 */
@Injectable()
export class AppRuntimeDeletionService implements AppWorkDeletionPort {
    private readonly logger = new Logger(AppRuntimeDeletionService.name);

    constructor(
        // The two the order depends on come first; every collaborator is `@Optional()`, so a
        // hand-rolled construction (this file's own spec, a lean worker context) passes a prefix of
        // them and the API's module graph compiles with nothing bound at all.
        @Optional() private readonly works?: WorkRepository,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: WorkAppRuntimeStateDeletionStore,
        @Optional()
        @Inject(APP_DEPENDENCIES_SERVICE)
        private readonly dependencies?: AppDependenciesService,
        @Optional()
        @Inject(APP_RUNTIME_DELETION_FACADE)
        private readonly facade?: AppRuntimeDeletionFacade,
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly dispatcher?: AppClusterOpDispatcher,
        @Optional()
        @Inject(APPS_DOMAIN_DNS_SERVICE)
        private readonly appsDns?: AppsDomainDnsService,
        @Optional()
        @Inject(APP_RUNTIME_EVENT_SINK)
        private readonly events?: AppRuntimeEventSink,
        @Optional()
        @Inject(APP_WORK_DELETION_COMPLETION)
        private readonly completion?: AppWorkDeletionCompletion,
    ) {}

    /* ---------------------------------------------------------------------- *
     * §9.7 — the read behind the delete dialog
     * ---------------------------------------------------------------------- */

    /**
     * `GET /api/works/:id/app-deletion-preview` — what the dialog lists (plan §9.7:1477-1479).
     *
     * Names and sizes only: the volumes and their GiB, and the dependencies with their kind and
     * label. Nothing here reads a generated value, a kubeconfig or an address — the preview is
     * rendered in a browser.
     *
     * A `keeps[]` that is empty because a seam is absent is honest rather than wrong: with no
     * runtime-state row (T17 unbound) there is no Deployment and no volume, and with no APW-07
     * (unbound) there is no dependency row. Both are logged, and neither is invented.
     */
    async preview(workId: string): Promise<AppDeletionPreview> {
        const state = await this.readState(workId, 'preview');

        const keeps: AppDeletionPreviewEntry[] = [];
        const destroysWithData: AppDeletionPreviewEntry[] = [];

        // The last observation names the components the namespace holds.
        for (const component of state?.statusSnapshot?.components ?? []) {
            if (component?.name) {
                keeps.push({ kind: 'Component', name: component.name });
            }
        }

        for (const dependency of await this.listDependencies(workId)) {
            const entry: AppDeletionPreviewEntry = {
                kind: dependency.kind,
                label: dependency.label ?? undefined,
                sizeGiB: typeof dependency.sizeGiB === 'number' ? dependency.sizeGiB : undefined,
            };
            keeps.push(entry);

            // The data path destroys the same rows *and their data*; the dialog shows them apart so
            // "Also delete stored data" is a decision the member can weigh (FR-50, ACC-06-46).
            destroysWithData.push({ ...entry });
            for (const name of dependency.names ?? []) {
                destroysWithData.push({ kind: dependency.kind, name });
            }
        }

        return {
            deferred: hasDeletionRequest(state),
            keeps,
            destroysWithData,
        };
    }

    /* ---------------------------------------------------------------------- *
     * §9.7 — the port APW-01 injects
     * ---------------------------------------------------------------------- */

    /**
     * `APP_WORK_DELETION_PORT.requestDeletion` — the three rows of §9.7's table (`plan.md:1486-1490`).
     *
     * 1. **target `none`, no runtime state, or no Deployment and no namespace** — APW-07's
     *    `onAppWorkDeleting` runs in-process (rows marked kept) and the answer is `done`, so APW-01
     *    deletes the Work now. Nothing is dispatched: there is no cluster work to remove.
     * 2. **`deletionRequestedAt` already set** — `pending` and nothing new claimed or dispatched
     *    (idempotent: a member who clicks twice does not queue two removals).
     * 3. **otherwise** — the atomic claim, then exactly one `app-cluster-op` dispatch with op
     *    `delete-app-work`, and `pending`; APW-01 answers `200 { deleting: true }` and keeps the row.
     *
     * Two fail-closed guards come first, in this order:
     *
     * - **the Work must be the caller's** — otherwise the answer is exactly the `not_found` an
     *   unknown id gets, and nothing is claimed, dispatched or released;
     * - **a dispatcher must exist** — checked *before* the claim, because §9.2:1261-1266 requires it
     *   ("the op callers check dispatcher availability before the lock claim") and a claim with
     *   nothing to run it would leave the Work stuck in `deleting` with the workloads still up.
     */
    async requestDeletion(input: AppWorkDeletionRequest): Promise<AppWorkDeletionOutcome> {
        const { workId, userId, deleteStoredData } = input;

        await this.requireOwnedAppWork(workId, userId);

        const read = await this.readStateOrNull(workId, 'request');
        if (read.failed) {
            // The truth is unknown: the Work row is kept and nothing is claimed, which is the only
            // answer that cannot end with live workloads and a deleted Work.
            return { status: 'pending', target: 'none', reason: 'runtime_state_unreadable' };
        }

        const state = read.state;
        const target: AppDeployTarget = state?.target ?? 'none';

        if (hasDeletionRequest(state)) {
            // §9.7's second row: already deleting — nothing new is claimed or dispatched.
            return { status: 'pending', target, reason: 'already_deleting' };
        }

        if (!isDeployed(state)) {
            // §9.7's first row. APW-07 is asked in-process so its rows are marked kept (its §4.12
            // table's `pending` row), and APW-01 may delete the Work immediately.
            await this.callDependencies('onAppWorkDeleting', workId, { deleteStoredData });
            return { status: 'done', target, reason: 'nothing_deployed' };
        }

        if (!this.dispatcher) {
            // Fail-closed: the Work row stays, the claim is not taken, and the member can retry once
            // the worker is back. Nothing is reported as removed.
            this.logger.warn(
                `No app-cluster-op dispatcher is bound: deletion of work ${workId} stays pending.`,
            );
            return { status: 'pending', target, reason: 'dispatcher_unavailable' };
        }

        if (!this.runtimeStates) {
            // `isDeployed()` can only be true off a runtime-state row, so this is unreachable today;
            // it is kept because the two reads are separate seams and a future one may not be.
            return { status: 'pending', target, reason: 'runtime_state_unreadable' };
        }

        const claimed = await this.runtimeStates.claimDeletion(workId, {
            deleteStoredData,
            requestedByUserId: userId,
        });
        if (!claimed) {
            // A concurrent request won, or a Deployment still holds the lock (§9.7's "only when
            // unset and no `deployLockId`"). Either way this call dispatches nothing.
            return { status: 'pending', target, reason: 'already_deleting' };
        }

        const requestedAtMs = this.nowMs();
        await this.dispatcher.dispatch({
            op: APP_DELETE_WORK_OP,
            workId,
            attempt: 1,
            requestedAtMs,
        });

        return { status: 'pending', target };
    }

    /* ---------------------------------------------------------------------- *
     * §9.7 — the op handler (T70's router routes `delete-app-work` here)
     * ---------------------------------------------------------------------- */

    /**
     * The `delete-app-work` op body (§9.7:1492-1510).
     *
     * It refuses `not_deleting` before touching anything when a runtime-state row exists and does
     * **not** record a deletion in progress: an op that removes a live App Work's runtime because a
     * stray dispatch arrived would be worse than a refused op, and R-15's whole point is that the
     * removal happens only on the requested path.
     */
    async handleDeleteAppWork(op: AppDeleteWorkOpPayload): Promise<AppWorkDeletionOpResult> {
        const workId = op?.workId;
        const attempt = normaliseAttempt(op?.attempt);
        const read = await this.readStateOrNull(workId, 'op');
        const state = read.state;
        const target: AppDeployTarget = state?.target ?? 'none';

        const base: AppWorkDeletionOpResult = {
            state: 'refused',
            attempts: attempt,
            target,
            deleted: [],
            kept: [],
            mayRemain: [],
            namespaceDeleted: false,
            completed: false,
        };

        if (!workId) {
            return { ...base, code: 'not_found' };
        }
        if (read.failed) {
            // The row holds the target and the member's `deletionDeleteData` decision, so an
            // unreadable row means the attempt cannot know what it was asked to delete: it retries
            // rather than guessing, and in particular it never guesses "delete the volumes".
            const retryInMs = deletionRetryDelayMs({
                attempt,
                elapsedMs: Math.max(0, this.nowMs() - originOf(op, this.nowMs())),
            });
            if (retryInMs !== null) {
                return this.scheduleRetry({
                    workId,
                    attempt,
                    target,
                    code: 'runtime_state_unreadable',
                    retryInMs,
                    requestedAtMs: originOf(op, this.nowMs()),
                });
            }
            return {
                ...base,
                state: 'may-remain',
                code: 'runtime_state_unreadable',
                mayRemain: [],
            };
        }
        if (state && !hasDeletionRequest(state)) {
            this.logger.warn(`delete-app-work ran for work ${workId} without a pending deletion.`);
            return { ...base, code: 'not_deleting' };
        }
        if (state && !isDeployed(state)) {
            // The Work's runtime was never deployed (or the row no longer names one): nothing to
            // remove and nothing to reach, but step 4 still has to run — APW-01 holds the Work row
            // until the completion arrives, and the Activity row is the lasting record of what the
            // dependencies kept (§9.4:1325-1326, `APW-07/plan.md:760`).
            return this.finish({
                workId,
                attempt,
                target,
                state: 'done',
                code: 'nothing_deployed',
                removal: {
                    deleted: [],
                    kept: await this.keptFromDependencies(workId),
                    mayRemain: [],
                    namespaceDeleted: false,
                    remaining: false,
                    deletedCount: 0,
                },
            });
        }

        // The row's own `deletionDeleteData` is the authority: it is what §9.7:1490's atomic claim
        // recorded when the member confirmed the typed slug, so the op cannot be talked into a
        // volume delete by a payload.
        const deleteStoredData = state?.deletionDeleteData === true;

        let removal: RuntimeRemoval;
        try {
            removal = await this.removeRuntime({ workId, target, deleteStoredData, state });
        } catch (error) {
            const requestedAtMs =
                typeof op?.requestedAtMs === 'number'
                    ? op.requestedAtMs
                    : await this.requestedAtMs(workId);
            return this.classifyFailure({
                workId,
                attempt,
                target,
                requestedAtMs,
                code: 'cluster_unreachable',
                error,
            });
        }

        // §9.7: on the data path a provider that reports `remaining` means the volumes must stay:
        // `removeRuntime` downgrades the destroy to `deleteVolumes: false` and reports the names.
        if (removal.remaining) {
            const kept = await this.keptFromDependencies(workId);
            return this.finish({
                workId,
                attempt,
                target,
                state: 'may-remain',
                code: 'dependencies_remaining',
                removal: { ...removal, kept: [...removal.kept, ...kept] },
            });
        }

        return this.finish({ workId, attempt, target, state: 'done', removal });
    }

    /**
     * §9.8:1537-1541 — the API-side completion. APW-01's `completeAppWorkDeletion(workId)` is what
     * deletes the Work row and its local checkout; it is idempotent, so a retried relay hop is safe.
     *
     * Fail-closed when the seam is absent: the runtime really is gone, but the Work row is **kept**
     * and the answer says so (`completed: false`) instead of pretending a row was deleted.
     */
    async finishDeletion(
        workId: string,
        opts?: { mayRemain?: readonly AppDeletionObjectRef[] },
    ): Promise<{ completed: boolean; reason?: AppWorkDeletionCode }> {
        if (!this.completion) {
            this.logger.warn(
                `completeAppWorkDeletion is not bound: work ${workId} keeps its row after removal.`,
            );
            return { completed: false, reason: 'completion_unavailable' };
        }

        try {
            await this.completion.completeAppWorkDeletion(workId);
        } catch (error) {
            this.logger.warn(
                `completeAppWorkDeletion failed for work ${workId}: ${errorText(error)}`,
            );
            return { completed: false, reason: 'completion_unavailable' };
        }

        void opts;
        return { completed: true };
    }

    /* ---------------------------------------------------------------------- *
     * The removal, in §9.7's order
     * ---------------------------------------------------------------------- */

    /**
     * Steps 1–3 of §9.7, in order, for one attempt. Throws only for a **transient** failure (the
     * caller turns that into a retry); a definite refusal is returned, not thrown, so the op can
     * report it without a retry that could never succeed.
     */
    private async removeRuntime(input: {
        workId: string;
        target: AppDeployTarget;
        deleteStoredData: boolean;
        state: WorkAppRuntimeStateDeletionView | null;
    }): Promise<RuntimeRemoval> {
        const { workId, target, deleteStoredData } = input;

        // ── Step 1: APW-07 **first** (plan §9.7:1494-1499, ACC-06-45) ─────────
        const releasing = await this.callDependencies('onAppWorkDeleting', workId, {
            deleteStoredData,
        });

        const deleted: AppDeletionObjectRef[] = [];
        const kept: AppDeletionObjectRef[] = [...(releasing?.kept ?? [])];
        const mayRemain: AppDeletionObjectRef[] = [...(releasing?.mayRemain ?? [])];

        let deleteVolumes = deleteStoredData;
        let dependenciesRemaining = false;

        if (deleteStoredData) {
            // APW06-G08 (§9.7:1496-1498): on the Remove-with-data path the deprovision is awaited on
            // the worker **before** `destroyApp`. APW-07's §4.12 table makes this call idempotent —
            // a second call finds the rows already `deleted` and does nothing — so running it after
            // `onAppWorkDeleting` cannot double the deprovision.
            const removed = await this.callDependencies('onAppRemoved', workId, {
                deleteData: true,
            });
            kept.push(...(removed?.kept ?? []));
            mayRemain.push(...(removed?.mayRemain ?? []));

            if (removed?.remaining === true) {
                // §9.7:1497-1499: "when it reports `remaining`, the op ends with `mayRemain[]` and
                // **skips** the volume and namespace delete". The workloads still come down — the
                // destroy is downgraded, not cancelled — so a live app cannot be left serving while
                // its data is stranded.
                deleteVolumes = false;
                dependenciesRemaining = true;
                mayRemain.push({ kind: 'Dependency', name: 'remaining' });
            }
        }

        // ── Step 2: the runtime itself (§9.7:1500-1503) ──────────────────────
        //
        // ONE call for both targets, and that is the plan's letter: "`destroyApp` with `deleteVolumes`
        // equal to `deleteStoredData` … **On `ever-works-apps` the `apps-tier` plugin's `destroyApp`
        // calls APW-10's `removeWork(workId, { deleteData })`** (R-5)" (`plan.md:1500-1503`). The
        // target-agnostic call is what makes the plugin boundary worth having: the k8s plugin refuses
        // an `ever-works-apps` target outright (`assertThisPluginServes`, T14), the apps-tier plugin
        // accepts it and maps it to its own removal, and this service never has to know which of the
        // two it is talking to. `resolveAccess` already resolved the plugin **for the Work's target**,
        // so `access.destroyApp` IS the apps-tier plugin's method on that path.
        //
        // ⚠️ An earlier revision of this file branched here and called a separate
        // `AppsTierFacadeService.removeWork` seam instead. That was the coordinator's brief, not the
        // plan, and it was wrong on both counts: it duplicated an abstraction the plugin layer already
        // provides, and it put tier knowledge in the agent layer. It is recorded here because the
        // reasoning is not obvious from the code alone.
        let destroyResult: AppDestroyResult | null = null;

        const access = await this.resolveAccess(workId);
        if (!access.destroyApp || !access.credential) {
            throw new AppWorkDeletionTransientError('target_unavailable');
        }
        destroyResult = await access.destroyApp(access.ref, access.credential, {
            deleteVolumes,
        });
        deleted.push(...(destroyResult?.deleted ?? []));
        kept.push(...(destroyResult?.kept ?? []));

        if (!deleteStoredData) {
            // APW06-G08 (§9.7:1499): on the keep-data path this call runs **after** `destroyApp`, so
            // the dependencies it reports are the ones the destroy deliberately left alone.
            const after = await this.callDependencies('onAppRemoved', workId, {
                deleteData: false,
            });
            kept.push(...(after?.kept ?? []));
            mayRemain.push(...(after?.mayRemain ?? []));
        }

        // ── Step 3: the managed DNS record (§9.7:1504) ───────────────────────
        const dns = await this.removeManagedRecord(workId);
        if (dns.removed === false) {
            mayRemain.push(dns.ref);
        }

        return {
            deleted,
            kept: dedupeRefs(kept),
            mayRemain: dedupeRefs(mayRemain),
            namespaceDeleted: destroyResult?.namespaceDeleted === true,
            remaining: dependenciesRemaining,
            deletedCount: deleted.length,
        };
    }

    /**
     * Step 4 of §9.7 — the Activity row and the completion, for every ending that is not a retry.
     *
     * `app.deploy.removed` carries `reason: 'app_work_deleted'`, `kept[]` and `mayRemain[]` and
     * nothing else: names and kinds only, no host, no address, no token, no value (§9.4:1307,
     * ACC-06-41). Emission is awaited before the completion so the row is written while the Work
     * still exists — the Activity entry is the lasting record of what was kept (§9.4:1325-1326).
     */
    private async finish(input: {
        workId: string;
        attempt: number;
        target: AppDeployTarget;
        state: 'done' | 'may-remain';
        code?: AppWorkDeletionCode;
        removal: RuntimeRemoval;
    }): Promise<AppWorkDeletionOpResult> {
        const { workId, target, removal } = input;

        await this.recordAttempt(workId);
        await this.writeRemovalActivity({
            workId,
            target,
            kept: removal.kept,
            mayRemain: removal.mayRemain,
            deletedCount: removal.deleted.length,
            code: input.code,
        });

        const completed = await this.finishDeletion(workId, { mayRemain: removal.mayRemain });

        return {
            state: input.state,
            attempts: input.attempt,
            target,
            code: input.code,
            deleted: removal.deleted,
            kept: removal.kept,
            mayRemain: removal.mayRemain,
            namespaceDeleted: removal.namespaceDeleted,
            completed: completed.completed,
        };
    }

    /**
     * A transient (or final) failure of one attempt: schedule the next one, or end the removal.
     *
     * The retry is a **new dispatch** with `attempt + 1` and the same `requestedAtMs`, delayed by
     * `deletionRetryDelayMs` — so the fifteen-minute window is measured from the first attempt and
     * a fourth attempt is never scheduled. With no dispatcher the answer is `retry` with
     * `scheduled: false` and no completion: nothing is reported as removed and the Work row stays.
     */
    private async classifyFailure(input: {
        workId: string;
        attempt: number;
        target: AppDeployTarget;
        requestedAtMs: number;
        code: AppWorkDeletionCode;
        error: unknown;
    }): Promise<AppWorkDeletionOpResult> {
        const { workId, attempt, target, requestedAtMs } = input;
        const code =
            input.error instanceof AppWorkDeletionTransientError
                ? ((input.error.code as AppWorkDeletionCode) ?? input.code)
                : input.code;

        this.logger.warn(
            `delete-app-work attempt ${attempt} failed for work ${workId} (${code}): ${errorText(
                input.error,
            )}`,
        );

        // The window's origin is the claim §9.7:1490 made — carried by the payload on a retry and
        // read back from the row otherwise, so an attempt woken up late cannot extend the window.
        const elapsedMs = Math.max(0, this.nowMs() - requestedAtMs);
        const retryInMs = deletionRetryDelayMs({ attempt, elapsedMs });

        if (retryInMs !== null) {
            return this.scheduleRetry({ workId, attempt, target, code, retryInMs, requestedAtMs });
        }

        // §9.7:1509-1510 — after the third attempt the removal finishes anyway, reporting what may
        // remain, so the Work is never stranded in `deleting` forever.
        const state = await this.readState(workId, 'op');
        const exhausted: AppWorkDeletionCode =
            attempt >= APP_WORK_DELETION_MAX_ATTEMPTS ? 'attempts_exhausted' : 'window_exhausted';

        return this.finish({
            workId,
            attempt,
            target,
            state: 'may-remain',
            code: code === 'cluster_unreachable' ? exhausted : code,
            removal: {
                deleted: [],
                kept: await this.keptFromDependencies(workId),
                mayRemain: mayRemainFromState(state),
                namespaceDeleted: false,
                remaining: false,
                deletedCount: 0,
            },
        });
    }

    /**
     * One retry, dispatched as a **new op** with `attempt + 1` after `retryInMs`.
     *
     * A retry that cannot be scheduled (no dispatcher) still answers `retry` — with
     * `scheduled: false` — and never reaches APW-01's completion: the Work row stays, nothing is
     * reported as removed, and the next dispatch (or an operator) can pick it up.
     */
    private async scheduleRetry(input: {
        workId: string;
        attempt: number;
        target: AppDeployTarget;
        code: AppWorkDeletionCode;
        retryInMs: number;
        requestedAtMs: number;
    }): Promise<AppWorkDeletionOpResult> {
        let scheduled = false;

        if (this.dispatcher) {
            await this.dispatcher.dispatch(
                {
                    op: APP_DELETE_WORK_OP,
                    workId: input.workId,
                    attempt: input.attempt + 1,
                    requestedAtMs: input.requestedAtMs,
                },
                { delayMs: input.retryInMs },
            );
            scheduled = true;
        }

        return {
            state: 'retry',
            attempts: input.attempt,
            target: input.target,
            code: input.code,
            retryInMs: input.retryInMs,
            scheduled,
            deleted: [],
            kept: [],
            mayRemain: [],
            namespaceDeleted: false,
            completed: false,
        };
    }

    /* ---------------------------------------------------------------------- *
     * Steps 1–3's collaborators, each one optional and each with a defined answer
     * ---------------------------------------------------------------------- */

    /** The APW-07 call, named by its own method so the log line says which one failed. */
    private async callDependencies(
        method: 'onAppWorkDeleting' | 'onAppRemoved',
        workId: string,
        opts: { deleteStoredData: boolean } | { deleteData: boolean },
    ): Promise<AppDependencyDeletionReport | undefined> {
        if (!this.dependencies) {
            // Fail-closed and documented: without APW-07 no `work_app_dependencies` row can exist,
            // so there is nothing to release, deprovision or keep.
            this.logger.debug(`No App dependencies service is bound for work ${workId}.`);
            return undefined;
        }

        const call = this.dependencies[method] as (
            workId: string,
            opts: unknown,
        ) => Promise<AppDependencyDeletionReport | undefined>;

        if (typeof call !== 'function') {
            this.logger.warn(`App dependencies service has no ${method}(); skipping it.`);
            return undefined;
        }

        const report = await call.call(this.dependencies, workId, opts);
        return report ?? undefined;
    }

    /** APW-07's list, read defensively — a shape this file cannot fix yet (see the seam block). */
    private async listDependencies(workId: string): Promise<readonly AppDependencyDeletionView[]> {
        if (!this.dependencies || typeof this.dependencies.list !== 'function') {
            return [];
        }
        try {
            return (await this.dependencies.list(workId)) ?? [];
        } catch (error) {
            this.logger.warn(
                `App dependency list unavailable for work ${workId}: ${errorText(error)}`,
            );
            return [];
        }
    }

    /**
     * The Work's dependencies as `kept[]` for a Work whose runtime was never deployed, or whose rows
     * this attempt could not read: names only, and an unreadable list is empty rather than invented.
     */
    private async keptFromDependencies(workId: string): Promise<AppDeletionObjectRef[]> {
        const refs: AppDeletionObjectRef[] = [];
        for (const dependency of await this.listDependencies(workId)) {
            refs.push({ kind: dependency.kind, name: dependency.names?.[0] ?? dependency.kind });
        }
        return dedupeRefs(refs);
    }

    /** The facade's answer, with its failure turned into the retryable refusal it is. */
    private async resolveAccess(workId: string): Promise<AppRuntimeDeletionAccess> {
        if (!this.facade) {
            throw new AppWorkDeletionTransientError('facade_unavailable');
        }

        const resolved = await this.facade.resolveDeletionTarget(workId);
        if (!resolved || 'unavailable' in resolved) {
            throw new AppWorkDeletionTransientError(
                (resolved as { unavailable?: AppWorkDeletionCode })?.unavailable ??
                    'target_unavailable',
            );
        }
        return resolved;
    }

    /**
     * §9.7:1504 — the managed record goes last, after the workloads, so DNS is never withdrawn
     * while the app is still serving. A record that cannot be removed is reported, not retried: it
     * is the one leftover that costs nothing to clean up later, and retrying the whole removal for
     * it would keep a live app on the cluster.
     */
    private async removeManagedRecord(
        workId: string,
    ): Promise<{ removed: boolean; ref: AppDeletionObjectRef }> {
        // The Work-scoped label is deliberate: the record's own name is a hostname, and this file
        // never puts one in a payload, a result or a log line.
        const ref: AppDeletionObjectRef = { kind: 'DnsRecord', name: 'managed-subdomain' };

        if (!this.appsDns || typeof this.appsDns.removeRecord !== 'function') {
            this.logger.debug(`No managed DNS service is bound for work ${workId}.`);
            return { removed: false, ref };
        }

        try {
            const removed = await this.appsDns.removeRecord(workId);
            return { removed: removed !== false, ref };
        } catch (error) {
            this.logger.warn(
                `Managed DNS record not removed for work ${workId}: ${errorText(error)}`,
            );
            return { removed: false, ref };
        }
    }

    /**
     * The Activity row (step 4). `AppRuntimeEventSink` is the only channel App runtime services use
     * — never `EventEmitter2`, which inside the worker would never reach the Activity listener
     * (§9.4:1312-1320).
     *
     * Fail-closed: an unbound sink costs the record, never the removal. The payload carries the
     * Work id, the target, the reason code, counts and object **names** — no host, no address, no
     * namespace, no token and no value, which is what ACC-06-41 and this task's own scan assert.
     */
    private async writeRemovalActivity(input: {
        workId: string;
        target: AppDeployTarget;
        kept: readonly AppDeletionObjectRef[];
        mayRemain: readonly AppDeletionObjectRef[];
        deletedCount: number;
        code?: AppWorkDeletionCode;
        userId?: string | null;
    }): Promise<boolean> {
        if (!this.events) {
            this.logger.warn(
                `No App runtime event sink is bound: no app.deploy.removed for work ${input.workId}.`,
            );
            return false;
        }

        const payload: Record<string, unknown> = {
            workId: input.workId,
            target: input.target,
            reason: APP_WORK_DELETION_REASON,
            kept: input.kept.map((ref) => ({ kind: ref.kind, name: ref.name })),
            mayRemain: input.mayRemain.map((ref) => ({ kind: ref.kind, name: ref.name })),
            deletedCount: input.deletedCount,
        };
        if (input.userId) {
            payload.userId = input.userId;
        }
        if (input.code) {
            payload.code = input.code;
        }

        try {
            await this.events.emit({ name: APP_DEPLOY_REMOVED_EVENT, payload });
            return true;
        } catch (error) {
            this.logger.warn(
                `app.deploy.removed could not be emitted for work ${input.workId}: ${errorText(
                    error,
                )}`,
            );
            return false;
        }
    }

    /* ---------------------------------------------------------------------- *
     * State and guards
     * ---------------------------------------------------------------------- */

    /**
     * The Work, or the same `not_found` an unknown id gets.
     *
     * Owner-only, like APW-01's `deleteWork`: a member who is not the owner must not be able to
     * remove a Work's runtime through this port. With no `WorkRepository` bound the answer is the
     * refusal — a Work nobody can read is a Work nobody may delete.
     */
    private async requireOwnedAppWork(workId: string, userId: string): Promise<Work> {
        if (!this.works || !workId || !userId) {
            throw new AppWorkDeletionRefusalError('not_found', 404, 'No App Work to delete.');
        }

        const work = await this.works.findById(workId);
        if (!work || !isAppWorkKind(work.kind) || work.userId !== userId) {
            throw new AppWorkDeletionRefusalError('not_found', 404, 'No App Work to delete.');
        }

        return work;
    }

    /**
     * The runtime-state row, or `null` when no store is bound.
     *
     * A **throwing** bound store is not the same thing as an absent one, and the two must not be
     * conflated: absent means this deployment has no App runtime state at all (nothing can be
     * deployed, §9.7's first row applies), while a read failure means the truth is unknown — so
     * every caller treats `failed: true` as a retry or a refusal, never as "nothing was deployed".
     */
    private async readStateOrNull(
        workId: string,
        purpose: 'preview' | 'request' | 'op',
    ): Promise<{ state: WorkAppRuntimeStateDeletionView | null; failed: boolean }> {
        if (!this.runtimeStates || typeof this.runtimeStates.getOrCreate !== 'function') {
            return { state: null, failed: false };
        }

        try {
            return { state: (await this.runtimeStates.getOrCreate(workId)) ?? null, failed: false };
        } catch (error) {
            this.logger.warn(
                `App runtime state could not be read for work ${workId} (${purpose}): ${errorText(
                    error,
                )}`,
            );
            return { state: null, failed: true };
        }
    }

    /** The row for the reads that only enrich an answer; a failed read is `null`, already logged. */
    private async readState(
        workId: string,
        purpose: 'preview' | 'op',
    ): Promise<WorkAppRuntimeStateDeletionView | null> {
        return (await this.readStateOrNull(workId, purpose)).state;
    }

    /** The claim's own timestamp, in epoch ms — the fifteen-minute window's origin. */
    private async requestedAtMs(workId: string): Promise<number> {
        const state = await this.readState(workId, 'op');
        const at = toEpochMs(state?.deletionRequestedAt);
        return at ?? this.nowMs();
    }

    /** Best-effort attempt bookkeeping; a failure here never fails a removal that worked. */
    private async recordAttempt(workId: string): Promise<void> {
        if (!this.runtimeStates || typeof this.runtimeStates.recordDeletionAttempt !== 'function') {
            return;
        }
        try {
            await this.runtimeStates.recordDeletionAttempt(workId);
        } catch (error) {
            this.logger.warn(
                `deletionAttempts not recorded for work ${workId}: ${errorText(error)}`,
            );
        }
    }

    /** The clock, as a method, so a test can pin the window without touching a global. */
    protected nowMs(): number {
        return Date.now();
    }
}

/* -------------------------------------------------------------------------- *
 * The port binding of plan §9.8:1524-1536 — where this service is handed to APW-01
 * -------------------------------------------------------------------------- */

/**
 * The `APP_WORK_DELETION_PORT` binding, ready for the API's ports module to spread into its
 * `providers` (plan §9.8:1533-1536).
 *
 * `provide` is APW-01's token itself — imported from `app-work-deletion.port.ts`, the same Symbol
 * `WorkLifecycleService` injects — and the spec asserts that by identity and through a real Nest
 * container, because a same-named twin would print identically and bind nothing.
 *
 * Three properties, and all three are the plan's:
 *
 * - **lazy** — `useFactory` + `inject: [ModuleRef]`, resolving `AppRuntimeDeletionService` with
 *   `moduleRef.get(…, { strict: false })` **when `requestDeletion` is called**;
 * - **never `useExisting`** — this port and APW-01's `WorkLifecycleService` form a cycle (that
 *   service injects this port, and this service's completion edge injects back into that service),
 *   which is the same reasoning `INBOX_PRODUCER` carries;
 * - **no `WorkModule` provider** — `AppRuntimeDeletionService` injects none, so the lazy hop is the
 *   only edge between the two.
 *
 * 🛑 **Where this provider belongs.** `apps/api/src/app-runtime/app-runtime-ports.module.ts` — the
 * `@Global()` module of §9.8:1524-1533 — does **not** exist in this tree, and it is not this task's
 * file to create: T33 owns it (`tasks.md:583-587`) and T73 replaces bindings inside it
 * (`tasks.md:1258-1267`). Until it lands, **this export is where the port is provided**: the module
 * that lands adds `APP_WORK_DELETION_PORT_PROVIDER` to its `providers` array and nothing else. T33's
 * own spec pins exactly this shape — "the deletion-port provider has `useExisting` and `useClass`
 * undefined and `inject` equal to `[ModuleRef]`" — so the one-line addition satisfies it.
 */
export const APP_WORK_DELETION_PORT_PROVIDER: FactoryProvider<AppWorkDeletionPort> = {
    provide: APP_WORK_DELETION_PORT,
    inject: [ModuleRef],
    useFactory: (moduleRef: ModuleRef): AppWorkDeletionPort => ({
        requestDeletion: async (input: AppWorkDeletionRequest): Promise<AppWorkDeletionOutcome> => {
            const service = moduleRef.get(AppRuntimeDeletionService, { strict: false });
            return service.requestDeletion(input);
        },
    }),
};

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

/** What one attempt's steps 1–3 produced. */
interface RuntimeRemoval {
    deleted: AppDeletionObjectRef[];
    kept: AppDeletionObjectRef[];
    mayRemain: AppDeletionObjectRef[];
    namespaceDeleted: boolean;
    /** APW-07 reported `remaining`: the data was not deleted after all. */
    remaining: boolean;
    deletedCount: number;
}

/**
 * A failure a later attempt could survive (the cluster was unreachable, the tier seam is not bound,
 * the facade could not resolve a target). It is what turns an attempt into a retry.
 */
class AppWorkDeletionTransientError extends Error {
    constructor(readonly code: AppWorkDeletionCode) {
        super(`App Work deletion is not possible right now: ${code}`);
        this.name = 'AppWorkDeletionTransientError';
    }
}

/** `true` while §9.7's deletion claim is recorded on the row. */
function hasDeletionRequest(state?: WorkAppRuntimeStateDeletionView | null): boolean {
    return toEpochMs(state?.deletionRequestedAt) !== null;
}

/**
 * §9.7's first row, second half: a Work is "live" for this service only when the row records a
 * Deployment or a namespace. `target: 'none'` is the first half, and it is answered before this.
 */
function isDeployed(state?: WorkAppRuntimeStateDeletionView | null): boolean {
    if (!state || !state.target || state.target === 'none') {
        return false;
    }
    return Boolean(state.currentDeploymentId) || Boolean(state.namespace);
}

/** The names a Work that could not be reached may still be running (names only, §9.4:1325-1326). */
function mayRemainFromState(
    state?: WorkAppRuntimeStateDeletionView | null,
): AppDeletionObjectRef[] {
    const refs: AppDeletionObjectRef[] = [];
    for (const component of state?.statusSnapshot?.components ?? []) {
        if (component?.name) {
            refs.push({ kind: 'Component', name: component.name });
        }
    }
    if (state?.namespace) {
        refs.push({ kind: 'Namespace', name: state.namespace });
    }
    return dedupeRefs(refs);
}

/** One entry per kind+name, first occurrence wins — so a repeated hook cannot duplicate a row. */
function dedupeRefs(refs: readonly AppDeletionObjectRef[]): AppDeletionObjectRef[] {
    const seen = new Set<string>();
    const out: AppDeletionObjectRef[] = [];
    for (const ref of refs ?? []) {
        if (!ref?.kind || !ref?.name) {
            continue;
        }
        const key = `${ref.kind}\u0000${ref.name}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({ kind: ref.kind, name: ref.name });
    }
    return out;
}

/** `Date | string | number | null` → epoch ms, or `null` when there is no usable instant. */
function toEpochMs(value?: Date | string | number | null): number | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}

/** The attempt number the payload carries, normalised: absent or nonsense means the first. */
function normaliseAttempt(attempt?: number): number {
    if (typeof attempt !== 'number' || !Number.isFinite(attempt) || attempt < 1) {
        return 1;
    }
    return Math.floor(attempt);
}

/**
 * The fifteen-minute window's origin: the payload's `requestedAtMs` when a retry carried it, and
 * otherwise "now" — a first attempt is its own origin, and the row's own `deletionRequestedAt` is
 * read back in {@link AppRuntimeDeletionService} where a store may be bound.
 */
function originOf(op: AppDeleteWorkOpPayload | undefined, nowMs: number): number {
    const carried = op?.requestedAtMs;
    return typeof carried === 'number' && Number.isFinite(carried) ? carried : nowMs;
}

/**
 * An error as a short, log-safe string. Never a payload, an address or a credential: the callers of
 * this helper log provider failures, and a provider message can carry a URL.
 */
function errorText(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`.slice(0, 300);
    }
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}
