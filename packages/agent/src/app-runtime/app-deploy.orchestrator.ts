/**
 * APW-06 T25 — the **`app-deploy` orchestrator**: everything plan §5.6 does between "the job
 * started" and "the lock is free".
 *
 * Spec: `APW-06-app-runtime/spec.md` FR-24 (`:362-367`, preconditions "checked on request and again
 * when work starts"), FR-26 (the phase list, "only in-cluster failures and publish failures roll
 * back"), FR-30 (`:390-391`, one Deployment per App Work, latest-wins queue), FR-34 (`:401-406`),
 * FR-36/FR-37 (the two smoke halves), FR-51 (APW-04's upstream-sync verdict — this epic's half).
 * Plan: **§5.6** (`plan.md:805-854`, steps 1–10 — this file's whole shape), §5.1 (`:672-695`), §5.2
 * (`:697-711`), §5.4/§5.5 (`:773-803`, the phase machine T12 implements), **§5.8** (`:866-899`, the
 * `image` strategy and its registry answers), §5.7 (`:856-864`, the in-process smoke call), §9.2
 * (`:1241-1286`), §9.4 (`:1302-1348`, the event names and their emission order), §9.7
 * (`:1468-1514`), **§9.9** (`:1545-1568`, the runtime target resolver). Task text: `tasks.md:440-464`
 * (T25). Acceptance: **ACC-06-21**, **ACC-06-24**, **ACC-06-52**, **ACC-06-55** (APW06-G05) and
 * APW06-G10's eight verdict cases.
 *
 * ## The order, and why it is the order
 *
 * ```
 * 1 · load + re-run §5.1                 unmet → ERROR (appRender.preconditions)   (§5.6 step 1)
 *     … and emit app.deploy.started      before any cluster call                  (§9.4:1308-1311)
 * 2 · AppRenderInput                     T22's builder                            (§5.6 step 2)
 * 3 · cluster access                     T20's facade today, T69's resolver next  (§5.6 step 3)
 * 3b· image identity (strategy image)    T72, once, **before** `prepare`         (§5.8:876-882)
 * 4 · deployApp(input, credential, hooks) DEPLOYING → VERIFYING from smoke        (§5.6 step 4)
 * 5 · outcome → state + the row          READY / ERROR / ROLLED_BACK / CANCELED   (§5.6 step 5)
 * 6 · runtime-state bookkeeping          currentDeploymentId, fingerprint, …     (§5.6 step 6)
 * 7 · events, notifications, lock, dequeue                                       (§5.6 step 7)
 * 9 · the upstream-sync verdict          after the terminal and smoke events      (§5.6 step 9)
 * ```
 *
 * Four properties of that order are load-bearing rather than tidy:
 *
 * - **The lock is released on every path, including a throw.** §5.6 step 7 releases it with
 *   `WHERE "deployLockId" = :id`, and the `finally` below is what makes "no outcome leaves a held
 *   lock" (`tasks.md:463-464`) true for the two paths the plan does not enumerate: a collaborator
 *   that throws and a dispatch that never returns. The release is the **first** thing the `finally`
 *   does, before the dequeue, so a throwing queue cannot strand it either.
 * - **`app.deploy.started` precedes every cluster call.** §9.4:1308-1311 fixes the per-Deployment
 *   order `started → job.* → terminal → smoke.*`; it starts there because a job that dies in
 *   `prepare` must still have told Activity it began.
 * - **A refusal is a named state, never a throw.** §5.1's pass "never throws for an unmet
 *   precondition", and §5.6 step 1 turns its answer into `ERROR` with `appRender.preconditions`
 *   (ACC-06-19/-20). Every other absent collaborator ends the same way with its own code.
 * - **The upstream verdict runs after the lock is free.** §5.6 numbers it step 9, after step 7's
 *   release — which is exactly why "a throwing port never delaying lock release"
 *   (`tasks.md:450-451`) is a property rather than a promise: by the time it runs there is no lock
 *   left to delay.
 *
 * ## `app.job.*` is emitted after the run, and that is the plan's own order
 *
 * The plugin reports phases through `hooks.onPhase` while it works; job results arrive in
 * `AppDeployResult.jobs` when it finishes. §9.4 nonetheless fixes the order
 * `started → job.* → terminal → smoke.*` "asserted by ACCEPTANCE E2E-05", so the job events are
 * emitted from the finished result, in its own execution order, immediately before the terminal
 * event. Smoke ran before the terminal event in real time and is emitted after it "so one
 * Deployment reads as one block" (§9.4:1310-1311).
 *
 * ## One run, one context — no instance state
 *
 * Everything a run accumulates (the events it emitted, the last public-smoke answer, the commit and
 * strategy it resolved) lives in a {@link RunContext} created per {@link AppDeployOrchestrator.run}
 * call. The class is a singleton in the worker and the `app-cluster-io` queue runs twenty
 * Deployments concurrently (`plan.md:1245`), so a field would be a cross-Deployment race — which is
 * also why the last public-smoke answer lives on the context and not on `this`.
 *
 * ## What this file deliberately does not do
 *
 * It never renders a Kubernetes object (T12's `app-deployer.ts` does), never reads a kubeconfig
 * (§9.9's resolver does), never writes a `WorkDeployment` column §5.6 does not name, never emits
 * through `EventEmitter2` (APW06-G02 — the sink is a port precisely because an emit inside the
 * worker would never reach `activity-log.listener.ts`), and never runs a verification (T60's
 * `verification-deploy`, which has no `WorkDeployment` row at all).
 *
 * ## Provisional seams (each routed, none silent)
 *
 * - **The cluster access** — §5.6 step 3 names `AppRuntimeTargetResolver` (T69, §9.9), which is not
 *   in this tree. T20's `AppRuntimeFacadeService.resolveClusterAccess` **is**
 *   (`facades/app-runtime.facade.ts:585-599`) and its own docstring says it is "what §9.10's op
 *   handlers, §5.6's orchestrator and T22's render-input builder are written against", so the seam
 *   below is that method and the binding is
 *   `{ provide: APP_DEPLOY_TARGET_RESOLVER, useExisting: AppRuntimeFacadeService }`. When T69 lands
 *   its `resolve(workId)` additionally supplies the namespace §4.2 prepared and the
 *   `clusterFingerprint`; the seam does not change shape.
 * - **The image identity** — §5.8:876-882's anonymous registry `HEAD` is
 *   `app-image-reference.resolver.ts`, T72 (`tasks.md:1240-1245`), not in this tree. T22 already
 *   consumes the recorded digest additively (`app-render-input.builder.ts:304-305`), so the seam is
 *   `resolve(...)` at the one moment §5.8 names — after the input exists, before `deployApp`.
 * - **The runtime-state row** — T17 (`tasks.md:293-321`). The **token is not declared here**:
 *   `app-launcher.service.ts:223` declares `WORK_APP_RUNTIME_STATES` and T21/T24/T26/T58 already
 *   reuse it, so this file declares the wider *view* it needs of that same provider and reuses the
 *   one token. `getOrCreate` and `releaseDeployLock` are T17's own names; §5.6 step 6's
 *   `patchRuntimeState`, step 7's dequeue compare-and-set `takeQueued` and step 9's
 *   `setUpstreamSyncJudgedToSha` are declared here because T17's list does not name them yet.
 * - **The Deployment row** — T16. T24 already declares `APP_DEPLOY_DEPLOYMENT_STORE` for the create
 *   (`app-deploy-request.service.ts:347-348`); this file declares the wider view of that same token
 *   (`findById`, `update`) and reuses it.
 * - **The dequeue dispatch** — T24 declares `APP_DEPLOY_DISPATCHER`
 *   (`app-deploy-request.service.ts:279-280`) and T31 will bind it; the dequeue reuses that token
 *   rather than declaring a second one.
 * - **The upstream reads** — APW-02's `WorkUpstreamStateRepository.findByWorkId(workId)` and its
 *   `isAncestorCommit` are named by §5.6:840-842 and are not in this tree. Both seams below are
 *   those two calls and nothing else.
 * - **APW-04's verdict call** — `APP_PROVISION_EVENTS_PORT` is declared by
 *   `app-works/app-fork-readiness.service.ts:168-173` for its `forkReady` half; §5.6:838 asks for its
 *   second member, so this file **reuses that token** and declares the wider view. A second
 *   `Symbol('APP_PROVISION_EVENTS_PORT')` would be a different token and APW-04's single binding
 *   would reach only one caller.
 * - **The notification producers** — §9.4:1335-1336's `notifyAppDeployFailed` and
 *   `notifyAppRollbackFailed` are T29's (`tasks.md:511-520`); the `app_rollback_failed` row is the
 *   **urgent** one ACC-06-24 asserts. The seam is those two producers.
 * - **The dependencies service** — APW-07 **has** landed
 *   (`app-dependencies/app-dependencies.service.ts:567,407`). Its token is T58's
 *   (`app-runtime-deletion.service.ts:388`), reused, never re-declared.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_DEPLOYMENT_TERMINAL_STATES,
    type AppCancelReason,
    type AppDeploymentState,
    type AppDeployOutcome,
    type AppDeployPhase,
    type AppPrecondition,
} from '@ever-works/contracts';
import type {
    AppDeployHooks,
    AppDeployResult,
    AppRenderInput,
    AppSmokeInput,
    AppTargetRef,
} from '@ever-works/plugin';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { APP_PROVISION_EVENTS_PORT } from '../app-works/app-fork-readiness.service';
import {
    APP_DEPLOY_DISPATCHER,
    APP_DEPLOY_DEPLOYMENT_STORE,
    type AppDeployDeploymentStore,
} from './app-deploy-request.service';
import {
    AppDeployPreconditionsService,
    type AppDeployPreconditionResult,
} from './app-deploy-preconditions.service';
import { APP_DEPENDENCIES_SERVICE } from './app-runtime-deletion.service';
import { APP_RUNTIME_EVENT_SINK, type AppRuntimeEventSink } from './ports';
import {
    AppPublicSmokeService,
    publicSmokeWindowSeconds,
    type AppPublicSmokeRun,
} from './app-public-smoke.service';
import { AppRenderInputBuilder, workSlugFromNamespace } from './app-render-input.builder';

/* -------------------------------------------------------------------------- *
 * DI tokens
 *
 * Declared **before** the class: a decorator argument is evaluated when the class
 * definition runs, so a token declared after it is in its temporal dead zone.
 * -------------------------------------------------------------------------- */

