/**
 * APW-06 T36 — the App runtime view types and the pure helpers both sides of
 * the Deploy tab need.
 *
 * Deliberately NOT `server-only` and NOT `'use client'`: the server page
 * (`works/[id]/deploy/page.tsx`) calls {@link deriveAppTargetFromProvider} in
 * its render body, and the client components under
 * `components/works/detail/deploy/app/` read the same types. A plain function a
 * server component calls must never come from a `'use client'` module (it would
 * receive a client reference instead of the function).
 *
 * **No kubeconfig and no env value appears in any type here** (T36,
 * ACC-06-56): the kubeconfig travels once, write-only, through
 * `checkAppTarget`, and nothing the API answers ever carries it back.
 */

import type { AppClusterCheck } from '@ever-works/plugin';
import {
    APP_DEPLOY_TARGET_CHOICES,
    APP_PRECONDITION_MESSAGE_LEAVES,
    type AppDeployTargetChoice,
    type AppPreconditionCode,
    type AppRuntimeState,
} from '@ever-works/contracts';

/** The four TLS choices of plan §7.2 `targetSettings.tls`. */
export const APP_TARGET_TLS_MODES = ['cert-manager', 'external', 'edge', 'none'] as const;
export type AppTargetTlsMode = (typeof APP_TARGET_TLS_MODES)[number];

/**
 * `targetSettings` (plan §7.2) as the web reads and writes it. Every field is
 * optional on the wire; the API owns the defaults.
 */
export interface AppTargetSettingsView {
    namespaceOverride?: string;
    ingressClass?: string;
    controllerNamespace?: string;
    tls?: AppTargetTlsMode;
    issuer?: string;
    storageClass?: string;
    networkIsolation?: boolean;
    allowRoot?: boolean;
    managedSubdomain?: boolean;
    primaryDomain?: string;
    autoDeploy?: boolean;
    previews?: boolean;
}

/** `AppClusterCheck` — secret-free by construction (plan §6.3). */
export type AppClusterCheckView = AppClusterCheck;

/**
 * `GET /api/works/:id/app-target` (plan §9.1 "Response shapes"), plus one field
 * of our own: `routeAvailable` is `false` when the route answered `404` and the
 * target was derived from `work.deployProvider` instead — the route is APW-06
 * T33's and may not be deployed yet.
 */
export interface AppTargetView {
    target: AppDeployTargetChoice;
    settings: AppTargetSettingsView | null;
    namespace: string | null;
    clusterCheck: AppClusterCheckView | null;
    clusterCheckedAt: string | null;
    /** APW-03 hosting eligibility, read and never stored (R-3). Opaque here. */
    eligibility?: {
        managed?: {
            eligible: boolean;
            reasons?: string[];
            /** Owner decision 2026-10-27: a free owner at the cap, whom a paid plan would admit. */
            paidPlanAllowsMore?: boolean;
        };
    } | null;
    routeAvailable: boolean;
}

/** `GET /api/works/:id/app-status` — the fields the Deploy tab renders. */
export interface AppStatusView {
    state: AppRuntimeState;
    target: AppDeployTargetChoice;
    stale: boolean;
    observedAt: string | null;
    url: string | null;
    sourceOffer: { url: string } | null;
    currentDeployment: { id: string; state: string; phase?: string } | null;
    /** Recent runtime operations, newest first (lane aw-deploy-3); absent on an older API. */
    ops?: AppStatusOpView[];
    /** Lane aw-ops — the published hosts of the live Deployment. */
    hosts?: { primary: string | null; extra: string[] };
    /** Lane aw-ops — the worker's last observation of the cluster (FR-46); `null` before one. */
    snapshot?: AppStatusSnapshotView | null;
    /** Lane aw-ops — ops queued from the Deploy tab in the last 5 minutes; absent on an older API. */
    requests?: AppStatusRequestView[];
    /** Lane aw-ops — the live Deployment's latest smoke checks; absent on an older API. */
    smoke?: AppSmokeView | null;
}

/* -------------------------------------------------------------------------- *
 * Lane aw-ops (2026-10-27) — the live App's operations (plan §9.1, §10.2)
 * -------------------------------------------------------------------------- */

/** One component of the snapshot (`AppComponentStatus`). */
export interface AppComponentStatusView {
    name: string;
    role: 'web' | 'worker';
    desired: number;
    ready: number;
    restarts: number;
    lastTerminationReason?: string;
    oomKilledAt?: string | null;
}

