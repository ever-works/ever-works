/**
 * APW-06 T24 — the **deploy request service**: everything that happens between a Deploy button and
 * the `app-deploy` job existing.
 *
 * Spec: `APW-06-app-runtime/spec.md` FR-23 (`spec.md:357-361`, the six sources and "The request
 * answers within 2 seconds and never waits for the cluster"), FR-24 (`:362-367`, preconditions
 * "checked on request and again when work starts"), FR-30 (`:390-391`, "One Deployment runs per App
 * Work. A manual request during a run is refused. A Build-triggered request is queued; at most 1 is
 * queued and a newer one replaces it (the replaced record reads **Skipped**)"), FR-34
 * (`:401-406`, manual rollback "skips pre-deploy jobs by default"), S26 (`:192-194`), S29
 * (`:199-201`, cluster-change confirmation). Plan: **§2.2** (`plan.md:146-163`, the six-step request
 * flow, including "The dispatch is checked **before** the lock claim: when no dispatcher is
 * available (§9.2) the request returns `422 worker_not_isolated` and no row is created"), **§5.8**
 * (`plan.md:866-899`, Deployments without a Build — the `image` strategy, its 400, its queue), §9.2
 * (`plan.md:1253-1270`, the dispatchers view, the arity pin, "No in-process fallback for App runtime
 * work"), §5.6 step 7 (`plan.md:829-830`, the dequeue), §7.1 (`plan.md:1028-1040`, the columns the
 * row carries). Task text: `tasks.md:420-438` (T24) **and `tasks.md:1153-1160` (T24/T25, APW06-G16)**
 * — the paragraph that fixes the queue's transaction, the dedupe and which triggers are refused.
 * Acceptance: **ACC-06-21**, **ACC-06-23**, **ACC-06-55**, ACC-06-19/-20/-52/-53.
 *
 * ## The order, and why it is the order
 *
 * ```
 * 1 · isolated-worker gate        worker_not_isolated            422 · no read, no row   (§9.2:1261-1270)
 * 2 · preconditions (T21)         APP_DEPLOY_PRECONDITIONS       422 · no row            (FR-24, §5.1)
 * 3 · `buildId` vs the strategy   build_not_applicable           400 · no row            (§2.2:158, §5.8)
 * 4 · deletion re-check           app_work_deleting              422 · no row            (R-15, §9.7)
 * 5 · atomic lock claim           APP_DEPLOY_IN_PROGRESS         409 · no row            (§2.2:152-155)
 * 6 · queue (build/domain-change) latest-wins, SUPERSEDED        202 · one row           (FR-30, §1153-1160)
 * 7 · create + dispatch           { deploymentId }               202 · one row           (§2.2:156-159)
 * ```
 *
 * Four properties of that order are load-bearing rather than tidy:
 *
 * - **Nothing is read or written before the gate.** §9.2's rule is that App cluster work has no
 *   in-process fallback: an API process that created a row and then discovered it could not dispatch
 *   would strand that row holding the lock for
 *   {@link APP_DEPLOY_LOCK_STALE_S} (7 260 s). So the gate is answered from the injected seam alone
 *   — zero state reads, zero rows, zero cache entries (ACC-06-55).
 * - **The preconditions run before the row, and the strategy check after them.** The strategy lives
 *   *in* the App spec, and reading that spec is the precondition pass's step 3 (`§5.1`'s
 *   `spec_invalid`): an invalid spec is a 422 naming the spec, never a 400 about a Build.
 * - **The lock is claimed before the row is created.** §2.2 numbers it that way (3 then 4), and the
 *   id is the same one in both — `deployLockId = :id` *is* the Deployment's id — which is why this
 *   service mints the id (`randomUUID`) instead of letting the insert do it. A manual request that
 *   loses the race therefore leaves **no** row at all.
 * - **A dispatch failure is not a silent success.** §9.2's dispatcher "propagates dispatch errors
 *   (the row would strand)". A dispatch that *rejects* inside the 2 s budget releases the lock and
 *   records the failure on the row; a dispatch still pending at the budget answers `202` with the
 *   warning {@link APP_DEPLOY_WARNING_DISPATCH_SLOW} and attaches a tail handler that does the same
 *   cleanup when it settles — so the request never waits for the cluster (FR-23) and the lock is
 *   never stranded by it either.
 *
 * ## The queue, exactly as APW06-G16 fixes it
 *
 * `tasks.md:1153-1160` is the normative paragraph, and this file implements it without adding a
 * second opinion:
 *
 * - a `build` or a `domain-change` request that finds the lock held **creates its row immediately**
 *   (`INITIALIZING`, UI **Queued**) and writes `queuedDeploymentId` + `queuedBuildId` **in one call**
 *   ({@link AppDeployRuntimeStateStore.setQueued}), which is what makes "at most 1 is queued" true
 *   even under two concurrent requests;
 * - the previously queued row is marked `SUPERSEDED` with `appRender.supersededBy` pointing at the
 *   new one — the row the UI reads as **Skipped** (FR-30);
 * - `manual`, `rollback` and `target-saved` are **refused with 409** while the lock is held;
 * - a request that repeats the identity of the row already queued (the same Build, or the same spec
 *   commit under `build.strategy: image`) is **idempotent**: it returns that row and creates nothing.
 *   That is what makes "three Build-triggered requests during one run leave two rows (one
 *   `SUPERSEDED`, one `INITIALIZING`)" true, and it is what keeps a redelivered webhook from
 *   churning the queue;
 * - under `build.strategy: image` (§5.8) the row carries `buildId: null` and the spec commit, and
 *   `queuedBuildId` stays `null` — a queued request "from the other strategy" is therefore a
 *   different identity, and it is superseded rather than deduped.
 *
 * ## What this service does not do
 *
 * It never calls a plugin, never dials a cluster, never reads a credential and never emits an event
 * (the Done-when line of `tasks.md:437-438`: "the service never calls the plugin"). It does not run
 * the Deployment either: it hands the id to the dispatcher and the `app-deploy` job (§5.6) owns
 * everything after that — including §5.6 step 7's dequeue, which adopts the queued row through one
 * compare-and-set.
 *
 * ## Provisional seams (each routed, none silent)
 *
 * - **The dispatcher** — `APP_DEPLOY_DISPATCHER` is owned by APW-06 T31 (`plan.md:1245`, the
 *   `app-deploy` row of §9.2's table, `packages/agent/src/tasks/app-deploy-dispatcher.ts`), which has
 *   not landed. This file declares the token and the two-member view it needs, exactly as T58 already
 *   declares `APP_CLUSTER_OP_DISPATCHER` for the op it asks for
 *   (`app-runtime-deletion.service.ts:477-504`). **When T31 lands, bind both this token and T21's
 *   `APP_DEPLOY_DISPATCHER_AVAILABILITY` (`app-deploy-preconditions.service.ts:275-293`) to the one
 *   `TriggerService` view** (`useExisting`), so the two gates cannot disagree about what "isolated"
 *   means.
 * - **The Deployment row** — `work_deployments` gains `buildId`, `appTarget`, `appTrigger` and
 *   `appRender` in T16 (`tasks.md:285-291`, `:1123-1125`; plan §7.1:1028-1037), and none of them
 *   exists on the entity at HEAD (`work-deployment.entity.ts:37-105`, five columns short). The store
 *   seam below is that gap and nothing more: the real binding is one provider line,
 *   `{ provide: APP_DEPLOY_DEPLOYMENT_STORE, useExisting: WorkDeploymentRepository }`, once the
 *   entity has the columns (its `create(input: Partial<WorkDeployment>)` already takes the id and the
 *   trigger columns — `work-deployment.repository.ts:13-19`).
 * - **The runtime-state row** — T17 (`tasks.md:293-321`) owns `WorkAppRuntimeState` and
 *   `WorkAppRuntimeStateRepository`. The **token is not declared here**: `app-launcher.service.ts:223`
 *   declares `WORK_APP_RUNTIME_STATES` and T21 and T58 already reuse it, so this file declares the
 *   wider *view* it needs of that same provider and reuses the one token (a second
 *   `Symbol('WORK_APP_RUNTIME_STATES')` would be a different token and would leave one consumer
 *   unbound). `claimDeployLock` / `setQueued` are T17's own names (`tasks.md:297-298`); T17's
 *   `claimDeployLock` already requires `paused = false` and `deletionRequestedAt IS NULL`, which is
 *   why this file's own deletion check is a second gate rather than the only one.
 * - **`provider`** — §2.2:156 writes `provider: plugin.id`, and this service may not resolve a plugin
 *   (the Done-when above) nor call T20's facade (every method of `AppRuntimeFacadeService` throws
 *   `APP_CLUSTER_IO_IN_API` outside the worker — `app-runtime.facade.ts:585` and the class-level rule
 *   at plan §6.2:943-949). The value therefore rides in on the request from the caller that already
 *   has the Work row (`DeployService` / T33, which resolved `work.deployProvider` for access and for
 *   the website path), and a caller that supplies none stores the empty string rather than inventing
 *   a plugin id — the column is `NOT NULL` (`work-deployment.entity.ts:47-48`) and an empty provider
 *   is a visible gap, not a wrong answer.
 * - **APW-01's deploy-route port** — `APP_DEPLOY_ROUTE_PORT` (`plan.md:1225-1230`, T34 binds it with
 *   `useExisting: AppDeployRequestService`) is not in this tree, so {@link
 *   AppDeployRequestService.requestDeploy} implements the one method that port declares
 *   (`requestDeploy({ workId, userId, buildId? })` → `{ status: 'pending'; deploymentId }`) and
 *   refuses through a typed {@link AppDeployRefusedError}, because the port's own happy-path shape
 *   cannot carry a 422/409. When APW-01's file lands, that throw is the only thing to re-shape.
 */