/** DI token for {@link AppDeployTargetResolver} — bound to T20's `AppRuntimeFacadeService`. */
export const APP_DEPLOY_TARGET_RESOLVER = Symbol('APP_DEPLOY_TARGET_RESOLVER');

/** DI token for {@link AppImageReferenceResolver} — owned by APW-06 T72. */
export const APP_IMAGE_REFERENCE_RESOLVER = Symbol('APP_IMAGE_REFERENCE_RESOLVER');

/** DI token for {@link AppUpstreamStateReader} — owned by APW-02. */
export const APP_UPSTREAM_STATE_READER = Symbol('APP_UPSTREAM_STATE_READER');

/** DI token for {@link AppCommitAncestry} — owned by APW-02. */
export const APP_COMMIT_ANCESTRY = Symbol('APP_COMMIT_ANCESTRY');

/** DI token for {@link AppRuntimeNotificationProducers} — owned by APW-06 T29. */
export const APP_RUNTIME_NOTIFICATIONS = Symbol('APP_RUNTIME_NOTIFICATIONS');

/* -------------------------------------------------------------------------- *
 * Vocabulary this file adds
 * -------------------------------------------------------------------------- */

/** §5.6 step 4 — the state the row carries while the plugin works. */
export const APP_DEPLOY_STATE_DEPLOYING = 'DEPLOYING';

/** §5.6 step 4 — "`state = 'VERIFYING'` from `in-cluster-smoke`". */
export const APP_DEPLOY_STATE_VERIFYING = 'VERIFYING';

/** §5.6 step 4 — the phase `hooks.onPhase` sets `state = 'VERIFYING'` from. */
export const APP_DEPLOY_VERIFYING_PHASE: AppDeployPhase = 'in-cluster-smoke';

/** §5.6 step 5 — `lastError` is "≤ 500 chars". */
export const APP_DEPLOY_LAST_ERROR_MAX_CHARS = 500;

/** §5.6 step 5 / APW06-G05 — the `appRender` key a cancellation is attributed to. */
export const APP_DEPLOY_CANCELLED_BY_KEY = 'cancelledBy';

/** The code a thrown or unavailable collaborator ends the Deployment with (§5.6 step 10). */
export const APP_DEPLOY_CODE_WORKER_FAILED = 'worker_failed';

/** No precondition pass is bound, so §5.6 step 1 cannot be answered at all. */
export const APP_DEPLOY_CODE_PRECONDITIONS_UNAVAILABLE = 'preconditions_unavailable';

/** §5.6 step 3 — the target refused before any cluster call. */
export const APP_DEPLOY_CODE_TARGET_REFUSED = 'target_not_checked';

/** §5.8:879 — a tag resolved to a digest is recorded with this warning. */
export const APP_DEPLOY_WARNING_IMAGE_NOT_PINNED = 'image_not_pinned';

/** The public smoke run could not be made at all — a warning, never a rollback (FR-36 step 7). */
export const APP_DEPLOY_WARNING_SMOKE_UNAVAILABLE = 'smoke_unavailable';

/* -------------------------------------------------------------------------- *
 * §9.4 — the event names, spelled once
 * -------------------------------------------------------------------------- */

/**
 * §9.4:1305-1306 — the App deploy event names, equal to the Activity actions. Declared here rather
 * than imported from `events/app-runtime.events.ts` (T28) because that file is not in this tree and
 * a string literal that differs by one character is a silently missing Activity row. When T28 lands
 * its family's own constants replace these; the strings do not change.
 */
export const APP_EVENT_DEPLOY_STARTED = 'app.deploy.started';
export const APP_EVENT_DEPLOY_SUCCEEDED = 'app.deploy.succeeded';
export const APP_EVENT_DEPLOY_FAILED = 'app.deploy.failed';
export const APP_EVENT_DEPLOY_ROLLED_BACK = 'app.deploy.rolled_back';
export const APP_EVENT_JOB_SUCCEEDED = 'app.job.succeeded';
export const APP_EVENT_JOB_FAILED = 'app.job.failed';
export const APP_EVENT_SMOKE_PASSED = 'app.smoke.passed';
export const APP_EVENT_SMOKE_FAILED = 'app.smoke.failed';

/* -------------------------------------------------------------------------- *
 * Provisional — §5.6 step 3 / §9.9, the cluster access
 * -------------------------------------------------------------------------- */

/** The narrowed, App-capable plugin call this orchestrator makes — `deployApp` alone. */
export interface AppDeployPluginView {
    deployApp(
        input: AppRenderInput,
        credential: string,
        hooks: AppDeployHooks,
    ): Promise<AppDeployResult>;
}

/** Everything a caller needs to dial an App Work's cluster (§9.9's `your-cluster` branch). */
export interface AppDeployClusterAccess {
    target: 'your-cluster' | 'ever-works-apps';
    ref: AppTargetRef;
    credential: string;
    pluginId: string;
    plugin: AppDeployPluginView;
}

/**
 * §5.6 step 3's resolution. T20's facade answers it today
 * (`facades/app-runtime.facade.ts:585-599`); T69's `AppRuntimeTargetResolver` answers it next
 * (§9.9:1552-1553).
 *
 * The two outcomes are a **string discriminant** on purpose: `strictNullChecks: false` stops a
 * `{ ok: true } | { ok: false }` union from narrowing (`app-runtime.facade.ts:243-248`).
 */
export interface AppDeployTargetResolver {
    resolveClusterAccess(
        workId: string,
    ): Promise<
        | { outcome: 'access'; access: AppDeployClusterAccess }
        | { outcome: 'refused'; refusal: string }
    >;
}

/* -------------------------------------------------------------------------- *
 * Provisional — §5.8:876-882, the image identity (T72)
 * -------------------------------------------------------------------------- */

/** What T72's resolver answers for one reference (§5.8's three registry outcomes). */
export type AppImageResolutionResult =
    | {
          status: 'resolved';
          /** `<repository>@<digest>` — what the Deployment records and renders. */
          reference: string;
          digest: string;
          /** `true` ⇔ the spec gave a tag, so the warning `image_not_pinned` applies (§5.8:879). */
          resolvedFromTag: boolean;
      }
    | { status: 'refused'; code: string; message: string };