/** One job's last run (`AppJobResult`), as the snapshot carries it. */
export interface AppJobRunView {
    name: string;
    when: 'pre-deploy' | 'first-deploy' | 'post-deploy';
    runName: string;
    status: 'succeeded' | 'failed' | 'timeout' | 'running';
    startedAt: string;
    completedAt?: string;
    exitCode?: number;
}

/** `GET app-status`'s `snapshot` (`AppStatusSnapshot`, plan §3.1) — names, counts and times. */
export interface AppStatusSnapshotView {
    observedAt: string;
    components: AppComponentStatusView[];
    jobs: Array<{ name: string; last?: AppJobRunView }>;
    cron: Array<{
        name: string;
        lastScheduleAt?: string;
        lastSuccessAt?: string;
        lastResult?: string;
    }>;
    isolationEnforced: boolean | null;
}

/** One smoke check — never a response excerpt. */
export interface AppSmokeCheckView {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    httpStatus?: number;
    latencyMs?: number;
    failedExpectation?: string;
    classification?: string;
}

/** The live Deployment's smoke result. */
export interface AppSmokeView {
    deploymentId: string;
    observedAt: string | null;
    inCluster: AppSmokeCheckView[];
    public: AppSmokeCheckView[];
    hairpin: AppSmokeCheckView | null;
}

/** The ops the Deploy tab queues. */
export type AppOpsRequestKind = 'status-refresh' | 'logs' | 'job-run' | 'smoke';

/** One `requests[]` entry of `GET app-status`. */
export interface AppStatusRequestView {
    requestId: string;
    op: string;
    state: 'queued' | 'running' | 'done' | 'failed';
    at: string;
    code?: string;
    jobName?: string;
}

/** The `202` a queued op answers. */
export interface AppOpsAcceptedView {
    status: 'accepted';
    op: AppOpsRequestKind;
    requestId: string;
    dispatched: boolean;
}

/** `POST app-logs`'s body. */
export interface AppLogsRequestInput {
    component?: string;
    job?: string;
    deploymentId?: string;
    previous?: boolean;
    lines?: number;
}

/** A redacted log tail (`AppLogTail`, FR-48). */
export interface AppLogTailView {
    containers: Array<{ pod: string; container: string; lines: string[]; truncated: boolean }>;
    redactedNames: string[];
    fetchedAt: string;
}

/** `GET app-logs/:requestId`. */
export interface AppLogsReadView {
    requestId: string;
    status: 'pending' | 'ready' | 'failed';
    tail?: AppLogTailView;
    code?: string;
}

/** One row of `GET app-deployments`. */
export interface AppDeploymentHistoryView {
    id: string;
    state: string;
    trigger: string | null;
    buildId: string | null;
    commitSha: string | null;
    imageDigest: string | null;
    createdAt: string | null;
    completedAt: string | null;
    current: boolean;
    code: string | null;
    smoke: { passed: number; failed: number; observedAt: string | null } | null;
}

/** What every browser call to the App runtime BFF answers. */
export interface AppOpsResult<T> {
    ok: boolean;
    /** The HTTP status; `0` for a transport fault. */
    status: number;
    data?: T;
    code?: string;
    message?: string;
    /** A `429`'s wait, in whole seconds. */
    retryAfterSeconds?: number;
}

/** One `GET app-status` `ops` entry — ids, states and timestamps only. */
export interface AppStatusOpView {
    kind: 'deploy' | 'rollback' | 'pause' | 'remove' | 'delete';
    state: 'running' | 'done' | 'failed' | 'cancelled';
    at: string | null;
    deploymentId?: string;
    trigger?: string;
    code?: string;
}

/** The actions `POST /api/works/:id/app-lifecycle` accepts. */
export const APP_LIFECYCLE_ACTIONS = ['pause', 'resume', 'remove', 'cancel-deploy'] as const;
export type AppLifecycleActionChoice = (typeof APP_LIFECYCLE_ACTIONS)[number];

/** `POST /api/works/:id/app-lifecycle`'s `202` body. */
export interface AppLifecycleView {
    status: 'accepted';
    action: AppLifecycleActionChoice;
    requestId: string;
    dispatched: boolean;
}

/**
 * The earlier Live Deployments a rollback may return to: every `ops` deploy or rollback
 * that went live, except the one running now, newest first.
 */