import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_DEPLOY_REQUEST_BUDGET_MS,
    type AppDeployTarget,
    type AppPrecondition,
} from '@ever-works/contracts';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import {
    AppDeployPreconditionsService,
    type AppDeployPreconditionResult,
    type AppDeployRuntimeState,
} from './app-deploy-preconditions.service';

/* -------------------------------------------------------------------------- *
 * Vocabulary this file adds
 * -------------------------------------------------------------------------- */

/**
 * The FR-23 sources, as `work_deployments.appTrigger` stores them.
 *
 * `triggerSource` is **not** widened here: it keeps its own two values (`manual` · `scheduled`,
 * `work-deployment.entity.ts:20-23`) and every App trigger is recorded as `manual` there, because
 * none of them is a schedule. The App-specific value lives in `appTrigger`, which is what T16 adds
 * for exactly this reason.
 *
 * **`spec-applied` — the sixth value, and the one place the plan and the task text disagree
 * (reported, R-26).** Plan §7.1:1036 lists five — "`manual` · `build` · `domain-change` ·
 * `rollback` · `target-saved` … so the FR-23 sources had nowhere to live" — while FR-23 itself
 * (`spec.md:357-360`) and T24's own task text (`tasks.md:422-424`, "manual vs Build-triggered vs
 * `spec-applied` vs domain-change vs rollback") both count a **sixth** source: §5.8:886-889's
 * "`app.spec.applied` on the deploy branch while the strategy is `image` … **Trigger name
 * `spec-applied`**". The plan's own list therefore enumerates FR-23's sources one short.
 *
 * The resolution is additive and narrows nothing: the five stored values keep their exact spelling
 * and order, `spec-applied` is appended, and the column (`varchar(24)`, plan §7.1:1036) holds it
 * unchanged. Dropping it would have meant a spec-applied redeploy being recorded as `manual` —
 * which is the one thing `appTrigger` exists to prevent.
 */
export type AppDeployTrigger =
    | 'manual'
    | 'build'
    | 'domain-change'
    | 'rollback'
    | 'target-saved'
    | 'spec-applied';

/** Every trigger: plan §7.1:1036's five in its own order, then the sixth it omits (see above). */
export const APP_DEPLOY_TRIGGERS: readonly AppDeployTrigger[] = [
    'manual',
    'build',
    'domain-change',
    'rollback',
    'target-saved',
    'spec-applied',
];

/**
 * The triggers `tasks.md:1157` queues — "`manual`, `rollback` and `target-saved` are refused with
 * 409 while the lock is held; `build` and `domain-change` are queued".
 *
 * `spec-applied` queues with them, and the reason is that paragraph's own logic rather than a
 * preference: it names exactly three refused triggers, and a `spec-applied` redeploy is
 * event-driven like `build` (FR-23's "a Build succeeding on the deploy branch" and §5.8's
 * "`app.spec.applied` … that changes what runs" are the same family — a change on the deploy branch
 * asks for a Deployment, and the newest one wins).
 */
export const APP_DEPLOY_QUEUEABLE_TRIGGERS: readonly AppDeployTrigger[] = [
    'build',
    'domain-change',
    'spec-applied',
];

/** T17's stale-lock window: the Deployment's 7 200 s maximum plus 60 (plan §7.2:1054). */
export const APP_DEPLOY_LOCK_STALE_S = 7_260;

/** The row state a fresh Deployment is created in — the column's own default (plan §2.2:156). */
export const APP_DEPLOY_STATE_INITIALIZING = 'INITIALIZING';

/** What a replaced queue entry reads: **Skipped** (FR-30, plan §7.1:1039). */
export const APP_DEPLOY_STATE_SUPERSEDED = 'SUPERSEDED';

/** The error-body code of §2.2 step 2 — `422 { code: 'APP_DEPLOY_PRECONDITIONS', unmet }`. */
export const APP_DEPLOY_CODE_PRECONDITIONS = 'APP_DEPLOY_PRECONDITIONS';

/** The error-body code of §2.2 step 3 — `409 { code: 'APP_DEPLOY_IN_PROGRESS', deploymentId }`. */
export const APP_DEPLOY_CODE_IN_PROGRESS = 'APP_DEPLOY_IN_PROGRESS';

/** §2.2:158 / §5.8: "sending `buildId` for that strategy returns `400 build_not_applicable`". */
export const APP_DEPLOY_CODE_BUILD_NOT_APPLICABLE = 'build_not_applicable';