/** APW-06 T72's `AppImageReferenceResolver`, as this orchestrator consumes it. */
export interface AppImageReferenceResolver {
    resolve(input: {
        workId: string;
        /** The spec's own reference — a tag or an already-pinned `@sha256:` digest. */
        reference: string;
        specCommitSha: string;
    }): Promise<AppImageResolutionResult>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-02's upstream reads (§5.6:840-842)
 * -------------------------------------------------------------------------- */

/** One `work_upstream_states` row as §5.6 step 9 reads it. */
export interface AppUpstreamStateView {
    lastSyncFromSha?: string | null;
    /** "absent, or `lastSyncToSha` null, means skip" (§5.6:840-841). */
    lastSyncToSha?: string | null;
    /** The upstream's owner/repo, which `isAncestorCommit` is called with (§5.6:842). */
    upstreamOwner?: string | null;
    upstreamRepo?: string | null;
}

/** APW-02's `WorkUpstreamStateRepository.findByWorkId(workId)`. */
export interface AppUpstreamStateReader {
    findByWorkId(workId: string): Promise<AppUpstreamStateView | null>;
}

/** APW-02's `isAncestorCommit(owner, repo, ancestorSha, commitSha)` — `null` means "unsupported". */
export interface AppCommitAncestry {
    isAncestorCommit(
        owner: string,
        repo: string,
        ancestorSha: string,
        commitSha: string,
    ): Promise<boolean | null>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-04's half of the provision events port (token reused)
 * -------------------------------------------------------------------------- */

/**
 * `APP_PROVISION_EVENTS_PORT`'s second member, as §5.6:838-849 asks for it: the wider view of the
 * one token `app-works/app-fork-readiness.service.ts:168-173` declares for its `forkReady` half.
 */
export interface AppProvisionEventsPort {
    /** Called **only** when this Deployment emitted `app.smoke.failed` (§5.6:844-847). */
    smokeFailedAfterUpstreamSync?(
        workId: string,
        fromSha: string | null,
        toSha: string,
    ): Promise<void> | void;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T29, the two notification producers (§9.4:1335-1336)
 * -------------------------------------------------------------------------- */

/** APW-06 T29's notification producers, as §5.6 step 7a and ACC-06-24 call them. */
export interface AppRuntimeNotificationProducers {
    /** `app_deploy_failed` — not urgent (§9.4:1335). */
    notifyAppDeployFailed?(args: {
        userId: string;
        workId: string;
        deploymentId: string;
        code?: string | null;
    }): Promise<void> | void;
    /** `app_rollback_failed` — **urgent**, and the one ACC-06-24 asserts (§9.4:1336). */
    notifyAppRollbackFailed?(args: {
        userId: string;
        workId: string;
        deploymentId: string;
    }): Promise<void> | void;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-07 T16, the dependency hooks (§5.6 step 8)
 * -------------------------------------------------------------------------- */

/** APW-07's `AppDependenciesService`, as §5.6 step 8 consumes it. */
export interface AppDeployOrchestratorDependencyService {
    onAppRemoved(
        workId: string,
        opts: { deleteData: boolean },
    ): Promise<{ remaining?: readonly string[] | null } | null | undefined>;
    reconcile(workId: string): Promise<unknown>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T17's runtime state (token reused, never re-declared)
 * -------------------------------------------------------------------------- */

/** One `work_app_runtime_states` row as this orchestrator reads and writes it (§7.2:1042-1074). */
export interface AppDeployOrchestratorStateView {
    target?: string | null;
    namespace?: string | null;
    clusterFingerprint?: string | null;
    currentDeploymentId?: string | null;
    deployLockId?: string | null;
    /** APW06-G05 — the flag `hooks.isCancelled()` reads (T17:300-302). */
    cancelRequestedAt?: Date | string | number | null;
    /** APW06-G05 — who asked for the cancel, when it is set. */
    cancelRequestedByUserId?: string | null;
    /** §7.2:1056 — latest-wins queue of one. */
    queuedDeploymentId?: string | null;
    queuedBuildId?: string | null;
    /** §5.6:843-844 — the `lastSyncToSha` this Work's upstream verdict has already judged. */
    upstreamSyncJudgedToSha?: string | null;
    /** §5.5 / APW06-G05 — the stop flag `hooks.isCancelled()` also honours. */
    paused?: boolean | null;
    pausedAt?: Date | string | number | null;
    /** APW06-G05 — a quarantine is `deletionRequestedAt`, per R-20. */
    deletionRequestedAt?: Date | string | number | null;
    /** §6.3 — the address `checkAppCluster` recorded. */
    ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
    isolationEnforced?: boolean | null;
    statusSnapshot?: unknown;
}

/** APW-06 T17's `WorkAppRuntimeStateRepository`, as this orchestrator consumes it. */
export interface AppDeployOrchestratorStateStore {
    getOrCreate(workId: string): Promise<AppDeployOrchestratorStateView | null>;
    /** T17's own name; it clears `cancelRequestedAt` in the same UPDATE (T17:300-302). */
    releaseDeployLock(workId: string, deploymentId: string): Promise<boolean | void>;
    /**
     * §5.6 step 6 — one write for the fields the step names: `currentDeploymentId`,
     * `firstDeployJobsCompletedAt`, `clusterFingerprint`, `ingressAddress`, `isolationEnforced`,
     * `namespace`, `statusSnapshot` (§5.6:827-828).
     */
    patchRuntimeState?(
        workId: string,
        patch: {
            currentDeploymentId?: string | null;
            firstDeployJobsCompletedAt?: Date | string | number | null;
            clusterFingerprint?: string | null;
            ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
            isolationEnforced?: boolean | null;
            namespace?: string | null;
            statusSnapshot?: unknown;
        },
    ): Promise<unknown>;
    /**
     * §5.6 step 7's dequeue — "one compare-and-set" (T24's header,
     * `app-deploy-request.service.ts:80-81`): clears `queuedDeploymentId` + `queuedBuildId` and
     * answers what it took, so two concurrent finishes cannot dispatch the same queued row twice.
     */
    takeQueued?(
        workId: string,
    ): Promise<{ queuedDeploymentId?: string | null; queuedBuildId?: string | null } | null>;
    /** §5.6:843-844 — set `upstreamSyncJudgedToSha` "whether the Deployment passed or failed". */
    setUpstreamSyncJudgedToSha?(workId: string, sha: string | null): Promise<unknown>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T16's Deployment row (T24's token, wider view)
 * -------------------------------------------------------------------------- */

/** The row facts §5.6 steps 4–7 write. */
export interface AppDeployRowUpdate {
    state?: AppDeploymentState | string | null;
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
    /** §5.6 step 5 — `lastError` "≤ 500 chars". */
    lastError?: string | null;
    componentStatuses?: unknown;
    smokeResult?: unknown;
    /** The `simple-json` render facts, **merged** rather than replaced (§7.1:1037). */
    appRender?: Record<string, unknown>;
}

/** T16's `WorkDeploymentRepository`, as this orchestrator consumes it. */
export interface AppDeployOrchestratorDeploymentStore extends AppDeployDeploymentStore {
    findById?(deploymentId: string): Promise<{
        id: string;
        workId?: string | null;
        state?: string | null;
        buildId?: string | null;
        commitSha?: string | null;
        appTrigger?: string | null;
        appRender?: Record<string, unknown> | null;
    } | null>;
    /** §5.6 steps 4–7. One call, so the phase and the state cannot drift apart. */
    update?(workId: string, deploymentId: string, patch: AppDeployRowUpdate): Promise<unknown>;
}

/* -------------------------------------------------------------------------- *
 * Provisional — APW-06 T31, the `app-deploy` dispatcher (T24's token, reused)
 * -------------------------------------------------------------------------- */

/** The dequeue dispatch of §5.6 step 7 (T24's `dispatchAppDeploy`, `:268-277`). */
export interface AppDeployOrchestratorDispatcher {
    dispatchAppDeploy?(
        payload: {
            workId: string;
            deploymentId: string;
            trigger: string;
            buildId: string | null;
            specCommitSha: string | null;
            requestId?: string | null;
        },
        opts?: { delayMs?: number },
    ): Promise<string | null>;
    isEnabled?(): boolean;
    resolve?(): unknown;
}

/* -------------------------------------------------------------------------- *
 * §5.6 step 8 — the two removal paths, as T70's `remove` op calls them
 * -------------------------------------------------------------------------- */

/** Which of §5.6 step 8's two removal paths a caller is on. */
export interface AppRemovalRequest {
    workId: string;
    /** `true` ⇔ "Remove with data". */
    deleteData: boolean;
    /** The namespace the app runs in; absent ⇒ the target resolver's own answer. */
    namespace?: string | null;
}

/** What {@link AppDeployOrchestrator.removeAppWork} reports (§9.2's `remove` op, T70). */
export interface AppRemovalResult {
    /** `removed` · `removed-with-remnants` · `refused`. */
    status: string;
    code: string | null;
    reason: string | null;
    /** Object kinds and names only — never a value (§9.4:1325-1326). */
    mayRemain: string[];
}

/* -------------------------------------------------------------------------- *
 * §5.6 step 9 — the verdict
 * -------------------------------------------------------------------------- */

/** What §5.6 step 9 concluded, so APW06-G10's eight cases are all observable. */
export interface AppUpstreamSyncVerdict {
    /** `judged` · `skipped` · `already-judged`. */
    status: string;
    /** Why it was skipped: `no_sync` · `not_from_sync` · `rollback` · `no_reader` · `threw`. */
    reason: string | null;
    lastSyncToSha: string | null;
    /** `true` ⇔ `smokeFailedAfterUpstreamSync` was called. */
    reported: boolean;
}

/* -------------------------------------------------------------------------- *
 * Request and result
 * -------------------------------------------------------------------------- */

/** What the `app-deploy` job hands the orchestrator (§5.6 step 1). */
export interface AppDeployOrchestratorRequest {
    workId: string;
    deploymentId: string;
    /** The FR-23 source, echoed on the events and the log line. */
    trigger?: string | null;
    /** `null` under `build.strategy: image`/`none` (§5.8). */
    buildId?: string | null;
    /** §5.8: the commit an `image` Deployment reads its spec from. */
    specCommitSha?: string | null;
    /** Who asked; the notification producers need an owner. */
    userId?: string | null;
    /** The Work's head commit, for `no_green_build_for_head`. */
    headCommitSha?: string | null;
    /** FR-34: pre-deploy jobs are skipped on a manual rollback by default. */
    skipPreDeployJobs?: boolean | null;
    /** FR-34: this Deployment is a rollback, so §5.6 step 9 never runs for it. */
    isRollback?: boolean | null;
    preview?: { prNumber: number } | null;
}

/**
 * What {@link AppDeployOrchestrator.run} answers.
 *
 * `state` is a **string discriminant** — `APP_DEPLOYMENT_STATES`' own members.
 */
export interface AppDeployOrchestratorResult {
    /** The stored `work_deployments.state`. */
    state: AppDeploymentState;
    /** The plugin's outcome, verbatim. `null` when the run never reached the plugin. */
    outcome: AppDeployOutcome | null;
    code: string | null;
    reason: string | null;
    deploymentId: string;
    warnings: Array<{ code: string; message: string }>;
    /** §5.6 step 7 — `true` ⇔ this run's `releaseDeployLock` was attempted and did not throw. */
    lockReleased: boolean;
    /** §5.6 step 7 — the queued row this run adopted, when it adopted one. */
    queuedDeploymentId: string | null;
    /** §5.6 step 7 — the queued Build it dispatched a Deployment for. */
    queuedBuildId: string | null;
    /** §5.6 step 9's answer. */
    upstreamVerdict: AppUpstreamSyncVerdict | null;
    /** Every event this run emitted, in order — the acceptance assertion of `tasks.md:454`. */
    emitted: string[];
}

/** Everything one run accumulates. Created per call — see the header. */
interface RunContext {
    workId: string;
    deploymentId: string;
    /** The events emitted so far, in order. */
    emitted: string[];
    warnings: Array<{ code: string; message: string }>;
    /** §5.8 — the effective `build.strategy`, read from §5.1's context. */
    strategy: string;
    /** The commit the Deployment's App spec was read at (ACC-06-20) — §5.6 step 9's input. */
    commitSha: string | null;
    /** The last `hooks.verifyPublic` answer, so §5.6 step 9 can tell `check_failed` from a warning. */
    publicSmoke: AppPublicSmokeRun | null;
    /** The last phase `hooks.onPhase` reported. */
    phase: AppDeployPhase | null;
}

/* -------------------------------------------------------------------------- *
 * The orchestrator
 * -------------------------------------------------------------------------- */

/**
 * §5.6. Constructed in the worker's `TriggerAppRuntimeModule` (plan §6.4:980) and nowhere else — it
 * is the one class that calls `deployApp`. Like every App runtime class it is constructible with
 * **nothing** bound, and each absent collaborator ends the run in a named `ERROR` rather than in a
 * silent success.
 */
@Injectable()
export class AppDeployOrchestrator {
    private readonly logger = new Logger(AppDeployOrchestrator.name);

