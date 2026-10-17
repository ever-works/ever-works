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
    eligibility?: { managed?: { eligible: boolean; reasons?: string[] } } | null;
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