export function rollbackCandidates(status: AppStatusView | null | undefined): AppStatusOpView[] {
    const current = status?.currentDeployment?.id ?? null;
    const seen = new Set<string>();
    return (status?.ops ?? []).filter((op) => {
        if (op.kind !== 'deploy' && op.kind !== 'rollback') return false;
        if (op.state !== 'done' || !op.deploymentId || op.deploymentId === current) return false;
        if (seen.has(op.deploymentId)) return false;
        seen.add(op.deploymentId);
        return true;
    });
}

/** One `{ code, message }` entry of the deploy answer's lists. */
export interface AppDeployNotice {
    code: string;
    message: string;
}

/**
 * `POST /api/works/:id/deploy` — the controller's answer for every status
 * (`apps/api/src/works/work-app-deploy.controller.ts`): 202, 409, 422, 503.
 */
export interface AppDeployRequestView {
    status?: string;
    code?: string | null;
    deploymentId?: string | null;
    queuedDeploymentId?: string | null;
    runningDeploymentId?: string | null;
    dispatched?: boolean;
    deduplicated?: boolean;
    unmet: AppDeployNotice[];
    advisory: AppDeployNotice[];
    warnings: AppDeployNotice[];
}

/** What every App runtime server action answers. */
export interface AppRuntimeActionResult<T = undefined> {
    success: boolean;
    data?: T;
    error?: string;
    /** The API's code, or `route_unavailable` when the route answered 404. */
    code?: string;
    httpStatus?: number;
    unmet?: AppDeployNotice[];
}

/** The code an action reports when the App runtime route is not deployed. */
export const APP_RUNTIME_ROUTE_UNAVAILABLE = 'route_unavailable';

/**
 * Works-security (2026-10-18) — the code the API's `403` carries when an App Works action is the
 * Work OWNER's alone (`apps/api/src/works/app-owner-gate.ts`): connecting a cluster or changing
 * its context, changing the target or its namespace, confirming a cluster credential another
 * member saved (a Deploy / Roll back), Remove with stored data, and a dependency's Delete data.
 *
 * The switches behind these are the operator's (default on), so the web never assumes the
 * refusal: it renders it — "Only the Work owner can do this." — when it comes back. The owner's
 * own API key gets a `403` too, but without this code ("Only a person signed in to Ever Works
 * can …"); that sentence is shown as the API wrote it.
 */
export const APP_OWNER_REQUIRED_CODE = 'ownerRequired';

/** Whether an action's answer is the owner-only refusal ({@link APP_OWNER_REQUIRED_CODE}). */
export function isAppOwnerRequired(result: { code?: string | null } | null | undefined): boolean {
    return result?.code === APP_OWNER_REQUIRED_CODE;
}

/**
 * The target an App Work has when the API cannot tell us (its `app-target`
 * route answered 404): derived once from the persisted `deployProvider`, the
 * same rule as plan §9.1's `deriveInitialAppTarget` (FR-63) —
 * nothing ⇒ `none`, the managed provider ⇒ `ever-works-apps`, any other
 * deployment plugin (e.g. `k8s`) ⇒ `your-cluster`.
 */
export function deriveAppTargetFromProvider(
    deployProvider: string | null | undefined,
): AppDeployTargetChoice {
    const provider = (deployProvider ?? '').trim();
    if (!provider) return 'none';
    if (provider === 'ever-works' || provider === 'ever-works-apps' || provider === 'apps-tier') {
        return 'ever-works-apps';
    }
    return 'your-cluster';
}

/** Fail-closed guard for a target string off the wire. */
export function isAppDeployTargetChoice(value: unknown): value is AppDeployTargetChoice {
    return (
        typeof value === 'string' &&
        (APP_DEPLOY_TARGET_CHOICES as readonly string[]).includes(value)
    );
}

/**
 * The `dashboard.workDetail.appDeploy.preconditions.<leaf>` leaf for an unmet
 * precondition code, or `null` for a code this build of the web does not know
 * (the caller then shows the API's own message).
 */
export type AppPreconditionLeaf = (typeof APP_PRECONDITION_MESSAGE_LEAVES)[AppPreconditionCode];

export function appPreconditionLeaf(code: string): AppPreconditionLeaf | null {
    return Object.prototype.hasOwnProperty.call(APP_PRECONDITION_MESSAGE_LEAVES, code)
        ? APP_PRECONDITION_MESSAGE_LEAVES[code as AppPreconditionCode]
        : null;
}

/** Whether a cluster check lets the member save the target (S2). */
export function clusterCheckAllowsSave(check: AppClusterCheckView | null | undefined): boolean {
    return Boolean(check && check.ok && !check.error && check.missingPermissions.length === 0);
}