    constructor(
        @Optional()
        private readonly preconditions?: AppDeployPreconditionsService,
        @Optional()
        private readonly renderer?: AppRenderInputBuilder,
        @Optional()
        @Inject(APP_DEPLOY_TARGET_RESOLVER)
        private readonly targets?: AppDeployTargetResolver,
        @Optional()
        @Inject(APP_RUNTIME_EVENT_SINK)
        private readonly events?: AppRuntimeEventSink,
        @Optional()
        @Inject(APP_IMAGE_REFERENCE_RESOLVER)
        private readonly images?: AppImageReferenceResolver,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: AppDeployOrchestratorStateStore,
        @Optional()
        @Inject(APP_DEPLOY_DEPLOYMENT_STORE)
        private readonly deployments?: AppDeployOrchestratorDeploymentStore,
        @Optional()
        private readonly smoke?: AppPublicSmokeService,
        @Optional()
        @Inject(APP_RUNTIME_NOTIFICATIONS)
        private readonly notifications?: AppRuntimeNotificationProducers,
        @Optional()
        @Inject(APP_UPSTREAM_STATE_READER)
        private readonly upstream?: AppUpstreamStateReader,
        @Optional()
        @Inject(APP_COMMIT_ANCESTRY)
        private readonly ancestry?: AppCommitAncestry,
        @Optional()
        @Inject(APP_PROVISION_EVENTS_PORT)
        private readonly provisionEvents?: AppProvisionEventsPort,
        @Optional()
        @Inject(APP_DEPLOY_DISPATCHER)
        private readonly dispatchers?: AppDeployOrchestratorDispatcher,
        @Optional()
        @Inject(APP_DEPENDENCIES_SERVICE)
        private readonly dependencies?: AppDeployOrchestratorDependencyService,
    ) {}