/**
 * The refusal this service answers when the runtime-state store cannot be reached at all — the
 * platform-configuration case §5.1 keeps for `worker_not_isolated` and its siblings. It is **not**
 * an `AppPreconditionCode`: the union is closed in `@ever-works/contracts` (T1's
 * `APP_PRECONDITION_CODES`), and a wiring fault is not one of the owner's preconditions to meet.
 */
export const APP_DEPLOY_CODE_STATE_UNAVAILABLE = 'app_deploy_state_unavailable';

/** The `500`-class refusal a dispatch that threw leaves behind. */
export const APP_DEPLOY_CODE_DISPATCH_FAILED = 'dispatch_failed';

/** `202`-with-a-warning: the dispatcher had not answered when the 2 s budget elapsed (FR-23). */
export const APP_DEPLOY_WARNING_DISPATCH_SLOW = 'dispatch_slow';

/** The one identity a queue entry is deduped by: the Build, or the spec commit under `image`. */
export const APP_DEPLOY_QUEUE_BUILD_PREFIX = 'build:';
export const APP_DEPLOY_QUEUE_SPEC_PREFIX = 'spec:';

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T31/T32, the `app-deploy` dispatcher (plan §9.2's table)
 * -------------------------------------------------------------------------- */

/**
 * What `dispatchAppDeploy` is asked to run (§2.2:159, §9.2:1245). The payload is this file's reading
 * of the row the job will load; T31's `app-deploy.types.ts` owns the final one and the swap is the
 * import.
 */
export interface AppDeployDispatchPayload {
    workId: string;
    deploymentId: string;
    /** The FR-23 source, so the job can attribute what it is running. */
    trigger: AppDeployTrigger;
    /** `null` under `build.strategy: image`/`none` (§5.8). */
    buildId: string | null;
    /** The commit whose App spec this Deployment runs (ACC-06-20). */
    specCommitSha: string | null;
    /** The idempotency key this dispatch carries, when the caller supplied one. */
    requestId?: string | null;
}

/**
 * The `app-deploy` dispatcher, as this service uses it.
 *
 * Two shapes, one rule — the same pair T21's availability probe accepts
 * (`app-deploy-preconditions.service.ts:285-293`): when the provider exposes `resolve()`, **that** is
 * what must answer with a runtime carrying `dispatchAppDeploy` (`buildJobRuntimeProviders` returns
 * `null` when no provider is registered, `job-runtime.providers.ts:158-200`); otherwise the injected
 * object is the runtime itself. Anything else — unbound, `null`, `isEnabled() === false`, or a
 * resolved object without `dispatchAppDeploy` — means "no isolated worker", and the request is
 * refused before a row exists.
 */
export interface AppDeployDispatcher {
    dispatchAppDeploy(
        payload: AppDeployDispatchPayload,
        opts?: { delayMs?: number },
    ): Promise<string | null>;
    /** `false` ⇔ dispatch is off in this process (§9.2's second unavailability condition). */
    isEnabled?(): boolean;
    /** The active runtime, when the provider is a factory rather than the runtime itself. */
    resolve?(): unknown;
}

/** DI token for {@link AppDeployDispatcher} — owned by APW-06 T31/T32. */
export const APP_DEPLOY_DISPATCHER = Symbol('APP_DEPLOY_DISPATCHER');

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T16, the `work_deployments` row
 * -------------------------------------------------------------------------- */

/**
 * The row this service creates — the four columns T16 adds plus the ones the entity already has
 * (plan §7.1:1028-1037, §2.2:156-158).
 */
export interface AppDeployRowDraft {
    /** Minted here, so the lock this row holds and the row itself carry one id (§2.2 steps 3–4). */
    id: string;
    workId: string;
    state: string;
    /** §2.2:156's `plugin.id`, as the caller resolved it (the header's fourth seam). */
    provider: string;
    /** The existing column's two values only; the FR-23 source is `appTrigger`. */
    triggerSource: string;
    /** `manual` · `build` · `domain-change` · `rollback` · `target-saved` (plan §7.1:1036). */
    appTrigger: AppDeployTrigger;
    /** **Null under `build.strategy: image`** (§5.8). */
    buildId: string | null;
    appTarget: AppDeployTarget | null;
    /** The Build's commit, or under `image` the spec commit (§5.8). */
    commitSha: string | null;
    branch?: string | null;
    triggeredByUserId?: string | null;
    /**
     * The `simple-json` render facts the row starts with (§7.1:1037): the spec commit, whether
     * pre-deploy jobs are skipped, the manual-rollback facts, and — for a later supersede — the
     * `supersededBy` the store's own merge adds. No `phase` yet: `APP_DEPLOY_PHASES` has no
     * "queued" member, and the orchestrator writes the first real one when the run starts.
     */
    appRender: Record<string, unknown>;
}

/** The facts of an existing row a queue decision reads. */
export interface AppDeployRowFacts {
    id: string;
    state?: string | null;
    buildId?: string | null;
    commitSha?: string | null;
    appTrigger?: string | null;
}

/**
 * T16's `WorkDeploymentRepository`, as this service consumes it.
 *
 * Every member is optional except {@link create}: a store bound without {@link findById} simply
 * cannot dedupe (it supersedes instead, which is FR-30's own rule), and a store bound without
 * {@link markDispatchFailed} leaves a dispatch failure to the caller's log line.
 */
export interface AppDeployDeploymentStore {
    /** Inserts the row and answers the id it was given. */
    create(draft: AppDeployRowDraft): Promise<{ id: string }>;
    /** One existing row's queue-relevant facts. */
    findById?(deploymentId: string): Promise<AppDeployRowFacts | null>;
    /**
     * `tasks.md:1155`: marks the replaced row `SUPERSEDED` and sets `appRender.supersededBy` to the
     * newer Deployment's id, **merging** into `appRender` rather than replacing it.
     */
    markSuperseded?(deploymentId: string, supersededBy: string): Promise<void>;
    /** `tasks.md:1245`: "Propagates dispatch errors (the row would strand)" — this is the other half. */
    markDispatchFailed?(deploymentId: string, code: string, message: string): Promise<void>;
}

/** DI token for {@link AppDeployDeploymentStore} — bound to T16's `WorkDeploymentRepository`. */
export const APP_DEPLOY_DEPLOYMENT_STORE = Symbol('APP_DEPLOY_DEPLOYMENT_STORE');

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T17, the runtime-state row (token reused, never re-declared)
 * -------------------------------------------------------------------------- */

/** One `work_app_runtime_states` row as this service reads it (plan §7.2:1042-1074). */
export interface AppDeployRequestState extends AppDeployRuntimeState {
    /** The running Deployment, when the claim is refused — §2.2:154's `409 { deploymentId }`. */
    deployLockedAt?: Date | string | number | null;
    /** Latest-wins queue of 1 (plan §7.2:1056). */
    queuedDeploymentId?: string | null;
    queuedBuildId?: string | null;
}

/** What one queue write answers: which row, if any, it replaced. */
export interface AppDeployQueueWrite {
    queuedDeploymentId: string | null;
    queuedBuildId: string | null;
}

/** APW-06 T17's `WorkAppRuntimeStateRepository`, as this service consumes it. */
export interface AppDeployRuntimeStateStore {
    getOrCreate(workId: string): Promise<AppDeployRequestState | null>;
    /**
     * §2.2 step 3's atomic claim:
     * `UPDATE … SET "deployLockId" = :id WHERE "workId" = :w AND "deployLockId" IS NULL` (T17 also
     * requires `paused = false` and `deletionRequestedAt IS NULL`). `true` ⇒ this request owns the
     * dispatch.
     */
    claimDeployLock(workId: string, deploymentId: string, staleAfterS?: number): Promise<boolean>;
    /** Gives the lock back — the dispatch-failure path, and nothing else in this file. */
    releaseDeployLock(workId: string, deploymentId: string): Promise<boolean | void>;
    /**
     * `tasks.md:1154`: writes `queuedDeploymentId` and `queuedBuildId` **in the same transaction**
     * and answers the previously queued row's id, so the caller can mark it `SUPERSEDED`. One call
     * for both columns is what makes "at most 1 is queued" hold under two concurrent requests.
     */
    setQueued(
        workId: string,
        queued: AppDeployQueueWrite,
    ): Promise<{ supersededDeploymentId: string | null } | void>;
}

/* -------------------------------------------------------------------------- *
 * Request and result
 * -------------------------------------------------------------------------- */

/** A manual rollback's facts (FR-34, §5.8's rollback paragraph). */
export interface AppDeployRollbackFacts {
    /** The Live Deployment being rolled back to. */
    deploymentId: string;
    /** Its Build — `null` under `build.strategy: image` (FR-64). */
    buildId?: string | null;
    /** Its App spec commit; the request's commit when the caller supplies none. */
    specCommitSha?: string | null;
    /** Its recorded image reference and digest — the pair a rollback "never re-resolves" (§5.8). */
    imageReference?: string | null;
    imageDigest?: string | null;
}

/** What the caller knows when it asks for a Deployment. */
export interface AppDeployRequest {
    workId: string;
    /** Who asked. `null` for a Build-triggered request, which has no actor (plan §7.1:1036). */
    userId?: string | null;
    /** The FR-23 source; `manual` when the caller names none. */
    trigger?: AppDeployTrigger;
    /** The Build to deploy. Refused with `build_not_applicable` under `build.strategy: image`. */
    buildId?: string | null;
    /** §5.8: the commit an `image` Deployment runs its spec from. */
    specCommitSha?: string | null;
    /** S29's confirmation for a Deployment on a different cluster than the last check saw. */
    confirmClusterChange?: boolean;
    /** FR-34: the Deployment a manual **Roll back** returns to. */
    rollback?: AppDeployRollbackFacts | null;
    /** FR-34's `runPreDeployJobs`: `false` skips them, which is the rollback default. */
    runPreDeployJobs?: boolean;
    /** The deploy branch, when the caller knows it (recorded for the history row). */
    branch?: string | null;
    /** §2.2:156's `plugin.id` — see the header's fourth seam. */
    provider?: string | null;
    /** The Work's head commit on the deploy branch, which `no_green_build_for_head` compares against. */
    headCommitSha?: string | null;
    /** An idempotency key the dispatch carries (APW-05's build event id, an op `requestId`). */
    requestId?: string | null;
}

/** What the row will store, echoed so a caller needs no second read (§2.2:156-158, §7.1). */
export interface AppDeployStoredFacts {
    buildId: string | null;
    /** The commit the row names: the Build's, or under `image` the spec's (§5.8). */
    commitSha: string | null;
    specCommitSha: string | null;
    appTarget: AppDeployTarget | null;
    appTrigger: AppDeployTrigger;
    skipPreDeployJobs: boolean;
    provider: string;
    branch: string | null;
    /** The manual-rollback facts, when this request is one. */
    rollback: {
        rolledBackToDeploymentId: string;
        imageDigest: string | null;
    } | null;
}

/** What the caller gets. */
export interface AppDeployRequestResult {
    /**
     * `accepted` — a row exists and a dispatch was attempted (202);
     * `queued` — a row exists in the latest-wins queue (202);
     * `refused` — nothing was created (`httpStatus` says how to answer).
     */
    status: 'accepted' | 'queued' | 'refused';
    /** `202` · `400` · `409` · `422` · `500` · `503`. The route answers with this verbatim. */
    httpStatus: number;
    /** The error-body code: `APP_DEPLOY_PRECONDITIONS`, `APP_DEPLOY_IN_PROGRESS`, `build_not_applicable`, … */
    code: string | null;
    /** The row this request owns: created, queued or returned by the dedupe. `null` when refused. */
    deploymentId: string | null;
    /** The queue entry after this request, when it queued. */
    queuedDeploymentId: string | null;
    queuedBuildId: string | null;
    /** The Deployment holding the lock, for §2.2:154's `409 { deploymentId }`. */
    runningDeploymentId: string | null;
    /** The refusals, in T21's own shape — `422 { code: 'APP_DEPLOY_PRECONDITIONS', unmet }`. */
    unmet: AppPrecondition[];
    /** §5.1's non-refusing entries (`primary_domain_missing`) and T21's warnings, passed through. */
    advisory: AppPrecondition[];
    warnings: Array<{ code: string; message: string }>;
    /** `true` ⇔ the dispatcher answered inside the budget. */
    dispatched: boolean;
    /** `true` ⇔ this request found the same identity already queued and created nothing. */
    deduplicated: boolean;
    /** The row's facts — §2.2's `buildId`, `appTarget`, commit and the two flags. */
    stored: AppDeployStoredFacts;
}

/** Thrown by {@link AppDeployRequestService.requestDeploy} so a non-202 answer survives the port. */
export class AppDeployRefusedError extends Error {
    constructor(readonly result: AppDeployRequestResult) {
        super(
            `App Deployment refused (${String(result.code ?? result.httpStatus)}): ` +
                (result.unmet[0]?.message ?? 'see the result for the reason.'),
        );
        this.name = 'AppDeployRefusedError';
    }
}

/** The sentinel the 2 s budget rejects with, so a dispatch failure is never mistaken for it. */
const REQUEST_BUDGET_EXCEEDED = Symbol('APP_DEPLOY_REQUEST_BUDGET_EXCEEDED');

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * The request path of §2.2. Constructed in the API (where the route and `DeployService` call it) and
 * safe to construct anywhere: with no seam bound it refuses with a named code rather than pretending
 * to have queued something.
 */
@Injectable()
export class AppDeployRequestService {
    private readonly logger = new Logger(AppDeployRequestService.name);

    constructor(
        // Every collaborator is `@Optional()`, so a hand-rolled construction (this file's own spec, a
        // lean worker context) passes a prefix of them and the API's module graph compiles with
        // nothing bound at all. The order is the order the flow uses them in.
        @Optional()
        private readonly preconditions?: AppDeployPreconditionsService,
        @Optional()
        @Inject(APP_DEPLOY_DISPATCHER)
        private readonly dispatchers?: AppDeployDispatcher,
        @Optional()
        @Inject(APP_DEPLOY_DEPLOYMENT_STORE)
        private readonly deployments?: AppDeployDeploymentStore,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: AppDeployRuntimeStateStore,
    ) {}

    /**
     * Ask for a Deployment.
     *
     * Resolves for every answer a caller can render — including a refusal — because the two callers
     * (the API route and `DeployService.deploy()` for kind `app`) both map `httpStatus`/`code`
     * straight onto the response. A collaborator that throws is caught by the collaborator's own
     * contract (T21 never throws for an unmet precondition) or by this file's own guards; nothing
     * here 500s on a state the owner can act on.
     */
    async request(request: AppDeployRequest): Promise<AppDeployRequestResult> {
        const workId = String(request?.workId ?? '');
        const appTrigger = normaliseTrigger(request?.trigger);
        const skipPreDeployJobs = skipPreDeployJobsFor(request);

        // ---- 1 · the isolated-worker gate (§9.2, APW06-G02) ------------------
        // First, and final: "the request returns the precondition `worker_not_isolated` (422) and
        // creates no row" — and, in this service, reads nothing either.
        if (!this.isolatedDispatcher()) {
            this.logger.warn(
                `Refusing the App Deployment request for Work ${workId}: no isolated App cluster ` +
                    'worker is available in this process.',
            );
            return this.refused(422, 'worker_not_isolated', [
                {
                    code: 'worker_not_isolated',
                    message:
                        'No isolated worker is available to run App cluster work, so this ' +
                        'Deployment cannot be dispatched. Production requires an operator to ' +
                        'attest the App cluster worker; nothing was queued.',
                },
            ]);
        }

        // ---- 2 · the preconditions (§5.1, FR-24) -----------------------------
        const preconditions = await this.evaluate(request, workId);
        if (!preconditions) {
            return this.refused(503, APP_DEPLOY_CODE_STATE_UNAVAILABLE, [
                {
                    code: 'spec_invalid',
                    message:
                        'The Deploy preconditions cannot be evaluated in this process, so nothing ' +
                        'was queued.',
                },
            ]);
        }

        if (preconditions.unmet.length > 0) {
            return this.refused(
                422,
                APP_DEPLOY_CODE_PRECONDITIONS,
                preconditions.unmet,
                preconditions,
            );
        }

        // ---- 3 · the request's own validation (§2.2:158, §5.8) ---------------
        const buildId = request?.buildId ? String(request.buildId) : null;
        const strategy = preconditions.context.strategy;

        if (buildId && strategy === 'image') {
            // T22 emits the same code for the same contradiction (a Build named for a strategy that
            // produces none); the two must not drift, which is why the code is a shared constant.
            return this.refused(400, APP_DEPLOY_CODE_BUILD_NOT_APPLICABLE, [], preconditions, [
                {
                    code: APP_DEPLOY_CODE_BUILD_NOT_APPLICABLE,
                    message:
                        'This App Work publishes an image rather than building one, so a Build ' +
                        'cannot be deployed. Remove `buildId`; the App spec at the requested ' +
                        'commit is what runs.',
                },
            ]);
        }

        // ---- 4 · the deletion re-check (R-15, §9.7) --------------------------
        const state = await this.readState(workId);
        if (!state) {
            return this.refused(503, APP_DEPLOY_CODE_STATE_UNAVAILABLE, [], preconditions);
        }

        if (isSet(state.deletionRequestedAt)) {
            // T17's `claimDeployLock` refuses this too, but a request that reached here must be told
            // *why* rather than being told a Deployment is in progress.
            return this.refused(
                409,
                'app_work_deleting',
                [
                    {
                        code: 'app_work_deleting',
                        message:
                            'This App Work is being deleted, so no Deployment may start for it.',
                    },
                ],
                preconditions,
            );
        }

        // ---- 5 · the atomic lock claim (§2.2 step 3) -------------------------
        const deploymentId = this.newDeploymentId();
        const stored = storedFacts(request, preconditions, appTrigger, skipPreDeployJobs);
        const claim = await this.claim(workId, deploymentId);

        if (claim === 'unavailable') {
            // No lock store, or one that threw: without the claim there is no "one Deployment per
            // App Work" (FR-30), so nothing is created and the refusal names the platform, not the
            // owner's preconditions.
            return this.refused(503, APP_DEPLOY_CODE_STATE_UNAVAILABLE, [], preconditions);
        }

        if (claim === 'busy') {
            return this.contend(
                request,
                preconditions,
                stored,
                appTrigger,
                state,
                workId,
                deploymentId,
            );
        }

        // ---- 6 · the row, then the dispatch (§2.2 steps 4–5) -----------------
        const draft = rowDraft(deploymentId, workId, request, stored, appTrigger);
        const created = await this.createRow(draft);
        if (!created) {
            await this.releaseLock(workId, deploymentId);
            return this.refused(503, APP_DEPLOY_CODE_STATE_UNAVAILABLE, [], preconditions);
        }

        const dispatched = await this.dispatch(
            {
                workId,
                deploymentId,
                trigger: appTrigger,
                buildId: stored.buildId,
                specCommitSha: stored.specCommitSha,
                requestId: request?.requestId ?? null,
            },
            workId,
            deploymentId,
        );

        if (dispatched.error) {
            // The row exists and the lock is released: the owner sees a failed request, and the next
            // attempt is not blocked by a Deployment that never started.
            return {
                ...this.base(preconditions, stored),
                status: 'refused',
                httpStatus: 500,
                code: APP_DEPLOY_CODE_DISPATCH_FAILED,
                deploymentId,
                dispatched: false,
                warnings: [
                    ...this.warningsOf(preconditions),
                    { code: APP_DEPLOY_CODE_DISPATCH_FAILED, message: dispatched.error },
                ],
            };
        }

        return {
            ...this.base(preconditions, stored),
            status: 'accepted',
            httpStatus: 202,
            code: null,
            deploymentId,
            dispatched: dispatched.dispatched,
            warnings: [
                ...this.warningsOf(preconditions),
                ...(dispatched.dispatched
                    ? []
                    : [
                          {
                              code: APP_DEPLOY_WARNING_DISPATCH_SLOW,
                              message:
                                  'The App Deployment was recorded and the request answered ' +
                                  `within ${this.requestBudgetMs()} ms; the dispatch is still in ` +
                                  'flight. The Deploy tab shows the Deployment as it starts.',
                          },
                      ]),
            ],
        };
    }

    /**
     * APW-01's `APP_DEPLOY_ROUTE_PORT` shape (`plan.md:1225-1230`): `requestDeploy({ workId, userId,
     * buildId? })` → `{ status: 'pending'; deploymentId }`.
     *
     * The port declares the happy path only, so a refusal is thrown as {@link
     * AppDeployRefusedError} and the route answers from `result.httpStatus` / `result.code` — which
     * is the same mapping `POST :id/deploy` performs for its own callers.
     */
    async requestDeploy(input: {
        workId: string;
        userId?: string | null;
        buildId?: string | null;
        trigger?: AppDeployTrigger;
        provider?: string | null;
        requestId?: string | null;
    }): Promise<{ status: 'pending'; deploymentId: string }> {
        const result = await this.request({ ...input, trigger: input?.trigger ?? 'manual' });
        if (result.status === 'refused') throw new AppDeployRefusedError(result);

        return { status: 'pending', deploymentId: String(result.deploymentId ?? '') };
    }

    /* ---------------------------------------------------------------------- *
     * 1 · the isolated-worker gate
     * ---------------------------------------------------------------------- */

    /** `true` ⇔ the injected provider answers with a runtime that can dispatch App work. */
    protected isolatedDispatcher(): AppDeployDispatcher | null {
        const provider = this.dispatchers;
        if (!provider) return null;

        try {
            if (typeof provider.isEnabled === 'function' && provider.isEnabled() === false)
                return null;

            const resolved = typeof provider.resolve === 'function' ? provider.resolve() : provider;
            if (!resolved) return null;

            return typeof (resolved as { dispatchAppDeploy?: unknown }).dispatchAppDeploy ===
                'function'
                ? (resolved as AppDeployDispatcher)
                : null;
        } catch (error) {
            this.logger.warn(
                `Resolving the App deploy dispatcher failed (${
                    error instanceof Error ? error.message : String(error)
                }); App cluster work is treated as not isolated.`,
            );
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * 2 · the preconditions
     * ---------------------------------------------------------------------- */

    /** T21's pass, with this request's own facts. `null` ⇔ the pass is not available at all. */
    private async evaluate(
        request: AppDeployRequest,
        workId: string,
    ): Promise<AppDeployPreconditionResult | null> {
        if (!this.preconditions || typeof this.preconditions.evaluate !== 'function') return null;

        try {
            return await this.preconditions.evaluate({
                workId,
                buildId: request?.buildId ? String(request.buildId) : null,
                // ACC-06-23: a rollback runs the **old commit's** App spec, so that is the commit
                // the pass must read. A rollback that names an old Build is already read at that
                // Build's commit by T21 (`getEffectiveSpec(workId, build.commitSha)`); the `image`
                // case has no Build, which is exactly why the rollback's recorded commit is folded
                // in here rather than being left to the deploy-branch head.
                specCommitSha: requestedCommit(request),
                headCommitSha: request?.headCommitSha ? String(request.headCommitSha) : null,
                userId: request?.userId ? String(request.userId) : null,
                confirmClusterChange: request?.confirmClusterChange === true,
            });
        } catch (error) {
            // The pass never throws by contract; a throw here is a broken collaborator, and the
            // honest answer is a named refusal rather than a 500 with no code.
            this.logger.warn(
                `Evaluating the App Deploy preconditions for Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * 4–5 · state, lock, queue
     * ---------------------------------------------------------------------- */

    /** One guarded state read; `null` means "the lock could not be judged", never "assume free". */
    private async readState(workId: string): Promise<AppDeployRequestState | null> {
        if (!this.runtimeStates || typeof this.runtimeStates.getOrCreate !== 'function')
            return null;

        try {
            return (await this.runtimeStates.getOrCreate(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the App runtime state of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /**
     * §2.2 step 3's atomic claim, in three answers rather than two: `claimed` (this request owns the
     * dispatch), `busy` (another Deployment holds it) and `unavailable` (there is no lock store, or
     * it threw — which must not be reported as "another Deployment is running").
     */
    private async claim(
        workId: string,
        deploymentId: string,
    ): Promise<'claimed' | 'busy' | 'unavailable'> {
        if (!this.runtimeStates || typeof this.runtimeStates.claimDeployLock !== 'function') {
            return 'unavailable';
        }

        try {
            const claimed = await this.runtimeStates.claimDeployLock(
                workId,
                deploymentId,
                APP_DEPLOY_LOCK_STALE_S,
            );
            return claimed === true ? 'claimed' : 'busy';
        } catch (error) {
            this.logger.warn(
                `Claiming the App deploy lock of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return 'unavailable';
        }
    }

    /** One guarded row insert. */
    private async createRow(draft: AppDeployRowDraft): Promise<{ id: string } | null> {
        if (!this.deployments || typeof this.deployments.create !== 'function') return null;

        try {
            return await this.deployments.create(draft);
        } catch (error) {
            this.logger.error(
                `Creating the App Deployment row ${draft.id} for Work ${draft.workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /**
     * The lock is held: refuse, or queue.
     *
     * `tasks.md:1157` is the rule — "`manual`, `rollback` and `target-saved` are refused with 409
     * while the lock is held; `build` and `domain-change` are queued" — and the queue is the
     * latest-wins one of FR-30: one queued row, `SUPERSEDED` on the one it replaces.
     */
    private async contend(
        request: AppDeployRequest,
        preconditions: AppDeployPreconditionResult,
        stored: AppDeployStoredFacts,
        appTrigger: AppDeployTrigger,
        state: AppDeployRequestState,
        workId: string,
        deploymentId: string,
    ): Promise<AppDeployRequestResult> {
        const runningDeploymentId = state.deployLockId ? String(state.deployLockId) : null;

        if (!APP_DEPLOY_QUEUEABLE_TRIGGERS.includes(appTrigger)) {
            return {
                ...this.base(preconditions, stored),
                ...this.queueFields(state),
                status: 'refused',
                httpStatus: 409,
                code: APP_DEPLOY_CODE_IN_PROGRESS,
                deploymentId: null,
                runningDeploymentId,
                unmet: [
                    {
                        code: 'deploy_in_progress',
                        names: runningDeploymentId ? [runningDeploymentId] : undefined,
                        message:
                            'Another Deployment of this App Work is already running. Cancel it, or ' +
                            'wait for it to finish.',
                    },
                ],
            };
        }

        // Already queued with this exact identity: the same Build, or the same spec commit under
        // `build.strategy: image`. Nothing is created and nothing is superseded (APW06-G16).
        const queuedId = state.queuedDeploymentId ? String(state.queuedDeploymentId) : null;
        const identity = queueIdentity(stored);

        if (queuedId && identity) {
            const queuedRow = await this.findRow(queuedId);
            if (queuedRow && queueIdentity(queuedRow) === identity) {
                return {
                    ...this.base(preconditions, stored),
                    ...this.queueFields(state),
                    status: 'queued',
                    httpStatus: 202,
                    code: null,
                    deploymentId: queuedId,
                    deduplicated: true,
                    dispatched: false,
                };
            }
        }

        const created = await this.createRow(
            rowDraft(deploymentId, workId, request, stored, appTrigger),
        );
        if (!created) {
            return this.refused(503, APP_DEPLOY_CODE_STATE_UNAVAILABLE, [], preconditions);
        }

        const superseded = await this.setQueued(workId, {
            queuedDeploymentId: deploymentId,
            // §5.8: "the queued row carries the spec commit and `queuedBuildId` stays null" under
            // `build.strategy: image`; a Build-backed row queues its Build.
            queuedBuildId: stored.buildId,
        });

        const supersededId =
            (superseded && 'supersededDeploymentId' in superseded
                ? superseded.supersededDeploymentId
                : null) ?? (queuedId && queuedId !== deploymentId ? queuedId : null);

        if (supersededId && supersededId !== deploymentId) {
            await this.markSuperseded(supersededId, deploymentId);
        }

        return {
            ...this.base(preconditions, stored),
            ...this.queueFields({
                queuedDeploymentId: deploymentId,
                queuedBuildId: stored.buildId,
            }),
            status: 'queued',
            httpStatus: 202,
            code: null,
            deploymentId,
            dispatched: false,
        };
    }

    /** One guarded `findById`. */
    private async findRow(deploymentId: string): Promise<AppDeployRowFacts | null> {
        if (!this.deployments || typeof this.deployments.findById !== 'function') return null;

        try {
            return (await this.deployments.findById(deploymentId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the queued App Deployment ${deploymentId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /** One guarded `setQueued` — the call that makes "at most 1 is queued" atomic (T17). */
    private async setQueued(
        workId: string,
        queued: AppDeployQueueWrite,
    ): Promise<{ supersededDeploymentId: string | null } | void> {
        if (!this.runtimeStates || typeof this.runtimeStates.setQueued !== 'function') return;

        try {
            return await this.runtimeStates.setQueued(workId, queued);
        } catch (error) {
            this.logger.warn(
                `Queueing the App Deployment for Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return;
        }
    }

    /** One guarded `markSuperseded` — FR-30's **Skipped** row. */
    private async markSuperseded(deploymentId: string, supersededBy: string): Promise<void> {
        if (!this.deployments || typeof this.deployments.markSuperseded !== 'function') return;

        try {
            await this.deployments.markSuperseded(deploymentId, supersededBy);
        } catch (error) {
            this.logger.warn(
                `Marking the superseded App Deployment ${deploymentId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * 6 · the dispatch, inside FR-23's two seconds
     * ---------------------------------------------------------------------- */

    /**
     * §2.2 step 5 under FR-23's budget.
     *
     * `error` set ⇒ the dispatch threw inside the budget: the lock is released, the row records the
     * failure, and the caller answers `500 dispatch_failed` rather than a 202 that never runs.
     * `dispatched: false` with no error ⇒ the budget elapsed first: the request answers now and the
     * same cleanup happens when the dispatch settles (the tail handler below).
     */
    private async dispatch(
        payload: AppDeployDispatchPayload,
        workId: string,
        deploymentId: string,
    ): Promise<{ dispatched: boolean; error: string | null }> {
        const runtime = this.isolatedDispatcher();
        if (!runtime) {
            return {
                dispatched: false,
                error: 'the isolated worker disappeared between the gate and the dispatch',
            };
        }

        const budgetMs = Math.max(1, this.requestBudgetMs());
        const run = Promise.resolve().then(() => runtime.dispatchAppDeploy(payload));

        let timer: ReturnType<typeof setTimeout> | null = null;
        const budget = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(REQUEST_BUDGET_EXCEEDED), budgetMs);
        });

        try {
            await Promise.race([run, budget]);
            return { dispatched: true, error: null };
        } catch (error) {
            if (error === REQUEST_BUDGET_EXCEEDED) {
                // The request answers within the budget; the dispatch keeps running and its outcome
                // is still recorded, so a late failure cannot leave a lock held by a Deployment that
                // never started.
                void run.catch((late: unknown) => this.failDispatch(workId, deploymentId, late));
                return { dispatched: false, error: null };
            }

            await this.failDispatch(workId, deploymentId, error);
            return { dispatched: false, error: messageOf(error) };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** Release the lock and record the failure — the "the row would strand" half of §9.2:1245. */
    private async failDispatch(
        workId: string,
        deploymentId: string,
        error: unknown,
    ): Promise<void> {
        const message = messageOf(error);
        this.logger.error(
            `Dispatching App Deployment ${deploymentId} for Work ${workId} failed (${message}).`,
        );

        if (this.deployments && typeof this.deployments.markDispatchFailed === 'function') {
            try {
                await this.deployments.markDispatchFailed(
                    deploymentId,
                    APP_DEPLOY_CODE_DISPATCH_FAILED,
                    message,
                );
            } catch (markError) {
                this.logger.warn(
                    `Recording the dispatch failure on ${deploymentId} failed (${
                        markError instanceof Error ? markError.message : String(markError)
                    }).`,
                );
            }
        }

        await this.releaseLock(workId, deploymentId);
    }

    /** One guarded `releaseDeployLock`; it is also what clears T17's cancel flag (§9.10). */
    private async releaseLock(workId: string, deploymentId: string): Promise<void> {
        if (!this.runtimeStates || typeof this.runtimeStates.releaseDeployLock !== 'function')
            return;

        try {
            await this.runtimeStates.releaseDeployLock(workId, deploymentId);
        } catch (error) {
            this.logger.warn(
                `Releasing the App deploy lock of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * Seams the platform may tune
     * ---------------------------------------------------------------------- */

    /** FR-23's 2 s. A seam so a spec can prove the race without waiting two seconds for it. */
    protected requestBudgetMs(): number {
        return APP_DEPLOY_REQUEST_BUDGET_MS;
    }

    /** Minted here so the lock and the row carry one id (§2.2 steps 3–4). */
    protected newDeploymentId(): string {
        return randomUUID();
    }

    /* ---------------------------------------------------------------------- *
     * Result assembly
     * ---------------------------------------------------------------------- */

    /** The fields every answer carries, whatever it decided. */
    private base(
        preconditions: AppDeployPreconditionResult,
        stored: AppDeployStoredFacts,
    ): Omit<AppDeployRequestResult, 'status' | 'httpStatus' | 'code' | 'deploymentId'> {
        return {
            queuedDeploymentId: null,
            queuedBuildId: null,
            runningDeploymentId: null,
            unmet: [],
            advisory: [...(preconditions.advisory ?? [])],
            warnings: this.warningsOf(preconditions),
            dispatched: false,
            deduplicated: false,
            stored,
        };
    }

    /** §5.1's non-refusing entries and T21's warnings, as this service's own warning shape. */
    private warningsOf(
        preconditions: AppDeployPreconditionResult,
    ): Array<{ code: string; message: string }> {
        return [
            ...(preconditions.warnings ?? []).map((warning) => ({
                code: String(warning.code),
                message: String(warning.message),
            })),
            ...(preconditions.advisory ?? []).map((entry) => ({
                code: String(entry.code),
                message: String(entry.message),
            })),
        ];
    }

    /** The two queue columns, read straight off the state so a caller needs no second read. */
    private queueFields(state: {
        queuedDeploymentId?: string | null;
        queuedBuildId?: string | null;
    }): { queuedDeploymentId: string | null; queuedBuildId: string | null } {
        return {
            queuedDeploymentId: state?.queuedDeploymentId ? String(state.queuedDeploymentId) : null,
            queuedBuildId: state?.queuedBuildId ? String(state.queuedBuildId) : null,
        };
    }

    /** A refusal: nothing was created, and every field the caller renders is present. */
    private refused(
        httpStatus: number,
        code: string,
        unmet: AppPrecondition[],
        preconditions?: AppDeployPreconditionResult,
        extraWarnings: Array<{ code: string; message: string }> = [],
    ): AppDeployRequestResult {
        return {
            status: 'refused',
            httpStatus,
            code,
            deploymentId: null,
            queuedDeploymentId: null,
            queuedBuildId: null,
            runningDeploymentId: null,
            unmet,
            advisory: [...(preconditions?.advisory ?? [])],
            warnings: [...this.warningsOf(preconditions ?? EMPTY_PRECONDITIONS), ...extraWarnings],
            dispatched: false,
            deduplicated: false,
            stored: EMPTY_STORED_FACTS,
        };
    }
}

/** The precondition result a refusal without a pass carries — every field empty, never `undefined`. */
const EMPTY_PRECONDITIONS: AppDeployPreconditionResult = {
    unmet: [],
    advisory: [],
    warnings: [],
    context: {
        target: null,
        specCommitSha: null,
        strategy: null,
        buildId: null,
        latestGreenBuildId: null,
        primaryHost: null,
    },
    ready: false,
};

/** The stored facts of a request that stored nothing. */
const EMPTY_STORED_FACTS: AppDeployStoredFacts = {
    buildId: null,
    commitSha: null,
    specCommitSha: null,
    appTarget: null,
    appTrigger: 'manual',
    skipPreDeployJobs: false,
    provider: '',
    branch: null,
    rollback: null,
};

/* -------------------------------------------------------------------------- *
 * Pure helpers — the parts worth testing without a container
 * -------------------------------------------------------------------------- */

/** The FR-23 source, defaulted to `manual` and refused nothing: an unknown value reads as manual. */
export function normaliseTrigger(trigger: AppDeployTrigger | null | undefined): AppDeployTrigger {
    const value = String(trigger ?? '').trim();
    return (APP_DEPLOY_TRIGGERS as readonly string[]).includes(value)
        ? (value as AppDeployTrigger)
        : 'manual';
}

/** FR-34: a rollback skips the pre-deploy jobs unless the owner asked for them back. */
export function skipPreDeployJobsFor(request: AppDeployRequest | null | undefined): boolean {
    if (normaliseTrigger(request?.trigger) !== 'rollback') return false;

    return request?.runPreDeployJobs !== true;
}

/**
 * The commit the App spec must be read at — ACC-06-20's one commit, folded in the order that keeps
 * the image and the spec together (§5.8):
 *
 * 1. a **rollback**'s recorded `specCommitSha` (ACC-06-23: "the old commit's App spec");
 * 2. the request's own `specCommitSha` (`image` Deployments name theirs, §2.2:148);
 * 3. `null`, which leaves T21 to read it at the named Build's commit or the deploy-branch head.
 *
 * A rollback that names an old Build is also read at that Build's commit — T21's `readSpec` prefers
 * `build.commitSha` once a `buildId` is present — so (1) and (2) never contradict it.
 */
export function requestedCommit(request: AppDeployRequest | null | undefined): string | null {
    const rollbackCommit = request?.rollback?.specCommitSha
        ? String(request.rollback.specCommitSha)
        : null;
    if (normaliseTrigger(request?.trigger) === 'rollback' && rollbackCommit) return rollbackCommit;

    return request?.specCommitSha ? String(request.specCommitSha) : null;
}

/**
 * What the row will store — §2.2:156-158 plus §7.1's two flags.
 *
 * Three facts come from T21's context rather than from the request, on purpose: the **target** is
 * the runtime state's (the request cannot choose it), the **spec commit** is the one the spec was
 * actually read at (ACC-06-20 — for a build-backed Deployment that is the Build's commit, for
 * `image` the requested commit or the deploy-branch head), and `nothing` else. The request supplies
 * the Build, the branch, the actor, the provider and the rollback facts.
 */
export function storedFacts(
    request: AppDeployRequest | null | undefined,
    preconditions: AppDeployPreconditionResult,
    appTrigger: AppDeployTrigger,
    skipPreDeployJobs: boolean,
): AppDeployStoredFacts {
    const context = preconditions?.context;
    const specCommitSha = context?.specCommitSha ? String(context.specCommitSha) : null;
    const requestedBuild = request?.buildId ? String(request.buildId) : null;
    // §5.8: a Deployment without a Build stores none — the spec commit and the digest are its
    // handles. Not `requestedBuild` for a rollback either, because the caller passes the old Build
    // there and the strategy still decides whether a Build is deployable.
    const buildId =
        context?.strategy === 'image' || context?.strategy === 'none' ? null : requestedBuild;

    const rollback = request?.rollback
        ? {
              rolledBackToDeploymentId: String(request.rollback.deploymentId),
              imageDigest: request.rollback.imageDigest
                  ? String(request.rollback.imageDigest)
                  : null,
          }
        : null;

    return {
        buildId,
        commitSha: specCommitSha,
        specCommitSha,
        appTarget: context?.target ?? null,
        appTrigger,
        skipPreDeployJobs,
        provider: request?.provider ? String(request.provider) : '',
        branch: request?.branch ? String(request.branch) : null,
        rollback,
    };
}

/** §2.2 step 4's row, from the facts above and the request's own actor. */
export function rowDraft(
    deploymentId: string,
    workId: string,
    request: AppDeployRequest | null | undefined,
    stored: AppDeployStoredFacts,
    appTrigger: AppDeployTrigger,
): AppDeployRowDraft {
    const rollback = request?.rollback;
    const render: Record<string, unknown> = {
        specCommitSha: stored.specCommitSha,
        skipPreDeployJobs: stored.skipPreDeployJobs,
    };

    if (stored.rollback) {
        // §7.1:1037's `appRender.rollback` — a manual rollback, not yet restored.
        render.rollback = {
            automatic: false,
            reason: 'manual',
            restored: false,
            rolledBackToDeploymentId: stored.rollback.rolledBackToDeploymentId,
        };
    }

    if (rollback?.imageDigest) {
        // §5.8: "A rollback redeploys the recorded `specCommitSha` and digest and **never**
        // re-resolves the tag" — the recorded pair is what the worker reads instead of the registry.
        render.image = {
            reference: rollback.imageReference ? String(rollback.imageReference) : '',
            digest: String(rollback.imageDigest),
            resolvedFromTag: false,
        };
    }

    return {
        id: deploymentId,
        workId,
        state: APP_DEPLOY_STATE_INITIALIZING,
        provider: stored.provider,
        triggerSource: 'manual',
        appTrigger,
        buildId: stored.buildId,
        appTarget: stored.appTarget,
        commitSha: stored.commitSha,
        branch: stored.branch,
        triggeredByUserId: request?.userId ? String(request.userId) : null,
        appRender: render,
    };
}

/**
 * The identity a queue entry is deduped by: `build:<id>` when the request names a Build, else
 * `spec:<commit>` when it names a spec commit (§5.8's queue rule), and `null` when it names neither
 * — in which case nothing can ever be deduped and every request supersedes the last, which is
 * FR-30's plain latest-wins.
 */
export function queueIdentity(
    facts: {
        buildId?: string | null;
        commitSha?: string | null;
    } | null,
): string | null {
    const buildId = facts?.buildId ? String(facts.buildId) : null;
    if (buildId) return `${APP_DEPLOY_QUEUE_BUILD_PREFIX}${buildId}`;

    const commitSha = facts?.commitSha ? String(facts.commitSha) : null;
    return commitSha ? `${APP_DEPLOY_QUEUE_SPEC_PREFIX}${commitSha}` : null;
}

/** Whether a stored timestamp/flag is set — the row's own truthiness, never a guess. */
export function isSet(value: Date | string | number | boolean | null | undefined): boolean {
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}

/** An error's message, never its stack and never a credential. */
function messageOf(error: unknown): string {
    if (error instanceof Error && typeof error.message === 'string') return error.message;
    if (typeof error === 'string') return error;

    const message = (error as { message?: unknown })?.message;
    return typeof message === 'string' ? message : 'unknown error';
}