    /**
     * §5.6 steps 1–9 for one Deployment. Resolves for every answer a caller renders — including a
     * refusal — because the `app-deploy` task turns the result into the Deployment's state and the
     * `onFailure` hook (T32) needs the same shape.
     */
    async run(request: AppDeployOrchestratorRequest): Promise<AppDeployOrchestratorResult> {
        const context: RunContext = {
            workId: text(request?.workId) || '',
            deploymentId: text(request?.deploymentId) || '',
            emitted: [],
            warnings: [],
            strategy: 'none',
            commitSha: null,
            publicSmoke: null,
            phase: null,
        };

        const result: AppDeployOrchestratorResult = {
            state: 'ERROR',
            outcome: null,
            code: null,
            reason: null,
            deploymentId: context.deploymentId,
            warnings: context.warnings,
            lockReleased: false,
            queuedDeploymentId: null,
            queuedBuildId: null,
            upstreamVerdict: null,
            emitted: context.emitted,
        };

        let verdict: (() => Promise<void>) | null = null;

        try {
            if (!context.workId || !context.deploymentId) {
                await this.failRun(
                    context,
                    result,
                    APP_DEPLOY_CODE_WORKER_FAILED,
                    'the job payload named no Work or no Deployment',
                );

                return result;
            }

            // ---- 1 · §5.1 again, inside the Deployment that already holds the lock ------------
            const preconditions = await this.evaluate(request, context);

            if (!preconditions) {
                await this.failRun(
                    context,
                    result,
                    APP_DEPLOY_CODE_PRECONDITIONS_UNAVAILABLE,
                    'the Deploy preconditions cannot be evaluated in this worker',
                );

                return result;
            }

            context.warnings.push(...preconditions.warnings);
            context.strategy = text(preconditions.context?.strategy) || 'none';

            if (preconditions.unmet.length > 0) {
                // §5.6 step 1 — "unmet → `ERROR` with `appRender.preconditions`".
                const unmet: AppPrecondition[] = [...preconditions.unmet];
                await this.patchDeployment(context, {
                    state: 'ERROR',
                    completedAt: new Date().toISOString(),
                    lastError: truncate(
                        unmet[0]?.message ?? 'preconditions unmet',
                        APP_DEPLOY_LAST_ERROR_MAX_CHARS,
                    ),
                    appRender: { preconditions: unmet },
                });
                await this.failRun(
                    context,
                    result,
                    unmet[0]?.code ?? APP_DEPLOY_CODE_PRECONDITIONS_UNAVAILABLE,
                    unmet[0]?.message ?? 'the Deploy preconditions are not met',
                    { alreadyPatched: true },
                );

                return result;
            }

            const state = await this.readState(context.workId);

            // ---- 4 (first half) · the row says DEPLOYING, and Activity is told --------------
            await this.patchDeployment(context, {
                state: APP_DEPLOY_STATE_DEPLOYING,
                startedAt: new Date().toISOString(),
                appRender: { phase: 'prepare', preconditions: [] },
            });
            await this.emit(context, APP_EVENT_DEPLOY_STARTED, {
                workId: context.workId,
                userId: text(request?.userId),
                deploymentId: context.deploymentId,
                buildId: text(request?.buildId),
                target: text(state?.target),
            });

            // ---- 3 · cluster access (§5.6 step 3, §9.9) -------------------------------------
            const access = await this.resolveAccess(context.workId);
            if (!access) {
                await this.failRun(
                    context,
                    result,
                    APP_DEPLOY_CODE_TARGET_REFUSED,
                    'no App cluster access could be resolved for this Work',
                );

                return result;
            }

            // ---- 2 · the render input (§5.6 step 2, T22) ------------------------------------
            const built = await this.buildInput(request, context, access, state);

            if (!built.input) {
                await this.failRun(context, result, built.code, built.reason);

                return result;
            }

            context.commitSha = text(built.input.specCommitSha);
            let input = built.input;

            // ---- 3b · §5.8's image identity, once, before `prepare` -------------------------
            let image: { reference: string; digest: string; resolvedFromTag: boolean } | null =
                null;

            if (context.strategy === 'image') {
                const identity = await this.resolveImage(context, input);

                if (identity.status !== 'resolved') {
                    await this.failRun(context, result, identity.code, identity.message);

                    return result;
                }

                image = {
                    reference: identity.reference,
                    digest: identity.digest,
                    resolvedFromTag: identity.resolvedFromTag,
                };
                input = { ...input, image: { ...input.image, reference: identity.reference } };

                if (identity.resolvedFromTag) {
                    // §5.8:879 — "a tag is resolved to a digest and the Deployment records the
                    // warning `image_not_pinned`".
                    context.warnings.push({
                        code: APP_DEPLOY_WARNING_IMAGE_NOT_PINNED,
                        message:
                            'This App spec names a tag, so it was resolved once to the digest ' +
                            'above; this Deployment runs that digest.',
                    });
                }
            }

            // ---- 4 · the cluster call, with §5.6 step 4's hooks -----------------------------
            const deployResult = await this.deploy(access, input, context);

            // ---- 5 · outcome → state, and the row ------------------------------------------
            const mapped = mapOutcome(deployResult);
            result.outcome = deployResult.outcome;
            result.state = mapped.state;
            result.code = mapped.code;
            result.reason = mapped.reason;

            await this.patchDeployment(context, {
                state: mapped.state,
                completedAt: new Date().toISOString(),
                lastError: mapped.reason,
                componentStatuses: [...(deployResult.components ?? [])],
                smokeResult: deployResult.smoke ?? null,
                appRender: {
                    phase: context.phase ?? 'done',
                    warnings: [
                        ...context.warnings,
                        ...(deployResult.warnings ?? []).map((warning) => ({ ...warning })),
                    ],
                    jobs: [...(deployResult.jobs ?? [])],
                    ...(image ? { image } : {}),
                    ...(deployResult.failure ? { failure: deployResult.failure } : {}),
                    ...(cancelReasonOf(deployResult)
                        ? { [APP_DEPLOY_CANCELLED_BY_KEY]: cancelReasonOf(deployResult) }
                        : {}),
                    ...(text(built.input.specCommitSha)
                        ? { specCommitSha: text(built.input.specCommitSha) }
                        : {}),
                    ...(text(input.hosts?.primary)
                        ? {
                              // §8.1:1103-1104 — what T26's `previous` carry-over reads.
                              hosts: {
                                  primary: text(input.hosts?.primary),
                                  extra: [...(input.hosts?.extra ?? [])],
                              },
                          }
                        : {}),
                },
            });

            // ---- 6 · the runtime-state bookkeeping (§5.6 step 6) ---------------------------
            await this.recordRuntimeState(context, access, deployResult, mapped.state);

            // ---- 7a · the events, in §9.4's order ------------------------------------------
            await this.emitJobEvents(context, request, deployResult);
            await this.emit(context, terminalEventName(deployResult.outcome), {
                workId: context.workId,
                userId: text(request?.userId),
                deploymentId: context.deploymentId,
                buildId: text(request?.buildId),
                target: text(state?.target),
                phase: deployResult.failure?.phase ?? null,
                code: deployResult.failure?.code ?? null,
            });
            const smoke = await this.emitSmokeEvent(context, request, deployResult);
            await this.notify(context, request, deployResult, mapped.state);

            // §5.6 step 9 runs after the lock is free — see `verdict` and the `finally` below.
            verdict = async (): Promise<void> => {
                result.upstreamVerdict = await this.judgeUpstreamSync(
                    context,
                    request,
                    deployResult,
                    smoke,
                );
            };
        } catch (error) {
            // §5.6 step 10 / `tasks.md:456` — a thrown plugin error ends `ERROR (worker_failed)`.
            this.logger.error(
                `App Deployment ${context.deploymentId} of Work ${context.workId} failed: ` +
                    messageOf(error),
            );
            await this.failRun(context, result, APP_DEPLOY_CODE_WORKER_FAILED, messageOf(error));
        } finally {
            // ---- 7b · the lock, then the queue (§5.6 step 7) -------------------------------
            result.lockReleased = await this.releaseLock(context);
            const queued = await this.dequeue(context);
            result.queuedDeploymentId = queued.queuedDeploymentId;
            result.queuedBuildId = queued.queuedBuildId;
        }

        if (verdict) {
            // §5.6:838-839 — "a failure is logged, never fatal, and never delays lock release".
            try {
                await verdict();
            } catch (error) {
                this.logger.warn(
                    `The upstream-sync verdict for Work ${context.workId} failed (` +
                        `${messageOf(error)}); the Deployment is unaffected and the lock is already ` +
                        'released.',
                );
            }
        }

        return result;
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 8 — the two removal paths, as T70's `remove` op calls them
     * ---------------------------------------------------------------------- */

    /**
     * §5.6:831-835, in its own two orders — and the order is the whole point:
     *
     * - **Remove with data**: `AppDependenciesService.onAppRemoved(workId, { deleteData: true })`
     *   runs **before** `destroyApp(…, { deleteVolumes: true })`; and when it reports `remaining`,
     *   the op ends with `mayRemain[]` and **skips** the volume and namespace delete.
     * - **Keep data**: `destroyApp(…, { deleteVolumes: false })` runs first and
     *   `onAppRemoved(workId, { deleteData: false })` **after** it.
     *
     * The `destroyApp` half is the deployment plugin's and the namespace delete is §9.7's
     * `delete-app-work` op (T58); this method owns the two dependency hooks and their order, which is
     * what T25's task text assigns it ("calls APW-07's `onAppRemoved` on both removal paths (plan
     * §5.6 step 8, T70's `remove` op)"). The caller performs the `destroyApp` **after** this answer
     * on the with-data path and **before** it on the keep-data path.
     */
    async removeAppWork(request: AppRemovalRequest): Promise<AppRemovalResult> {
        const workId = text(request?.workId) || '';
        const deleteData = request?.deleteData === true;

        if (!workId) {
            return {
                status: 'refused',
                code: 'not_found',
                reason: 'No App Work was named.',
                mayRemain: [],
            };
        }

        if (!this.dependencies?.onAppRemoved) {
            return {
                status: 'refused',
                code: 'dependencies_unavailable',
                reason:
                    'No App dependencies service is bound, so the removal cannot be ordered ' +
                    'against the dependency deletion.',
                mayRemain: [],
            };
        }

        try {
            if (deleteData) {
                const before = await this.dependencies.onAppRemoved(workId, { deleteData: true });
                const remaining = [...(before?.remaining ?? [])];

                if (remaining.length > 0) {
                    return {
                        status: 'removed-with-remnants',
                        code: 'dependencies_remaining',
                        reason:
                            'Some App dependencies could not be deleted, so the volumes and the ' +
                            'namespace were kept.',
                        mayRemain: remaining,
                    };
                }

                return { status: 'removed', code: null, reason: null, mayRemain: [] };
            }

            await this.dependencies.onAppRemoved(workId, { deleteData: false });

            return { status: 'removed', code: null, reason: null, mayRemain: [] };
        } catch (error) {
            return {
                status: 'refused',
                code: 'dependencies_unavailable',
                reason: messageOf(error),
                mayRemain: [],
            };
        }
    }

    /**
     * §5.6:836 — "`reconcile(workId)` after a committed change of `target` or
     * `clusterFingerprint`". The caller is the route that committed the change (`PUT :id/app-target`)
     * or the `cluster-check` op (§9.10); this method is the one call, so the two cannot drift.
     */
    async reconcileDependencies(workId: string): Promise<boolean> {
        const id = text(workId);
        if (!id) return false;
        if (!this.dependencies?.reconcile) return false;

        try {
            await this.dependencies.reconcile(id);

            return true;
        } catch (error) {
            this.logger.warn(
                `Reconciling the App dependencies of Work ${id} failed (${messageOf(error)}).`,
            );

            return false;
        }
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 1 — the re-check
     * ---------------------------------------------------------------------- */

    /**
     * §5.1's pass with the Deployment's own id, so the pass does not refuse the very Deployment that
     * holds the lock (`app-deploy-preconditions.service.ts:310-317`).
     */
    private async evaluate(
        request: AppDeployOrchestratorRequest,
        context: RunContext,
    ): Promise<AppDeployPreconditionResult | null> {
        if (!this.preconditions || typeof this.preconditions.evaluate !== 'function') return null;

        try {
            return await this.preconditions.evaluate({
                workId: context.workId,
                buildId: text(request?.buildId),
                specCommitSha: text(request?.specCommitSha),
                headCommitSha: text(request?.headCommitSha),
                userId: text(request?.userId),
                deploymentId: context.deploymentId,
            });
        } catch (error) {
            this.logger.warn(
                `Re-running the Deploy preconditions for Work ${context.workId} failed (` +
                    `${messageOf(error)}).`,
            );

            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 steps 2–3 — the input and the access
     * ---------------------------------------------------------------------- */

    private async resolveAccess(workId: string): Promise<AppDeployClusterAccess | null> {
        if (!this.targets?.resolveClusterAccess) return null;

        try {
            const answer = await this.targets.resolveClusterAccess(workId);

            if (answer?.outcome === 'access' && answer.access?.plugin?.deployApp) {
                return answer.access;
            }

            this.logger.warn(
                `No App cluster access for Work ${workId}: ${
                    answer?.outcome === 'refused' ? answer.refusal : 'the resolver answered nothing'
                }.`,
            );

            return null;
        } catch (error) {
            this.logger.warn(
                `Resolving the App cluster access of Work ${workId} failed (${messageOf(error)}).`,
            );

            return null;
        }
    }

    /** §5.6 step 2, plus the one fact §5.6 step 6's bookkeeping needs from the state. */
    private async buildInput(
        request: AppDeployOrchestratorRequest,
        context: RunContext,
        access: AppDeployClusterAccess,
        state: AppDeployOrchestratorStateView | null,
    ): Promise<{ input: AppRenderInput | null; code: string; reason: string }> {
        if (!this.renderer || typeof this.renderer.build !== 'function') {
            return {
                input: null,
                code: 'env_source_unavailable',
                reason: 'No App render-input builder is bound in this worker.',
            };
        }

        const ref = access.ref ?? ({ workId: context.workId } as AppTargetRef);
        // §5.6 step 6's bookkeeping: the first Deployment of a **cluster fingerprint**. A state with
        // no fingerprint has never deployed, so this is the first one by definition.
        const fingerprint = text(
            (ref as { clusterFingerprint?: string | null }).clusterFingerprint,
        );
        const isFirstDeploymentOnCluster =
            !text(state?.clusterFingerprint) || state?.clusterFingerprint !== fingerprint;

        try {
            const answer = await this.renderer.build({
                workId: context.workId,
                workSlug: workSlugFromNamespace(String(ref.namespace ?? '')),
                ref,
                deploymentId: context.deploymentId,
                buildId: text(request?.buildId),
                specCommitSha: text(request?.specCommitSha),
                isFirstDeploymentOnCluster,
                skipPreDeployJobs: request?.skipPreDeployJobs === true,
                preview: request?.preview ?? null,
            });

            context.warnings.push(...(answer.warnings ?? []));

            if (answer.status !== 'ready' || !answer.input) {
                return {
                    input: null,
                    code: text(answer.code) || 'spec_unavailable',
                    reason: text(answer.reason) || 'the App render input could not be built',
                };
            }

            return { input: answer.input, code: '', reason: '' };
        } catch (error) {
            return { input: null, code: 'spec_unavailable', reason: messageOf(error) };
        }
    }

    /** §5.8:876-882 — T72's resolver, called exactly once and only for `build.strategy: image`. */
    private async resolveImage(
        context: RunContext,
        input: AppRenderInput,
    ): Promise<AppImageResolutionResult> {
        const reference = text(input.image?.reference);

        if (!this.images?.resolve) {
            // No T72 in this worker. §5.8 makes the identity resolution mandatory before `prepare`;
            // running the spec's reference unpinned would deploy whatever the tag points at by the
            // time the cluster pulls it, so this is a refusal carrying §5.8's own code.
            return {
                status: 'refused',
                code: 'image_unresolvable',
                message: 'No App image reference resolver is bound in this worker.',
            };
        }

        try {
            const answer = await this.images.resolve({
                workId: context.workId,
                reference,
                specCommitSha: text(input.specCommitSha) || '',
            });

            if (answer?.status === 'resolved' && text(answer.reference)) {
                return answer;
            }

            return answer?.status === 'refused'
                ? answer
                : {
                      status: 'refused',
                      code: 'image_unresolvable',
                      message: 'The App image reference resolver answered nothing.',
                  };
        } catch (error) {
            return { status: 'refused', code: 'image_unresolvable', message: messageOf(error) };
        }
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 4 — the call, and its hooks
     * ---------------------------------------------------------------------- */

    private async deploy(
        access: AppDeployClusterAccess,
        input: AppRenderInput,
        context: RunContext,
    ): Promise<AppDeployResult> {
        const hooks: AppDeployHooks = {
            onPhase: async (phase, detail) => {
                context.phase = phase;

                const verifying = phase === APP_DEPLOY_VERIFYING_PHASE;

                await this.patchDeployment(context, {
                    ...(verifying ? { state: APP_DEPLOY_STATE_VERIFYING } : {}),
                    appRender: { phase, ...(detail ? { phaseDetail: detail } : {}) },
                });
            },
            verifyPublic: async (request) => {
                // §5.7:864 — "Inside `app-deploy` the same services are called in-process so a
                // failure can roll back within one job."
                const run = await this.runPublicSmoke(context, input, request);

                if (!run) return { checks: [], passed: true };

                context.publicSmoke = run;

                return { checks: run.checks, passed: run.passed };
            },
            isCancelled: async () => this.isCancelled(context.workId),
        };

        return access.plugin.deployApp(input, access.credential, hooks);
    }

    private async runPublicSmoke(
        context: RunContext,
        input: AppRenderInput,
        request: {
            urls: readonly string[];
            checks: readonly AppSmokeInput[];
            windowSeconds: number;
        },
    ): Promise<AppPublicSmokeRun | null> {
        if (!this.smoke?.run) return null;

        try {
            return await this.smoke.run({
                workId: context.workId,
                urls: request.urls,
                checks: request.checks,
                windowSeconds:
                    request.windowSeconds ??
                    publicSmokeWindowSeconds(input.isFirstDeploymentOnCluster === true),
                isFirstDeploymentOnCluster: input.isFirstDeploymentOnCluster === true,
            });
        } catch (error) {
            context.warnings.push({
                code: APP_DEPLOY_WARNING_SMOKE_UNAVAILABLE,
                message: `The public smoke run could not be made: ${messageOf(error)}`,
            });

            return null;
        }
    }

    /**
     * §5.6 step 4 / APW06-G05 — `hooks.isCancelled()` reads the flags T17 carries: a cancel request,
     * a quarantine (`deletionRequestedAt`, R-20) and a pause.
     */
    private async isCancelled(workId: string): Promise<boolean> {
        const state = await this.readState(workId);
        if (!state) return false;

        return (
            isSet(state.cancelRequestedAt) ||
            isSet(state.deletionRequestedAt) ||
            state.paused === true ||
            isSet(state.pausedAt)
        );
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 6 — the runtime state
     * ---------------------------------------------------------------------- */

    private async recordRuntimeState(
        context: RunContext,
        access: AppDeployClusterAccess,
        result: AppDeployResult,
        state: AppDeploymentState,
    ): Promise<void> {
        if (!this.runtimeStates?.patchRuntimeState) return;

        const ready = state === 'READY';
        const ip = text(result.ingressAddress?.ip);
        const hostname = text(result.ingressAddress?.hostname);
        const fingerprint = text(
            (access.ref as { clusterFingerprint?: string | null } | undefined)?.clusterFingerprint,
        );

        try {
            await this.runtimeStates.patchRuntimeState(context.workId, {
                // §5.6 step 6 — "`currentDeploymentId` (on READY)".
                ...(ready ? { currentDeploymentId: context.deploymentId } : {}),
                // "`firstDeployJobsCompletedAt` + `clusterFingerprint`".
                ...(result.firstDeployJobsCompleted === true
                    ? { firstDeployJobsCompletedAt: new Date().toISOString() }
                    : {}),
                ...(fingerprint ? { clusterFingerprint: fingerprint } : {}),
                ...(ip || hostname ? { ingressAddress: { ip, hostname } } : {}),
                // §5.6 step 6 names `namespace`; §9.9's ref is where it is decided.
                ...(text(access.ref?.namespace) ? { namespace: text(access.ref?.namespace) } : {}),
                ...(result.isolationEnforced === null || result.isolationEnforced === undefined
                    ? {}
                    : { isolationEnforced: result.isolationEnforced === true }),
            });
        } catch (error) {
            this.logger.warn(
                `Recording the App runtime state of Work ${context.workId} failed (` +
                    `${messageOf(error)}).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 7 — the lock and the queue
     * ---------------------------------------------------------------------- */

    /** T17's `releaseDeployLock`, guarded: an absent or throwing store must not fail the run. */
    private async releaseLock(context: RunContext): Promise<boolean> {
        if (!context.workId || !context.deploymentId) return false;

        if (!this.runtimeStates?.releaseDeployLock) {
            this.logger.warn(
                `No App runtime-state store is bound, so the deploy lock of ` +
                    `${context.deploymentId} could not be released in this process.`,
            );

            return false;
        }

        try {
            await this.runtimeStates.releaseDeployLock(context.workId, context.deploymentId);

            return true;
        } catch (error) {
            this.logger.error(
                `Releasing the App deploy lock of ${context.deploymentId} failed (` +
                    `${messageOf(error)}).`,
            );

            return false;
        }
    }

    /**
     * §5.6 step 7 — "if `queuedBuildId` → request a new Deployment for it", realized as T24's
     * compare-and-set followed by a dispatch: the queued row **already exists** (T24 created it with
     * `INITIALIZING` and wrote `queuedDeploymentId` + `queuedBuildId` in one call), so requesting a
     * second row would abandon it. Taking the queue and dispatching the row it handed back is what
     * makes "at most 1 is queued" survive the finish.
     */
    private async dequeue(
        context: RunContext,
    ): Promise<{ queuedDeploymentId: string | null; queuedBuildId: string | null }> {
        const empty = { queuedDeploymentId: null, queuedBuildId: null };
        if (!context.workId || !this.runtimeStates?.takeQueued) return empty;

        let taken: { queuedDeploymentId?: string | null; queuedBuildId?: string | null } | null;
        try {
            taken = (await this.runtimeStates.takeQueued(context.workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the queued App Deployment of Work ${context.workId} failed (` +
                    `${messageOf(error)}).`,
            );

            return empty;
        }

        const queuedDeploymentId = text(taken?.queuedDeploymentId);
        const queuedBuildId = text(taken?.queuedBuildId);

        if (!queuedDeploymentId) return empty;

        const runtime = this.deployRuntime();

        if (!runtime?.dispatchAppDeploy) {
            this.logger.warn(
                `The queued App Deployment ${queuedDeploymentId} of Work ${context.workId} was ` +
                    'adopted but no dispatcher is available in this process.',
            );

            return { queuedDeploymentId, queuedBuildId };
        }

        try {
            await runtime.dispatchAppDeploy({
                workId: context.workId,
                deploymentId: queuedDeploymentId,
                trigger: 'build',
                buildId: queuedBuildId,
                specCommitSha: null,
            });
        } catch (error) {
            this.logger.warn(
                `Dispatching the queued App Deployment ${queuedDeploymentId} failed (` +
                    `${messageOf(error)}).`,
            );
        }

        return { queuedDeploymentId, queuedBuildId };
    }

    private deployRuntime(): AppDeployOrchestratorDispatcher | null {
        const provider = this.dispatchers;
        if (!provider) return null;

        try {
            if (typeof provider.isEnabled === 'function' && provider.isEnabled() === false) {
                return null;
            }

            const resolved = typeof provider.resolve === 'function' ? provider.resolve() : provider;

            return typeof (resolved as AppDeployOrchestratorDispatcher)?.dispatchAppDeploy ===
                'function'
                ? (resolved as AppDeployOrchestratorDispatcher)
                : null;
        } catch {
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 9 — the upstream-sync verdict
     * ---------------------------------------------------------------------- */

    /**
     * §5.6:838-849, case by case:
     *
     * - a rollback Deployment ⇒ skip;
     * - no reader bound, an unreadable row, or `lastSyncToSha` null ⇒ skip;
     * - the Deployment's commit counts as "from the sync" when it equals `lastSyncToSha`, or when
     *   `isAncestorCommit(owner, repo, lastSyncToSha, commitSha)` is `true` — `null` and an unbound
     *   seam mean equality only;
     * - when it counts and `upstreamSyncJudgedToSha !== lastSyncToSha`: set the column **whether the
     *   Deployment passed or failed**, and call `smokeFailedAfterUpstreamSync` **only** when this
     *   Deployment emitted `app.smoke.failed` — an in-cluster failure ending `ROLLED_BACK`/`ERROR`,
     *   or a public `check_failed`. `dns_not_pointing`, `tls_not_ready` and `unreachable` are
     *   warnings and do not count; a rollout or probe failure with no smoke run does not count.
     */
    private async judgeUpstreamSync(
        context: RunContext,
        request: AppDeployOrchestratorRequest,
        result: AppDeployResult,
        smoke: { emitted: boolean; healthRelevant: boolean },
    ): Promise<AppUpstreamSyncVerdict> {
        void result;

        const skip = (reason: string, toSha: string | null = null): AppUpstreamSyncVerdict => ({
            status: 'skipped',
            reason,
            lastSyncToSha: toSha,
            reported: false,
        });

        if (request?.isRollback === true) return skip('rollback');
        if (!this.upstream?.findByWorkId) return skip('no_reader');

        let row: AppUpstreamStateView | null;
        try {
            row = (await this.upstream.findByWorkId(context.workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the upstream state of Work ${context.workId} failed (${messageOf(error)}).`,
            );

            return skip('threw');
        }

        const toSha = text(row?.lastSyncToSha);
        if (!toSha) return skip('no_sync');

        const inRange = await this.isFromSync(context.commitSha, toSha, row);
        if (!inRange) return skip('not_from_sync', toSha);

        const state = await this.readState(context.workId);
        if (text(state?.upstreamSyncJudgedToSha) === toSha) {
            return {
                status: 'already-judged',
                reason: null,
                lastSyncToSha: toSha,
                reported: false,
            };
        }

        await this.recordJudgedSha(context.workId, toSha);

        if (!smoke.emitted || !smoke.healthRelevant) {
            return { status: 'judged', reason: null, lastSyncToSha: toSha, reported: false };
        }

        try {
            await this.provisionEvents?.smokeFailedAfterUpstreamSync?.(
                context.workId,
                text(row?.lastSyncFromSha),
                toSha,
            );
        } catch (error) {
            this.logger.warn(
                `Reporting the upstream smoke failure of Work ${context.workId} failed (` +
                    `${messageOf(error)}).`,
            );

            return { status: 'judged', reason: null, lastSyncToSha: toSha, reported: false };
        }

        return { status: 'judged', reason: null, lastSyncToSha: toSha, reported: true };
    }

    /** §5.6:841-843 — equality, or `isAncestorCommit` when the seam answers a boolean. */
    private async isFromSync(
        commitSha: string | null,
        toSha: string,
        row: AppUpstreamStateView | null,
    ): Promise<boolean> {
        if (!commitSha) return false;
        if (commitSha === toSha) return true;
        if (!this.ancestry?.isAncestorCommit) return false;

        const owner = text(row?.upstreamOwner);
        const repo = text(row?.upstreamRepo);
        if (!owner || !repo) return false;

        try {
            return (await this.ancestry.isAncestorCommit(owner, repo, toSha, commitSha)) === true;
        } catch (error) {
            this.logger.warn(
                `isAncestorCommit(${toSha}, ${commitSha}) failed (${messageOf(
                    error,
                )}); the verdict falls back to equality only.`,
            );

            return false;
        }
    }

    private async recordJudgedSha(workId: string, sha: string): Promise<void> {
        if (!this.runtimeStates?.setUpstreamSyncJudgedToSha) return;

        try {
            await this.runtimeStates.setUpstreamSyncJudgedToSha(workId, sha);
        } catch (error) {
            this.logger.warn(
                `Recording the judged upstream sha for Work ${workId} failed (${messageOf(error)}).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.4 — the events
     * ---------------------------------------------------------------------- */

    private async emit(
        context: RunContext,
        name: string,
        payload: Record<string, unknown>,
    ): Promise<void> {
        context.emitted.push(name);

        if (!this.events?.emit) return;

        try {
            // §9.4:1307 — "never values or log text".
            await this.events.emit({ name, payload: compact(payload) });
        } catch (error) {
            this.logger.warn(`Emitting ${name} failed (${messageOf(error)}).`);
        }
    }

    /** §9.4:1308-1309 — "`app.job.*` in execution order", from the finished result. */
    private async emitJobEvents(
        context: RunContext,
        request: AppDeployOrchestratorRequest,
        result: AppDeployResult,
    ): Promise<void> {
        for (const job of result.jobs ?? []) {
            // A `running` job is not an outcome: §9.4's family has only succeeded/failed, and a job
            // still running when the Deployment ended is reported by the next status read.
            if (job.status === 'running') continue;

            await this.emit(
                context,
                job.status === 'succeeded' ? APP_EVENT_JOB_SUCCEEDED : APP_EVENT_JOB_FAILED,
                {
                    workId: context.workId,
                    userId: text(request?.userId),
                    deploymentId: context.deploymentId,
                    buildId: text(request?.buildId),
                    names: [text(job.name)],
                    code: text(job.status),
                },
            );
        }
    }

    /**
     * §9.4:1309-1311 — the `app.smoke.passed | failed` event "summarising the smoke results
     * recorded on that Deployment", emitted after the terminal event. `emitted` says whether the
     * **failure** event was written — which is what §5.6 step 9 reads — and `healthRelevant` whether
     * it was a `check_failed` rather than one of the three warnings.
     */
    private async emitSmokeEvent(
        context: RunContext,
        request: AppDeployOrchestratorRequest,
        result: AppDeployResult,
    ): Promise<{ emitted: boolean; healthRelevant: boolean }> {
        const smoke = result.smoke ?? null;
        const inCluster = [...(smoke?.inCluster ?? [])];
        const publicly = [...(smoke?.public ?? [])];
        const failedInCluster = inCluster.some((check) => check.status === 'failed');
        const publicRun = context.publicSmoke;
        const publicFailure =
            publicRun?.healthRelevant === true ||
            (publicRun?.failures?.length ?? 0) > 0 ||
            publicly.some((check) => check.classification === 'check_failed');
        const failed = failedInCluster || publicFailure;
        const warningOnly =
            !failed &&
            (publicly.some((check) => check.status === 'failed') ||
                (publicRun?.warnings?.length ?? 0) > 0);

        const names = [
            ...inCluster.filter((check) => check.status === 'failed').map((check) => check.name),
            ...publicly.filter((check) => check.status === 'failed').map((check) => check.name),
        ];

        await this.emit(context, failed ? APP_EVENT_SMOKE_FAILED : APP_EVENT_SMOKE_PASSED, {
            workId: context.workId,
            userId: text(request?.userId),
            deploymentId: context.deploymentId,
            buildId: text(request?.buildId),
            names,
            ...(warningOnly ? { code: 'smoke_warnings' } : {}),
        });

        return { emitted: failed, healthRelevant: failed };
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 7a — the notifications
     * ---------------------------------------------------------------------- */

    private async notify(
        context: RunContext,
        request: AppDeployOrchestratorRequest,
        result: AppDeployResult,
        state: AppDeploymentState,
    ): Promise<void> {
        const userId = text(request?.userId);
        const deploymentId = text(request?.deploymentId);
        if (!userId || !deploymentId || !this.notifications) return;

        try {
            if (result.outcome === 'rollback-failed') {
                // ACC-06-24 / §9.4:1336 — the urgent `app_rollback_failed` producer.
                await this.notifications.notifyAppRollbackFailed?.({
                    userId,
                    workId: context.workId,
                    deploymentId,
                });

                return;
            }

            if (state === 'ERROR' && result.outcome !== 'cancelled') {
                await this.notifications.notifyAppDeployFailed?.({
                    userId,
                    workId: context.workId,
                    deploymentId,
                    code: result.failure?.code ?? null,
                });
            }
        } catch (error) {
            this.logger.warn(
                `Notifying about the App Deployment ${deploymentId} failed (${messageOf(error)}).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * The guarded reads and writes
     * ---------------------------------------------------------------------- */

    private async readState(workId: string): Promise<AppDeployOrchestratorStateView | null> {
        if (!this.runtimeStates?.getOrCreate) return null;

        try {
            return (await this.runtimeStates.getOrCreate(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the App runtime state of Work ${workId} failed (${messageOf(error)}).`,
            );

            return null;
        }
    }

    private async patchDeployment(context: RunContext, patch: AppDeployRowUpdate): Promise<void> {
        if (!this.deployments?.update || !context.workId || !context.deploymentId) return;

        try {
            await this.deployments.update(context.workId, context.deploymentId, patch);
        } catch (error) {
            this.logger.warn(
                `Updating the App Deployment ${context.deploymentId} failed (` +
                    `${messageOf(error)}).`,
            );
        }
    }

    /**
     * The one place an `ERROR` is written, so `state`/`code`/`reason` cannot disagree. It also
     * records the row — unless the caller already did, which is the precondition path where
     * `appRender.preconditions` has to be written in the same update as the state.
     */
    private async failRun(
        context: RunContext,
        result: AppDeployOrchestratorResult,
        code: string,
        reason: string,
        opts: { alreadyPatched?: boolean } = {},
    ): Promise<void> {
        result.state = 'ERROR';
        result.code = text(code) || APP_DEPLOY_CODE_WORKER_FAILED;
        result.reason = truncate(reason, APP_DEPLOY_LAST_ERROR_MAX_CHARS);

        if (opts.alreadyPatched) return;

        await this.patchDeployment(context, {
            state: result.state,
            completedAt: new Date().toISOString(),
            lastError: result.reason,
        });
    }
}

/* -------------------------------------------------------------------------- *
 * The outcome table — §5.6 step 5
 * -------------------------------------------------------------------------- */

/** The `failure` block of `AppDeployResult`, as this file reads it (`app-deployment.types.ts:499-504`). */
interface AppDeployFailureView {
    phase?: AppDeployPhase | null;
    code?: string | null;
    message?: string | null;
}

/** §5.6 step 5's rows, as one function so the mapping has exactly one home. */
export function mapOutcome(result: AppDeployResult | null): {
    state: AppDeploymentState;
    code: string | null;
    reason: string | null;
} {
    const outcome = result?.outcome;
    const failure = (result?.failure ?? null) as AppDeployFailureView | null;

    switch (outcome) {
        case 'succeeded':
            return { state: 'READY', code: null, reason: null };
        case 'succeeded-with-warnings':
            // `READY` + `appRender.warnings` — "Live with warnings" is not a state of its own
            // (`packages/contracts/src/apps/app-runtime.ts:184-189`).
            return { state: 'READY', code: null, reason: null };
        case 'rolled-back':
            return {
                state: 'ROLLED_BACK',
                code: failureCode(failure),
                reason: failureReason(failure),
            };
        case 'cancelled':
            // APW06-G05 — `CANCELED`, and `appRender.cancelledBy` carries the reason (§5.6 step 5).
            return {
                state: 'CANCELED',
                code: failureCode(failure),
                reason: failureReason(failure),
            };
        case 'rollback-failed':
            // There is no `ROLLBACK_FAILED` member in `APP_DEPLOYMENT_STATES`
            // (`packages/contracts/src/apps/app-runtime.ts:143-155`); `ERROR` is what §5.6:826 lists
            // for it, and the failure code carries the distinction (`rollback_failed`).
            return {
                state: 'ERROR',
                code: failureCode(failure) || 'rollback_failed',
                reason: failureReason(failure),
            };
        default:
            return {
                state: 'ERROR',
                code: failureCode(failure) || APP_DEPLOY_CODE_WORKER_FAILED,
                reason: failureReason(failure) || 'the Deployment did not report an outcome',
            };
    }
}

/**
 * §5.6 step 5 / §9.4:1309 — the terminal event each outcome writes.
 *
 * `cancelled` maps to `app.deploy.failed` because §9.4's family is
 * `app.deploy.succeeded|failed|rolled_back` and names no cancellation event of its own; the
 * `cancelledBy` on `appRender` is what distinguishes it (APW06-G05).
 */
export function terminalEventName(outcome: string | null | undefined): string {
    switch (outcome) {
        case 'succeeded':
        case 'succeeded-with-warnings':
            return APP_EVENT_DEPLOY_SUCCEEDED;
        case 'rolled-back':
        case 'rollback-failed':
            return APP_EVENT_DEPLOY_ROLLED_BACK;
        default:
            return APP_EVENT_DEPLOY_FAILED;
    }
}

/** `true` ⇔ this state is one of `isTerminal()`'s (`work-deployment.entity.ts:108`). */
export function isTerminalState(state: string | null | undefined): boolean {
    return (APP_DEPLOYMENT_TERMINAL_STATES as readonly string[]).includes(String(state ?? ''));
}

/** APW06-G05 — the `appRender.cancelledBy` value a result carries, when it carries one. */
export function cancelReasonOf(result: AppDeployResult | null): AppCancelReason | null {
    return (result?.cancelReason as AppCancelReason | undefined) ?? null;
}

function failureCode(failure: AppDeployFailureView | null): string | null {
    return text(failure?.code);
}

function failureReason(failure: AppDeployFailureView | null): string | null {
    const message = text(failure?.message);

    return message ? truncate(message, APP_DEPLOY_LAST_ERROR_MAX_CHARS) : null;
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function truncate(value: string | null, max: number): string | null {
    const trimmed = text(value);

    return trimmed && trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** `true` ⇔ the column carries a timestamp rather than `null`/empty. */
function isSet(value: Date | string | number | null | undefined): boolean {
    if (value === null || value === undefined) return false;
    if (value instanceof Date) return !Number.isNaN(value.getTime());

    return String(value).trim().length > 0;
}

/** §9.4:1307 — the payload's own keys only; `undefined` never leaves as a key. */
function compact(payload: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
        if (value === undefined) continue;
        out[key] = value;
    }

    return out;
}
