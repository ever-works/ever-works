/**
 * APW-06 T33 (lane aw-deploy-2, 2026-10-17) — **the App target and status routes' service** (plan
 * §9.1): `GET`/`PUT :id/app-target`, `POST :id/app-target/check` and `GET :id/app-status`.
 *
 * Runs in the **API** process and never dials a cluster: the kubeconfig is stored write-only and
 * the check itself is an `app-cluster-op { op: 'cluster-check' }` the isolated worker runs (§6.2,
 * APW06-G01). The controller (`apps/api/src/works/work-app-runtime.controller.ts`) resolves access
 * first; everything here assumes an App Work the caller may see (`view`) or edit (`edit`).
 *
 * ## 🛑 The kubeconfig rule (ACC-06-56)
 *
 * `check` writes the pasted kubeconfig as the Work-scoped `x-secret` of the your-cluster deployment
 * plugin through `PluginSettingsService.writePlatformManagedWorkSettings`, which encrypts it,
 * validates nothing and connects to nothing — never through
 * `PATCH /api/works/:workId/plugins/:pluginId/settings`, whose connection validation would dial the
 * pasted cluster from the API before §6.1's guard runs. No method here returns it, logs it, or puts
 * it in a dispatch payload.
 *
 * ## The answers (plan §9.1 "Response shapes", the web's `app-runtime.types.ts`)
 *
 * - `getTarget` → `{ target, settings, namespace, clusterCheck, clusterCheckedAt, eligibility }`.
 * - `putTarget` → the same, or a refusal `{ httpStatus: 422, code: 'APP_TARGET_REFUSED', unmet }` /
 *   `{ httpStatus: 409, code: 'APP_WORK_DELETING' }`.
 * - `check` → `{ httpStatus: 202, requestId, dispatched }`, or `413 kubeconfig_too_large` /
 *   `422 your_cluster_plugin_unavailable`.
 * - `getStatus` → `{ state, target, stale, observedAt, url, hosts, sourceOffer, currentDeployment,
 *   snapshot, ops }`.
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AppDeployTarget, AppPrecondition, AppRuntimeState } from '@ever-works/contracts';
import {
    isAppDeploymentPlugin,
    PLUGIN_CAPABILITIES,
    type IDeploymentPlugin,
} from '@ever-works/plugin';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { WorkDeploymentRepository } from '../database/repositories/work-deployment.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import type {
    AppRuntimeIngressAddress,
    AppRuntimeTargetSettings,
} from '../entities/work-app-runtime-state.entity';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import type { AppClusterOpDispatchGate } from './app-deploy-dispatcher.provider';
import { APP_CLUSTER_OP_DISPATCHER } from './app-runtime-deletion.service';
import { APPS_TIER_POLICY, type AppsTierPolicy } from './ports';
import { AppsDomainDnsServiceImpl } from '../ever-works-providers/apps-domain-dns.service';
import { AppDeployRequestService, type AppDeployRequestResult } from './app-deploy-request.service';
import { AppLicenseGate } from './app-license-gate';
import { clusterCredentialNeedsOwnerConfirmation } from './app-owner-gates';
import type { AppClusterCredentialProvenance } from '../entities/work-app-runtime-state.entity';
import type { AppLogTail } from '@ever-works/plugin';
import { CACHE_MANAGER, type Cache } from '../cache';
import { APP_RUNTIME_ENV_SOURCE } from './ports';
import {
    APP_OP_CACHE_TTL_MS,
    appLogsCacheKey,
    appOpCacheKey,
} from './app-lifecycle-ops.service';
import { redactAppLogTail } from './app-log-redaction';

/**
 * Works-security (2026-10-18) — the save-time kubeconfig shape check (`POST app-target/check`):
 * ON unless exactly `false`. The same switch gates the k8s plugin's dependency-path guard.
 */
export const APP_GUARD_DEPENDENCY_KUBECONFIG_ENV = 'EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG';

function guardKubeconfigOnSave(): boolean {
    return (
        String(process.env[APP_GUARD_DEPENDENCY_KUBECONFIG_ENV] ?? '')
            .trim()
            .toLowerCase() !== 'false'
    );
}

/** What `PUT app-target` would change that only the owner may (`pendingTargetChange`). */
export interface AppTargetPendingChange {
    targetChanges: boolean;
    namespaceChanges: boolean;
}

/** Who is saving a cluster credential — recorded as provenance (`app-owner-gates.ts`). */
export interface AppTargetCredentialActor {
    isOwner?: boolean;
}

/** The optional pure shape check a your-cluster plugin offers (`KubernetesPlugin`). */
interface ClusterCredentialShapeCheck {
    checkClusterCredentialShape?: (
        kubeconfig: string,
        kubeContext?: string,
    ) => { ok: true } | { ok: false; code?: string; message?: string };
}

/** The managed tier's capability (`facades/app-runtime.facade.ts` `APP_TIER_CAPABILITY`). */
const APP_TIER_CAPABILITY = 'apps-tier';

/** §9.1: `kubeconfig?: string (≤ 64 KiB)`. */
export const APP_TARGET_KUBECONFIG_MAX_BYTES = 64 * 1024;

/** A snapshot older than this is reported `stale` (the health poll runs every minute). */
export const APP_STATUS_STALE_MS = 3 * 60 * 1000;

/** The settings keys `PUT app-target` accepts, with their type (plan §7.2 `targetSettings`). */
const SETTINGS_STRING_KEYS = [
    'namespaceOverride',
    'ingressClass',
    'controllerNamespace',
    'issuer',
    'storageClass',
    'primaryDomain',
] as const;
const SETTINGS_BOOLEAN_KEYS = [
    'networkIsolation',
    'allowRoot',
    'managedSubdomain',
    'autoDeploy',
    'previews',
] as const;
const TLS_MODES = ['cert-manager', 'external', 'edge', 'none'] as const;
const TARGETS: readonly AppDeployTarget[] = ['none', 'your-cluster', 'ever-works-apps'];

/** The runtime-state row as this service reads and writes it. */
export interface AppTargetStateStore {
    getOrCreate(workId: string): Promise<AppTargetStateRow | null>;
    patchRuntimeState(
        workId: string,
        patch: { target?: AppDeployTarget; targetSettings?: AppRuntimeTargetSettings | null },
    ): Promise<unknown>;
}

/** The row's fields this service reads. */
export interface AppTargetStateRow {
    target?: string | null;
    targetSettings?: AppRuntimeTargetSettings | null;
    namespace?: string | null;
    clusterCheck?: unknown;
    clusterCheckedAt?: Date | string | null;
    /** The deployed cluster (plan §6.3) — read by the owner-confirmation rule. */
    clusterFingerprint?: string | null;
    currentDeploymentId?: string | null;
    paused?: boolean | null;
    pausedAt?: Date | string | null;
    removedAt?: Date | string | null;
    deletionRequestedAt?: Date | string | null;
    health?: string | null;
    statusSnapshot?: unknown;
    statusObservedAt?: Date | string | null;
    deployLockId?: string | null;
    ingressAddress?: AppRuntimeIngressAddress | null;
}

/** `GET app-target`'s body. */
export interface AppTargetBody {
    target: AppDeployTarget;
    settings: AppRuntimeTargetSettings | null;
    namespace: string | null;
    clusterCheck: unknown;
    clusterCheckedAt: string | null;
    eligibility: { managed: { eligible: boolean; reasons: string[] } } | null;
}

/** A refusal the controller answers verbatim. */
export interface AppTargetRefusal {
    httpStatus: number;
    code: string;
    message: string;
    unmet?: AppPrecondition[];
    /** Lane aw-ops — a `429`'s wait, in whole seconds (`POST app-status/refresh`). */
    retryAfterSeconds?: number;
}

/** `GET app-status`'s body. */
export interface AppStatusBody {
    state: AppRuntimeState;
    target: AppDeployTarget;
    stale: boolean;
    observedAt: string | null;
    url: string | null;
    hosts: { primary: string | null; extra: string[] };
    sourceOffer: { url: string } | null;
    currentDeployment: { id: string; state: string; phase?: string; cancelReason?: string } | null;
    snapshot: unknown;
    ops: AppStatusOpEntry[];
    /**
     * Lane aw-ops — the operations the Deploy tab queued in the last 5 minutes (refresh, job run,
     * smoke), newest first, read from the `app-op:` cache the worker overwrites (plan §2.3).
     */
    requests?: AppStatusRequestEntry[];
    /** Lane aw-ops — the live Deployment's latest smoke result (names and outcomes only). */
    smoke?: AppSmokeView | null;
}

/* -------------------------------------------------------------------------- *
 * Lane aw-ops (2026-10-27) — the Deploy tab's operations (plan §9.1)
 * -------------------------------------------------------------------------- */

/** The ops the Deploy tab queues, as the `app-cluster-op` router names them. */
export type AppOpsRequestKind = 'status-refresh' | 'logs' | 'job-run' | 'smoke';

/** The `202` every queued op answers. */
export interface AppOpsAccepted {
    ok: true;
    httpStatus: 202;
    op: AppOpsRequestKind;
    requestId: string;
    /** `false` ⇔ no isolated worker took it; the entry already reads `failed`. */
    dispatched: boolean;
}

/** `GET app-logs/:requestId` (plan §9.1 "Response shapes"). */
export interface AppLogsReadBody {
    requestId: string;
    status: 'pending' | 'ready' | 'failed';
    tail?: AppLogTail;
    code?: string;
}

/** One `requests[]` entry of `GET app-status`. */
export interface AppStatusRequestEntry {
    requestId: string;
    op: string;
    state: 'queued' | 'running' | 'done' | 'failed';
    at: string;
    code?: string;
    jobName?: string;
}

/** One smoke check as the Deploy tab shows it — no response body excerpt. */
export interface AppSmokeCheckView {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    httpStatus?: number;
    latencyMs?: number;
    failedExpectation?: string;
    classification?: string;
}

/** `work_deployments.smokeResult`, reduced to what a viewer may see (S28). */
export interface AppSmokeView {
    deploymentId: string;
    observedAt: string | null;
    inCluster: AppSmokeCheckView[];
    public: AppSmokeCheckView[];
    hairpin: AppSmokeCheckView | null;
}

/** One row of `GET app-deployments` — ids, states and times; never env, hosts' secrets or logs. */
export interface AppDeploymentHistoryEntry {
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

/** APW-07's `AppEnvRuntimeSource`, narrowed to the one read-only call the log read makes. */
export interface AppLogRedactionSource {
    secretValuesForRedaction?(
        workId: string,
        target?: AppDeployTarget,
    ): Promise<Record<string, string> | null>;
}

/** FR-46 — "Refresh is allowed once per 15 seconds", per Work. */
export const APP_STATUS_REFRESH_INTERVAL_MS = 15_000;

/** FR-48 — 200 lines by default, at most 500. */
export const APP_LOG_LINES_DEFAULT = 200;
export const APP_LOG_LINES_MAX = 500;

/** How many queued requests `GET app-status` remembers per Work (5 minutes of them). */
export const APP_OPS_REQUESTS_LIMIT = 10;

/** S28 / T39 — the history the Deploy tab lists. */
export const APP_DEPLOYMENT_HISTORY_LIMIT = 20;

/** A component or job name as the App spec declares one; anything else is refused before dispatch. */
const APP_RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The per-Work index of queued requests (the cache cannot be listed by prefix). */
export function appOpsRequestIndexKey(workId: string): string {
    return `app-op-index:${workId}`;
}

/** The FR-46 refresh gate. */
export function appStatusRefreshGateKey(workId: string): string {
    return `app-status-refresh:${workId}`;
}

/**
 * One entry of `GET app-status`'s `ops` (lane aw-deploy-3): the recent runtime operations, newest
 * first, read from the Deployment rows (deploys and rollbacks) and the runtime-state row (pause,
 * remove, deletion). Ids, states and timestamps only.
 */
export interface AppStatusOpEntry {
    kind: 'deploy' | 'rollback' | 'pause' | 'remove' | 'delete';
    state: 'running' | 'done' | 'failed' | 'cancelled';
    at: string | null;
    deploymentId?: string;
    trigger?: string;
    code?: string;
}

/** The lifecycle actions `POST app-lifecycle` accepts (plan §9.1). */
export const APP_LIFECYCLE_ACTIONS = ['pause', 'resume', 'remove', 'cancel-deploy'] as const;
export type AppLifecycleAction = (typeof APP_LIFECYCLE_ACTIONS)[number];

/** How many recent operations `app-status` reports. */
export const APP_STATUS_OPS_LIMIT = 10;

@Injectable()
export class AppTargetService {
    private readonly logger = new Logger(AppTargetService.name);

    constructor(
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: AppTargetStateStore,
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly deployments?: WorkDeploymentRepository,
        @Optional() private readonly registry?: PluginRegistryService,
        @Optional() private readonly settings?: PluginSettingsService,
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly ops?: AppClusterOpDispatchGate,
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tier?: AppsTierPolicy,
        // T48 — the managed label is allocated when a target is chosen, so the FIRST render
        // already carries `<label>.<apps domain>` (the record follows the live ingress address).
        @Optional() private readonly appsDns?: AppsDomainDnsServiceImpl,
        // Lane aw-deploy-3 — the rollback route asks for a Deployment through the one request path,
        // and the status reads the source offer through T21's licence gate.
        @Optional() private readonly requests?: AppDeployRequestService,
        @Optional() private readonly licenseGate?: AppLicenseGate,
        // Lane aw-ops (2026-10-27) — the 300 s cache the worker writes `app-op:` / `app-logs:`
        // entries to (the worker's CACHE_MANAGER proxies this one), and APW-07's env source for
        // the read-time log redaction (FR-48). Both appended, so existing positional specs build.
        @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
        @Optional()
        @Inject(APP_RUNTIME_ENV_SOURCE)
        private readonly envSource?: AppLogRedactionSource,
    ) {}

    /* ---------------------------------------------------------------------- *
     * GET app-target
     * ---------------------------------------------------------------------- */

    async getTarget(workId: string, userId: string): Promise<AppTargetBody> {
        const row = await this.readState(workId);
        return this.targetBody(row, userId, workId);
    }

    /* ---------------------------------------------------------------------- *
     * PUT app-target
     * ---------------------------------------------------------------------- */

    async putTarget(
        workId: string,
        userId: string,
        body: { target?: unknown; settings?: unknown },
    ): Promise<{ ok: true; body: AppTargetBody } | { ok: false; refusal: AppTargetRefusal }> {
        const target = TARGETS.find((choice) => choice === body?.target);
        if (!target) {
            return refuse(400, 'invalid_target', `target must be one of ${TARGETS.join(', ')}.`);
        }
        const parsed = parseSettings(body?.settings);
        if ('error' in parsed) return refuse(400, 'invalid_settings', parsed.error);

        const row = await this.readState(workId);
        if (!row || !this.states?.patchRuntimeState) {
            return refuse(
                503,
                'app_runtime_state_unavailable',
                'The App runtime state is not available.',
            );
        }
        if (row.deletionRequestedAt) {
            return refuse(409, 'APP_WORK_DELETING', 'This App Work is being deleted.');
        }

        if (target === 'ever-works-apps') {
            const unmet = await this.managedRefusals(userId, workId);
            if (unmet.length > 0) {
                return {
                    ok: false,
                    refusal: {
                        httpStatus: 422,
                        code: 'APP_TARGET_REFUSED',
                        message: unmet[0].message,
                        unmet,
                    },
                };
            }
        }

        const previousTarget = text(row.target) || 'none';
        const settings: AppRuntimeTargetSettings = {
            ...(row.targetSettings ?? {}),
            ...(parsed.settings ?? {}),
        };

        if (target === 'your-cluster') {
            // The worker's facade dials the plugin `work.deployProvider` names, so a Work that
            // never chose one is pointed at the your-cluster plugin (resolved by capability).
            await this.ensureDeployProvider(workId);
        }

        await this.states.patchRuntimeState(workId, { target, targetSettings: settings });

        if (target !== 'none' && settings.managedSubdomain !== false && this.appsDns?.allocate) {
            try {
                await this.appsDns.allocate(workId);
            } catch (error) {
                this.logger.warn(
                    `Allocating the managed subdomain of ${workId} failed: ${messageOf(error)}`,
                );
            }
        }

        const namespaceChanged =
            parsed.settings?.namespaceOverride !== undefined &&
            parsed.settings.namespaceOverride !==
                (row.targetSettings?.namespaceOverride ?? undefined);
        if (target !== 'none' && (target !== previousTarget || namespaceChanged)) {
            // §9.1 — after a committed change: the namespace and its baseline policies first, so a
            // dependency provisioned next lands in a namespace that already exists (GAP-06).
            await this.dispatchOp({ op: 'prepare-namespace', workId, userId });
        }

        return { ok: true, body: await this.targetBody(await this.readState(workId), userId, workId) };
    }

    /* ---------------------------------------------------------------------- *
     * POST app-target/check
     * ---------------------------------------------------------------------- */

    async check(
        workId: string,
        userId: string,
        body: { kubeconfig?: unknown; kubeContext?: unknown },
        actor?: AppTargetCredentialActor,
    ): Promise<
        | { ok: true; httpStatus: 202; requestId: string; dispatched: boolean }
        | { ok: false; refusal: AppTargetRefusal }
    > {
        const kubeconfig = typeof body?.kubeconfig === 'string' ? body.kubeconfig : '';
        const kubeContext = typeof body?.kubeContext === 'string' ? body.kubeContext.trim() : '';

        if (kubeconfig && Buffer.byteLength(kubeconfig, 'utf8') > APP_TARGET_KUBECONFIG_MAX_BYTES) {
            return refuse(413, 'kubeconfig_too_large', 'The kubeconfig is larger than 64 KiB.');
        }
        if (kubeContext.length > 253) {
            return refuse(400, 'invalid_kube_context', 'The kube context name is too long.');
        }

        const row = await this.readState(workId);
        if (row?.deletionRequestedAt) {
            return refuse(409, 'APP_WORK_DELETING', 'This App Work is being deleted.');
        }

        if (kubeconfig.trim()) {
            const pluginId = await this.ensureDeployProvider(workId);
            if (!pluginId || !this.settings?.writePlatformManagedWorkSettings) {
                return refuse(
                    422,
                    'your_cluster_plugin_unavailable',
                    'No deployment plugin that can run an App on your own cluster is installed.',
                );
            }
            // Works-security — fail early: a kubeconfig shape every cluster path refuses (an exec
            // or auth-provider credential plugin, a token or certificate FILE, a proxy, skipped TLS
            // verification) is refused before it is stored. Pure shape check, no connection.
            const shape = await this.checkCredentialShape(pluginId, kubeconfig, kubeContext);
            if (shape) return { ok: false, refusal: shape };
            // Write-only, encrypted, validated against nothing and connected to nothing (§9.1).
            await this.settings.writePlatformManagedWorkSettings(pluginId, workId, {
                clusterSource: 'custom-kubeconfig',
                kubeconfig,
                ...(kubeContext ? { kubeContext } : {}),
            });
            // Connecting a cluster is choosing Your cluster: a Work still on `none` moves to it,
            // so the worker's check can resolve the credential it was just given.
            const moveToYourCluster = !row?.target || row.target === 'none';
            await this.recordCredentialProvenance(workId, row, userId, actor, moveToYourCluster);
        } else if (kubeContext && this.settings?.writePlatformManagedWorkSettings) {
            const pluginId = await this.ensureDeployProvider(workId);
            if (pluginId) {
                await this.settings.writePlatformManagedWorkSettings(pluginId, workId, {
                    kubeContext,
                });
                // A different context can name a different cluster in the same kubeconfig.
                await this.recordCredentialProvenance(workId, row, userId, actor, false);
            }
        }

        const requestId = randomUUID();
        const dispatched = await this.dispatchOp({
            op: 'cluster-check',
            workId,
            userId,
            requestId,
        });
        return { ok: true, httpStatus: 202, requestId, dispatched };
    }

    /* ---------------------------------------------------------------------- *
     * GET app-status
     * ---------------------------------------------------------------------- */

    async getStatus(workId: string): Promise<AppStatusBody> {
        const row = await this.readState(workId);
        const target = (TARGETS.find((choice) => choice === row?.target) ??
            'none') as AppDeployTarget;

        const latest = await this.latestDeployment(workId);
        const current = row?.currentDeploymentId
            ? ((await this.deploymentById(row.currentDeploymentId)) ?? latest)
            : latest;
        const render = (current?.appRender ?? {}) as {
            phase?: unknown;
            hosts?: { primary?: unknown; extra?: unknown };
            cancelledBy?: unknown;
        };
        const live = row?.currentDeploymentId
            ? await this.deploymentById(row.currentDeploymentId)
            : null;
        const liveHosts = (
            (live?.appRender ?? {}) as { hosts?: { primary?: unknown; extra?: unknown } }
        ).hosts;
        const primary = text(liveHosts?.primary) || null;
        const extra = Array.isArray(liveHosts?.extra) ? liveHosts.extra.map(String) : [];

        const observedAt = iso(row?.statusObservedAt);
        const deployed = Boolean(row?.currentDeploymentId) && !row?.removedAt;
        const stale =
            deployed &&
            (!observedAt || Date.now() - new Date(observedAt).getTime() > APP_STATUS_STALE_MS);

        return {
            state: runtimeStateOf(row),
            target,
            stale,
            observedAt,
            url:
                (live?.website ? String(live.website) : null) ??
                (primary ? `https://${primary}` : null),
            hosts: { primary, extra },
            sourceOffer: await this.sourceOfferFor(workId, target, live),
            currentDeployment: latest
                ? {
                      id: String(latest.id),
                      state: String(latest.state ?? ''),
                      ...(text(((latest.appRender ?? {}) as { phase?: unknown }).phase)
                          ? { phase: text(((latest.appRender ?? {}) as { phase?: unknown }).phase) }
                          : {}),
                      ...(text(render.cancelledBy)
                          ? { cancelReason: text(render.cancelledBy) }
                          : {}),
                  }
                : null,
            snapshot: row?.statusSnapshot ?? null,
            ops: await this.recentOps(workId, row),
            requests: await this.recentRequests(workId),
            smoke: live ? smokeViewOf(String(live.id), live.smokeResult) : null,
        };
    }

    /* ---------------------------------------------------------------------- *
     * POST app-rollback (plan §9.1, FR-34)
     * ---------------------------------------------------------------------- */

    /**
     * Roll back to an earlier Live Deployment of this Work: the request path re-runs every §5.1
     * precondition, records the old Build / spec commit / image digest (a rollback "never
     * re-resolves", §5.8) and skips the pre-deploy jobs unless `runPreDeployJobs` is true.
     */
    async rollback(
        workId: string,
        userId: string,
        body: { deploymentId?: unknown; runPreDeployJobs?: unknown; confirmClusterChange?: unknown },
        options?: { requestedByHumanSession?: boolean },
    ): Promise<
        { ok: true; result: AppDeployRequestResult } | { ok: false; refusal: AppTargetRefusal }
    > {
        const deploymentId = text(body?.deploymentId);
        if (!deploymentId) {
            return refuse(400, 'deployment_id_required', 'Name the Deployment to roll back to.');
        }
        if (!this.requests?.request) {
            return refuse(
                503,
                'app_deploy_unavailable',
                'The App deploy request path is not available.',
            );
        }

        const row = await this.deploymentById(deploymentId);
        if (!row || row.workId !== workId) {
            return refuse(
                404,
                'deployment_not_found',
                'That Deployment does not belong to this App Work.',
            );
        }
        if (String(row.state ?? '') !== 'READY') {
            return refuse(
                422,
                'rollback_target_not_live',
                'Only a Deployment that went live can be rolled back to.',
            );
        }
        const state = await this.readState(workId);
        if (state?.currentDeploymentId === deploymentId) {
            return refuse(
                422,
                'rollback_target_is_current',
                'That Deployment is the one already running.',
            );
        }

        const render = (row.appRender ?? {}) as {
            specCommitSha?: unknown;
            image?: { reference?: unknown; digest?: unknown };
        };
        const specCommitSha = text(render.specCommitSha) || text(row.commitSha) || null;
        const result = await this.requests.request({
            workId,
            userId,
            trigger: 'rollback',
            buildId: row.buildId ?? null,
            specCommitSha,
            runPreDeployJobs: body?.runPreDeployJobs === true,
            // Works-security — the controller lets this through only for the owner in a session
            // while `APP_TARGET_CHANGE_REQUIRES_OWNER` is on, exactly as on `POST :id/deploy`.
            ...(body?.confirmClusterChange === true ? { confirmClusterChange: true } : {}),
            ...(options?.requestedByHumanSession === true ? { requestedByHumanSession: true } : {}),
            rollback: {
                deploymentId,
                buildId: row.buildId ?? null,
                specCommitSha,
                imageReference: text(render.image?.reference) || null,
                imageDigest: text(render.image?.digest) || null,
            },
        });
        return { ok: true, result };
    }

    /* ---------------------------------------------------------------------- *
     * POST app-lifecycle (plan §9.1)
     * ---------------------------------------------------------------------- */

    /**
     * `pause` / `resume` / `remove` / `cancel-deploy` as an `app-cluster-op` the isolated worker
     * runs (§9.10). `remove` with `deleteData` also deletes volumes and dependency data, so it
     * needs `confirmSlug === work.slug` (422 `CONFIRM_SLUG_MISMATCH`).
     */
    async lifecycle(
        work: { id: string; slug?: string | null },
        userId: string,
        body: { action?: unknown; deleteData?: unknown; confirmSlug?: unknown },
    ): Promise<
        | {
              ok: true;
              httpStatus: 202;
              requestId: string;
              dispatched: boolean;
              action: AppLifecycleAction;
          }
        | { ok: false; refusal: AppTargetRefusal }
    > {
        const action = APP_LIFECYCLE_ACTIONS.find((choice) => choice === body?.action);
        if (!action) {
            return refuse(
                400,
                'invalid_action',
                `action must be one of ${APP_LIFECYCLE_ACTIONS.join(', ')}.`,
            );
        }
        const deleteData = action === 'remove' && body?.deleteData === true;
        if (deleteData && text(body?.confirmSlug) !== text(work.slug)) {
            return refuse(
                422,
                'CONFIRM_SLUG_MISMATCH',
                'Type the App Work slug to confirm that its stored data is deleted too.',
            );
        }

        const state = await this.readState(work.id);
        if (state?.deletionRequestedAt) {
            return refuse(409, 'APP_WORK_DELETING', 'This App Work is being deleted.');
        }
        const lockId = text(state?.deployLockId);
        if (action === 'cancel-deploy' && !lockId) {
            return refuse(
                409,
                'no_deploy_in_progress',
                'No Deployment of this App Work is running.',
            );
        }

        const requestId = randomUUID();
        const dispatched = await this.dispatchOp({
            op: action,
            workId: work.id,
            userId,
            requestId,
            ...(action === 'remove' ? { deleteData } : {}),
            ...(action === 'cancel-deploy' ? { deploymentId: lockId } : {}),
        });
        return { ok: true, httpStatus: 202, requestId, dispatched, action };
    }

    /* ---------------------------------------------------------------------- *
     * Lane aw-ops (2026-10-27) — POST app-status/refresh (FR-46)
     * ---------------------------------------------------------------------- */

    /**
     * Queue a `status-refresh` op. Once per {@link APP_STATUS_REFRESH_INTERVAL_MS} per Work
     * (FR-46): a second press inside the window answers `429 refresh_too_soon` with the wait.
     * The snapshot itself lands in the runtime-state row; `GET app-status` reads it.
     */
    async refreshStatus(
        workId: string,
        userId: string,
    ): Promise<AppOpsAccepted | { ok: false; refusal: AppTargetRefusal }> {
        const row = await this.readState(workId);
        const blocked = refuseUnlessDeployed(row);
        if (blocked) return blocked;

        const gateKey = appStatusRefreshGateKey(workId);
        const gate = await this.cacheGet<{ at?: number }>(gateKey);
        const since = typeof gate?.at === 'number' ? Date.now() - gate.at : null;
        if (since !== null && since >= 0 && since < APP_STATUS_REFRESH_INTERVAL_MS) {
            const refusal = refuse(
                429,
                'refresh_too_soon',
                'Status can be refreshed once every 15 seconds.',
            );
            refusal.refusal.retryAfterSeconds = Math.max(
                1,
                Math.ceil((APP_STATUS_REFRESH_INTERVAL_MS - since) / 1000),
            );
            return refusal;
        }
        await this.cacheSet(gateKey, { at: Date.now() }, APP_STATUS_REFRESH_INTERVAL_MS);

        return this.queueOp(workId, userId, 'status-refresh', {});
    }

    /* ---------------------------------------------------------------------- *
     * Lane aw-ops — POST app-logs / GET app-logs/:requestId (FR-48)
     * ---------------------------------------------------------------------- */

    /**
     * Queue a `logs` op for ONE component or ONE job: `{ component? | job?, deploymentId?,
     * previous?, lines? }` (1–500, 200 by default). The tail lands in `app-logs:<workId>:<id>`
     * for 300 s; the payload carries names and ids only — never a secret value.
     */
    async requestLogs(
        workId: string,
        userId: string,
        body: {
            component?: unknown;
            job?: unknown;
            deploymentId?: unknown;
            previous?: unknown;
            lines?: unknown;
        },
    ): Promise<AppOpsAccepted | { ok: false; refusal: AppTargetRefusal }> {
        const component = text(body?.component);
        const job = text(body?.job);
        if ((component && !APP_RUNTIME_NAME.test(component)) || (job && !APP_RUNTIME_NAME.test(job))) {
            return refuse(400, 'invalid_log_target', 'Name one component or job of this App.');
        }
        if (component && job) {
            return refuse(400, 'log_target_ambiguous', 'Ask for the logs of a component or a job, not both.');
        }
        if (!component && !job) {
            return refuse(400, 'log_target_required', 'Name the component or the job to read logs from.');
        }
        const deploymentId = text(body?.deploymentId);
        if (deploymentId && !UUID.test(deploymentId)) {
            return refuse(400, 'invalid_deployment_id', 'deploymentId must be a Deployment id.');
        }
        if (body?.previous !== undefined && typeof body.previous !== 'boolean') {
            return refuse(400, 'invalid_previous', 'previous must be a boolean.');
        }
        let lines = APP_LOG_LINES_DEFAULT;
        if (body?.lines !== undefined && body.lines !== null) {
            const asked = Number(body.lines);
            if (!Number.isFinite(asked) || asked < 1) {
                return refuse(400, 'invalid_lines', `lines must be between 1 and ${APP_LOG_LINES_MAX}.`);
            }
            lines = Math.min(APP_LOG_LINES_MAX, Math.floor(asked));
        }
        if (!this.cache || typeof this.cache.set !== 'function') {
            return refuse(
                503,
                'logs_cache_unavailable',
                'Logs cannot be fetched on this instance: there is nowhere to hold them.',
            );
        }

        const row = await this.readState(workId);
        if (row?.deletionRequestedAt) {
            return refuse(409, 'APP_WORK_DELETING', 'This App Work is being deleted.');
        }
        if (!row?.target || row.target === 'none') {
            return refuse(409, 'app_target_none', 'This App runs nowhere yet, so it has no logs.');
        }

        const requestId = randomUUID();
        const key = appLogsCacheKey(workId, requestId);
        // Written BEFORE the dispatch, so a fast worker's `done` is never overwritten by it.
        await this.cacheSet(key, { state: 'pending' }, APP_OP_CACHE_TTL_MS);
        const dispatched = await this.dispatchOp({
            op: 'logs',
            workId,
            userId,
            requestId,
            ...(component ? { component } : {}),
            ...(job ? { job } : {}),
            ...(deploymentId ? { deploymentId } : {}),
            previous: body?.previous === true,
            lines,
        });
        if (!dispatched) {
            await this.cacheSet(key, { state: 'failed', code: 'worker_unavailable' }, APP_OP_CACHE_TTL_MS);
        }
        return { ok: true, httpStatus: 202, op: 'logs', requestId, dispatched };
    }

    /**
     * Read one log request back. The key is `app-logs:<workId>:<requestId>`, so another Work's id
     * misses (404), and so does one older than 300 s. A ready tail is redacted AGAIN here with the
     * App's secret env values (FR-48, `app-log-redaction.ts`); when those cannot be read the tail
     * is withheld (`failed`, `redaction_unavailable`) rather than shown unredacted.
     */
    async readLogs(
        workId: string,
        requestId: string,
    ): Promise<{ ok: true; body: AppLogsReadBody } | { ok: false; refusal: AppTargetRefusal }> {
        const id = text(requestId);
        const notFound = refuse(
            404,
            'logs_request_not_found',
            'That log request is unknown or expired (logs are kept for 5 minutes).',
        );
        if (!UUID.test(id)) return notFound;

        const entry = await this.cacheGet<{ state?: unknown; tail?: AppLogTail; code?: unknown }>(
            appLogsCacheKey(workId, id),
        );
        if (!entry || typeof entry !== 'object') return notFound;

        const state = text(entry.state);
        if (state === 'pending') return { ok: true, body: { requestId: id, status: 'pending' } };
        if (state !== 'done') {
            return {
                ok: true,
                body: { requestId: id, status: 'failed', code: text(entry.code) || 'logs_failed' },
            };
        }

        const row = await this.readState(workId);
        const target = (TARGETS.find((choice) => choice === row?.target) ??
            'your-cluster') as AppDeployTarget;
        const secrets = await this.redactionValues(workId, target);
        if (secrets === null) {
            return {
                ok: true,
                body: { requestId: id, status: 'failed', code: 'redaction_unavailable' },
            };
        }
        const tail = redactAppLogTail(entry.tail ?? null, secrets);
        if (!tail) {
            return { ok: true, body: { requestId: id, status: 'failed', code: 'logs_failed' } };
        }
        return { ok: true, body: { requestId: id, status: 'ready', tail } };
    }

    /* ---------------------------------------------------------------------- *
     * Lane aw-ops — POST app-jobs/:name/run (FR-51)
     * ---------------------------------------------------------------------- */

    /**
     * Run one App spec job now, with the live image and env (FR-51). A job changes the app's data
     * (a migration, a seed), so the request must carry `confirmFirstDeploy: true` — the member's
     * confirmation; the your-cluster plugin refuses an unconfirmed run anyway
     * (`job_confirmation_required`), so refusing here saves a worker run. Refused while a
     * Deployment holds the lock and while the snapshot shows a run of the same job (`409`).
     */
    async runJob(
        workId: string,
        userId: string,
        name: string,
        body: { confirmFirstDeploy?: unknown },
    ): Promise<AppOpsAccepted | { ok: false; refusal: AppTargetRefusal }> {
        const jobName = text(name);
        if (!APP_RUNTIME_NAME.test(jobName)) {
            return refuse(400, 'invalid_job_name', 'Name a job the App spec declares.');
        }
        if (body?.confirmFirstDeploy !== true) {
            return refuse(
                422,
                'job_confirmation_required',
                'Confirm the run: a job can change the app’s data, and it runs against the live app.',
            );
        }

        const row = await this.readState(workId);
        const blocked = refuseUnlessDeployed(row);
        if (blocked) return blocked;
        if (text(row?.deployLockId)) {
            return refuse(
                409,
                'deploy_in_progress',
                'Wait for the current Deployment to finish, or cancel it.',
            );
        }
        if (jobIsRunning(row?.statusSnapshot, jobName)) {
            return refuse(409, 'job_active', `A run of ${jobName} is still going.`);
        }

        return this.queueOp(workId, userId, 'job-run', { jobName, confirmFirstDeploy: true }, jobName);
    }

    /* ---------------------------------------------------------------------- *
     * Lane aw-ops — POST app-smoke (FR-36/FR-37)
     * ---------------------------------------------------------------------- */

    /**
     * Run the App spec's smoke checks against the live Deployment, on demand: an `app-cluster-op
     * { op: 'smoke' }` the worker routes to `AppSmokeService` (§5.7 — it writes `smokeResult` on
     * that Deployment and never rolls back). Refused when nothing is live, while paused, and while
     * a Deployment holds the lock.
     */
    async runSmoke(
        workId: string,
        userId: string,
    ): Promise<AppOpsAccepted | { ok: false; refusal: AppTargetRefusal }> {
        const row = await this.readState(workId);
        const blocked = refuseUnlessDeployed(row);
        if (blocked) return blocked;
        if (row?.paused === true || row?.pausedAt) {
            return refuse(409, 'app_paused', 'The app is paused. Resume it to run the smoke checks.');
        }
        if (text(row?.deployLockId)) {
            return refuse(
                409,
                'deploy_in_progress',
                'A Deployment is running; its own smoke checks run as part of it.',
            );
        }
        return this.queueOp(workId, userId, 'smoke', {
            deploymentId: text(row?.currentDeploymentId),
            trigger: 'manual',
        });
    }

    /* ---------------------------------------------------------------------- *
     * Lane aw-ops — GET app-deployments (T39 history)
     * ---------------------------------------------------------------------- */

    /**
     * The last {@link APP_DEPLOYMENT_HISTORY_LIMIT} Deployments of this App Work, newest first,
     * reduced to ids, states, times and a smoke count — the existing website deployments route
     * answers whole rows (render facts included), which a viewer has no need for.
     */
    async listDeployments(workId: string): Promise<AppDeploymentHistoryEntry[]> {
        let rows: Array<Record<string, unknown>> = [];
        try {
            rows = ((await this.deployments?.findByWork?.(workId, {
                limit: APP_DEPLOYMENT_HISTORY_LIMIT,
            })) ?? []) as unknown as Array<Record<string, unknown>>;
        } catch {
            rows = [];
        }
        const row = await this.readState(workId);
        const current = text(row?.currentDeploymentId);
        return rows.map((deployment) => historyEntryOf(deployment, current));
    }

    /* ---------------------------------------------------------------------- *
     * Lane aw-ops — internals
     * ---------------------------------------------------------------------- */

    /**
     * Queue one op: the `app-op:` entry reads `queued` BEFORE the dispatch (so the worker's own
     * write always wins), the request joins the Work's index for `GET app-status`, and a dispatch
     * nobody took turns the entry `failed` with `worker_unavailable` at once.
     */
    private async queueOp(
        workId: string,
        userId: string,
        op: Exclude<AppOpsRequestKind, 'logs'>,
        extra: Record<string, unknown>,
        jobName?: string,
    ): Promise<AppOpsAccepted> {
        const requestId = randomUUID();
        const key = appOpCacheKey(workId, requestId);
        await this.cacheSet(key, { op, state: 'queued' }, APP_OP_CACHE_TTL_MS);
        await this.recordRequest(workId, {
            requestId,
            op,
            at: new Date().toISOString(),
            ...(jobName ? { jobName } : {}),
        });
        const dispatched = await this.dispatchOp({ op, workId, userId, requestId, ...extra });
        if (!dispatched) {
            await this.cacheSet(
                key,
                { op, state: 'failed', code: 'worker_unavailable' },
                APP_OP_CACHE_TTL_MS,
            );
        }
        return { ok: true, httpStatus: 202, op, requestId, dispatched };
    }

    /** Prepend one request to the Work's index (best effort: a lost race loses a display row). */
    private async recordRequest(
        workId: string,
        entry: { requestId: string; op: string; at: string; jobName?: string },
    ): Promise<void> {
        const key = appOpsRequestIndexKey(workId);
        const previous = await this.cacheGet<unknown>(key);
        const list = Array.isArray(previous) ? previous : [];
        await this.cacheSet(
            key,
            [entry, ...list.filter((item) => item?.requestId !== entry.requestId)].slice(
                0,
                APP_OPS_REQUESTS_LIMIT,
            ),
            APP_OP_CACHE_TTL_MS,
        );
    }

    /** The indexed requests whose `app-op:` entry still exists, newest first. */
    private async recentRequests(workId: string): Promise<AppStatusRequestEntry[]> {
        const index = await this.cacheGet<unknown>(appOpsRequestIndexKey(workId));
        if (!Array.isArray(index)) return [];
        const out: AppStatusRequestEntry[] = [];
        for (const item of index.slice(0, APP_OPS_REQUESTS_LIMIT)) {
            const requestId = text(item?.requestId);
            if (!UUID.test(requestId)) continue;
            const entry = await this.cacheGet<{ op?: unknown; state?: unknown; code?: unknown }>(
                appOpCacheKey(workId, requestId),
            );
            if (!entry) continue;
            const state = text(entry.state);
            out.push({
                requestId,
                op: text(entry.op) || text(item?.op),
                state:
                    state === 'running' || state === 'done' || state === 'failed'
                        ? state
                        : 'queued',
                at: text(item?.at),
                ...(text(entry.code) ? { code: text(entry.code).slice(0, 60) } : {}),
                ...(text(item?.jobName) ? { jobName: text(item.jobName) } : {}),
            });
        }
        return out;
    }

    /** The secret values to redact, or `null` when they cannot be known (fail closed). */
    private async redactionValues(
        workId: string,
        target: AppDeployTarget,
    ): Promise<Record<string, string> | null> {
        if (typeof this.envSource?.secretValuesForRedaction !== 'function') return null;
        try {
            const values = await this.envSource.secretValuesForRedaction(workId, target);
            return values && typeof values === 'object' ? values : null;
        } catch {
            return null;
        }
    }

    private async cacheGet<T>(key: string): Promise<T | null> {
        if (!this.cache || typeof this.cache.get !== 'function') return null;
        try {
            return ((await this.cache.get<T>(key)) ?? null) as T | null;
        } catch (error) {
            this.logger.warn(`Reading the cache entry ${key} failed: ${messageOf(error)}`);
            return null;
        }
    }

    private async cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
        if (!this.cache || typeof this.cache.set !== 'function') return;
        try {
            await this.cache.set(key, value, ttlMs);
        } catch (error) {
            this.logger.warn(`Writing the cache entry ${key} failed: ${messageOf(error)}`);
        }
    }

    /* ---------------------------------------------------------------------- *
     * Works-security (2026-10-18) — the owner-only cluster decisions
     * ---------------------------------------------------------------------- */

    /**
     * What `PUT app-target` with this body would change that `APP_TARGET_CHANGE_REQUIRES_OWNER`
     * reserves for the owner: the target itself, or the namespace override. A body that would be
     * refused anyway (an unknown target, unparseable settings) changes nothing — `putTarget`
     * answers its own `400`.
     */
    async pendingTargetChange(
        workId: string,
        body: { target?: unknown; settings?: unknown },
    ): Promise<AppTargetPendingChange> {
        const target = TARGETS.find((choice) => choice === body?.target);
        const parsed = parseSettings(body?.settings);
        if (!target || 'error' in parsed) return { targetChanges: false, namespaceChanges: false };
        const row = await this.readState(workId);
        const current = (TARGETS.find((choice) => choice === row?.target) ?? 'none') as string;
        const nextNamespace = parsed.settings?.namespaceOverride;
        const currentNamespace = row?.targetSettings?.namespaceOverride ?? null;
        return {
            targetChanges: target !== current,
            namespaceChanges:
                nextNamespace !== undefined && (nextNamespace ?? null) !== currentNamespace,
        };
    }

    /**
     * Whether the your-cluster credential must be confirmed by the owner before its next use
     * (`clusterCredentialNeedsOwnerConfirmation`). No readable row means nothing to judge here;
     * the deploy preconditions read the same row and refuse a Deployment they cannot evaluate.
     */
    async clusterCredentialNeedsOwnerConfirmation(workId: string): Promise<boolean> {
        const row = await this.readState(workId);
        return clusterCredentialNeedsOwnerConfirmation(row);
    }

    /**
     * Record that the owner confirmed the current your-cluster credential (the controller calls
     * this only after it established the owner in a signed-in session). `false` when nothing
     * could be written — the deploy preconditions then still refuse, which is the safe answer.
     */
    async confirmClusterCredential(workId: string, ownerUserId: string): Promise<boolean> {
        const row = await this.readState(workId);
        if (!row || !this.states?.patchRuntimeState) return false;
        const previous = (row.targetSettings?.clusterCredential ??
            null) as AppClusterCredentialProvenance | null;
        const clusterCredential: AppClusterCredentialProvenance = {
            savedByUserId: previous?.savedByUserId ?? null,
            savedByOwner: previous?.savedByOwner ?? null,
            savedAt: previous?.savedAt ?? null,
            ownerConfirmedByUserId: ownerUserId,
            ownerConfirmedAt: new Date().toISOString(),
        };
        try {
            await this.states.patchRuntimeState(workId, {
                targetSettings: { ...(row.targetSettings ?? {}), clusterCredential },
            });
            return true;
        } catch (error) {
            this.logger.warn(
                `Recording the owner's confirmation of ${workId}'s cluster credential failed: ${messageOf(error)}`,
            );
            return false;
        }
    }

    /**
     * Provenance of a credential just saved: who, whether they were the owner, when — and any
     * earlier owner confirmation is cleared, because it confirmed a different credential.
     */
    private async recordCredentialProvenance(
        workId: string,
        row: AppTargetStateRow | null,
        userId: string,
        actor: AppTargetCredentialActor | undefined,
        moveToYourCluster: boolean,
    ): Promise<void> {
        if (!this.states?.patchRuntimeState) return;
        const clusterCredential: AppClusterCredentialProvenance = {
            savedByUserId: userId || null,
            savedByOwner: actor?.isOwner === true,
            savedAt: new Date().toISOString(),
            ownerConfirmedByUserId: null,
            ownerConfirmedAt: null,
        };
        await this.states.patchRuntimeState(workId, {
            ...(moveToYourCluster ? { target: 'your-cluster' as AppDeployTarget } : {}),
            targetSettings: { ...(row?.targetSettings ?? {}), clusterCredential },
        });
    }

    /**
     * The your-cluster plugin's own pure shape check of a pasted kubeconfig, when it offers one
     * and `EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG` is not `false`. `null` = acceptable (or
     * no check available); otherwise the refusal. The plugin's message never echoes the
     * kubeconfig, and neither does this one.
     */
    private async checkCredentialShape(
        pluginId: string,
        kubeconfig: string,
        kubeContext: string,
    ): Promise<AppTargetRefusal | null> {
        if (!guardKubeconfigOnSave()) return null;
        const registered = this.registry?.get(pluginId);
        if (!registered) return null;
        let plugin = registered.plugin as unknown as ClusterCredentialShapeCheck & {
            __materialize?: () => Promise<unknown>;
        };
        if (typeof plugin?.__materialize === 'function') {
            try {
                plugin = ((await plugin.__materialize()) ?? plugin) as typeof plugin;
            } catch {
                return null;
            }
        }
        if (typeof plugin?.checkClusterCredentialShape !== 'function') return null;
        let verdict: ReturnType<NonNullable<ClusterCredentialShapeCheck['checkClusterCredentialShape']>>;
        try {
            verdict = plugin.checkClusterCredentialShape(kubeconfig, kubeContext || undefined);
        } catch {
            verdict = { ok: false };
        }
        if (verdict && verdict.ok === true) return null;
        const failed = verdict as { code?: string; message?: string } | null;
        return {
            httpStatus: 422,
            code: 'kubeconfig_unsupported',
            message:
                text(failed?.message) ||
                'This kubeconfig uses a credential or connection setting Ever Works does not accept.',
            ...(text(failed?.code)
                ? {
                      unmet: [
                          {
                              code: 'target_not_checked',
                              names: [text(failed?.code)],
                              message: text(failed?.message) || 'Unsupported kubeconfig.',
                          },
                      ],
                  }
                : {}),
        };
    }

    /* ---------------------------------------------------------------------- *
     * internals
     * ---------------------------------------------------------------------- */

    private async targetBody(
        row: AppTargetStateRow | null,
        userId: string,
        workId?: string,
    ): Promise<AppTargetBody> {
        const target = (TARGETS.find((choice) => choice === row?.target) ??
            'none') as AppDeployTarget;
        let eligibility: AppTargetBody['eligibility'] = null;
        if (this.tier?.eligibility) {
            try {
                // `workId` lets the per-owner cap count the owner's OTHER App Works (lane aw-safety, #2914).
                const answer = await this.tier.eligibility(userId, { workId: workId ?? null });
                eligibility = {
                    managed: {
                        eligible: answer?.eligible === true && this.tier.isOpen() === true,
                        reasons: [...(answer?.reasons ?? [])],
                    },
                };
            } catch {
                eligibility = null;
            }
        }
        // Works-security — the credential provenance is the platform's bookkeeping, not a setting.
        let settings: AppRuntimeTargetSettings | null = row?.targetSettings ?? null;
        if (settings && 'clusterCredential' in settings) {
            const { clusterCredential: _provenance, ...rest } = settings;
            settings = rest;
        }
        return {
            target,
            settings,
            namespace: text(row?.namespace) || null,
            // Secret-free by construction (`AppClusterCheck`, plan §6.3).
            clusterCheck: row?.clusterCheck ?? null,
            clusterCheckedAt: iso(row?.clusterCheckedAt),
            eligibility,
        };
    }

    private async managedRefusals(userId: string, workId?: string): Promise<AppPrecondition[]> {
        const open = (() => {
            try {
                return this.tier?.isOpen?.() === true;
            } catch {
                return false;
            }
        })();
        if (!open) {
            return [
                {
                    code: 'managed_disabled',
                    message: 'Ever Works Apps hosting is not available on this installation.',
                },
            ];
        }
        try {
            // Choosing the managed tier is judged like a deploy to it: the cap counts the owner's other App Works.
            const answer = await this.tier!.eligibility(userId, { workId: workId ?? null });
            if (answer?.eligible !== true) {
                return [
                    {
                        code: 'managed_ineligible',
                        names: [...(answer?.reasons ?? [])],
                        message: 'Your account is not eligible for Ever Works Apps hosting.',
                    },
                ];
            }
        } catch {
            return [
                {
                    code: 'managed_ineligible',
                    message: 'Eligibility for Ever Works Apps hosting could not be read.',
                },
            ];
        }
        return [];
    }

    /**
     * The your-cluster deployment plugin for this Work, by capability (`supportsApps` and NOT
     * `apps-tier`), never by a hard-coded id alone; `work.deployProvider` is set to it when the
     * Work has none yet. `null` ⇔ no such plugin is loaded.
     */
    private async ensureDeployProvider(workId: string): Promise<string | null> {
        const work = this.works ? await this.works.findById(workId) : null;
        const current = text(work?.deployProvider);
        const candidates = [current, 'k8s'].filter(Boolean);

        for (const id of [...new Set(candidates)]) {
            if (await this.isYourClusterPlugin(id)) {
                if (work && current !== id) {
                    try {
                        await this.works?.update(workId, { deployProvider: id });
                    } catch (error) {
                        this.logger.warn(
                            `Could not set the deploy provider of ${workId}: ${messageOf(error)}`,
                        );
                    }
                }
                return id;
            }
        }
        return null;
    }

    private async isYourClusterPlugin(pluginId: string): Promise<boolean> {
        const registered = this.registry?.get(pluginId);
        if (!registered || registered.state !== 'loaded') return false;
        let plugin = registered.plugin as IDeploymentPlugin & {
            __materialize?: () => Promise<IDeploymentPlugin>;
        };
        if (typeof plugin.__materialize === 'function') {
            try {
                plugin = ((await plugin.__materialize()) ?? plugin) as typeof plugin;
            } catch {
                return false;
            }
        }
        const capabilities = [
            ...(Array.isArray(plugin?.capabilities) ? plugin.capabilities : []),
            ...(Array.isArray(registered.manifest?.capabilities)
                ? registered.manifest.capabilities
                : []),
        ];
        return (
            capabilities.includes(PLUGIN_CAPABILITIES.DEPLOYMENT) &&
            !capabilities.includes(APP_TIER_CAPABILITY) &&
            isAppDeploymentPlugin(plugin)
        );
    }

    private async dispatchOp(payload: {
        op: string;
        workId: string;
        userId?: string | null;
        requestId?: string;
        [key: string]: unknown;
    }): Promise<boolean> {
        if (!this.ops?.dispatch) {
            this.logger.warn(
                `No App cluster-op dispatcher is bound; ${payload.op} for ${payload.workId} was not queued.`,
            );
            return false;
        }
        try {
            const id = await this.ops.dispatch({
                ...payload,
                requestId: payload.requestId ?? randomUUID(),
            });
            return Boolean(id);
        } catch (error) {
            this.logger.warn(
                `Dispatching ${payload.op} for ${payload.workId} failed: ${messageOf(error)}`,
            );
            return false;
        }
    }

    /**
     * The recent operations, newest first: every recent Deployment row (a `rollback` trigger is a
     * rollback, anything else a deploy) plus the runtime row's pause / removal / deletion facts.
     */
    private async recentOps(
        workId: string,
        row: AppTargetStateRow | null,
    ): Promise<AppStatusOpEntry[]> {
        const entries: AppStatusOpEntry[] = [];
        let rows: Array<Record<string, unknown>> = [];
        try {
            rows = ((await this.deployments?.findByWork?.(workId, {
                limit: APP_STATUS_OPS_LIMIT,
            })) ?? []) as unknown as Array<Record<string, unknown>>;
        } catch {
            rows = [];
        }
        for (const deployment of rows) {
            const trigger = text(deployment.appTrigger);
            const lastError = text(deployment.lastError);
            entries.push({
                kind: trigger === 'rollback' ? 'rollback' : 'deploy',
                state: opStateOf(String(deployment.state ?? '')),
                at: iso(
                    (deployment.completedAt ?? deployment.startedAt ?? deployment.createdAt) as
                        | Date
                        | string
                        | null,
                ),
                deploymentId: String(deployment.id),
                ...(trigger ? { trigger } : {}),
                ...(lastError ? { code: lastError.split(':')[0].slice(0, 60) } : {}),
            });
        }
        if (row?.deletionRequestedAt) {
            entries.push({ kind: 'delete', state: 'running', at: iso(row.deletionRequestedAt) });
        }
        if (row?.removedAt) entries.push({ kind: 'remove', state: 'done', at: iso(row.removedAt) });
        if (row?.paused === true || row?.pausedAt) {
            entries.push({ kind: 'pause', state: 'done', at: iso(row.pausedAt ?? null) });
        }
        return entries
            .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
            .slice(0, APP_STATUS_OPS_LIMIT);
    }

    /**
     * T30's source offer, when it applies: APW-03's hosting eligibility says the licence carries
     * the network-source-offer obligation and names a URL. `null` otherwise (no obligation, no
     * URL, nothing deployed, or no licence service in this process).
     */
    private async sourceOfferFor(
        workId: string,
        target: AppDeployTarget,
        live: { commitSha?: string | null } | null,
    ): Promise<{ url: string } | null> {
        if (!live || target === 'none' || !this.licenseGate?.evaluate) return null;
        try {
            const verdict = await this.licenseGate.evaluate({
                workId,
                target,
                commitSha: text(live.commitSha) || null,
            });
            const offer = verdict?.sourceOffer;
            return offer?.required && text(offer.url) ? { url: text(offer.url) } : null;
        } catch {
            return null;
        }
    }

    private async readState(workId: string): Promise<AppTargetStateRow | null> {
        if (!this.states?.getOrCreate) return null;
        try {
            return (await this.states.getOrCreate(workId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Reading the App runtime state of ${workId} failed: ${messageOf(error)}`,
            );
            return null;
        }
    }

    private async latestDeployment(workId: string) {
        if (!this.deployments?.findByWork) return null;
        try {
            const rows = await this.deployments.findByWork(workId, { limit: 1 });
            return rows?.[0] ?? null;
        } catch {
            return null;
        }
    }

    private async deploymentById(id: string) {
        if (!this.deployments?.findById) return null;
        try {
            return (await this.deployments.findById(id)) ?? null;
        } catch {
            return null;
        }
    }
}

/** plan §3.1:367-369 — `health` + `paused` + `removedAt` + `deletionRequestedAt` → the app state. */
export function runtimeStateOf(row: AppTargetStateRow | null | undefined): AppRuntimeState {
    if (!row) return 'not-deployed';
    if (row.deletionRequestedAt) return 'deleting';
    if (row.removedAt || !row.currentDeploymentId) return 'not-deployed';
    if (row.paused === true || row.pausedAt) return 'paused';
    switch (row.health) {
        case 'degraded':
            return 'degraded';
        case 'down':
            return 'down';
        case 'unreachable':
            return 'unreachable';
        default:
            // `healthy`, and `unknown` with a READY Deployment on record (not judged yet).
            return 'live';
    }
}

/** `settings` off the wire → the §7.2 bag, or the reason it is not one. */
export function parseSettings(
    raw: unknown,
): { settings: AppRuntimeTargetSettings | null } | { error: string } {
    if (raw === undefined || raw === null) return { settings: null };
    if (typeof raw !== 'object' || Array.isArray(raw))
        return { error: 'settings must be an object.' };
    const input = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of SETTINGS_STRING_KEYS) {
        if (!(key in input) || input[key] === undefined) continue;
        const value = input[key];
        if (value === null || value === '') {
            out[key] = null;
            continue;
        }
        if (typeof value !== 'string' || value.length > 253)
            return { error: `${key} must be a short string.` };
        out[key] = value.trim();
    }
    for (const key of SETTINGS_BOOLEAN_KEYS) {
        if (!(key in input) || input[key] === undefined) continue;
        if (typeof input[key] !== 'boolean') return { error: `${key} must be a boolean.` };
        out[key] = input[key];
    }
    if ('tls' in input && input.tls !== undefined) {
        if (!(TLS_MODES as readonly unknown[]).includes(input.tls)) {
            return { error: `tls must be one of ${TLS_MODES.join(', ')}.` };
        }
        out.tls = input.tls;
    }
    const namespace = out.namespaceOverride;
    if (typeof namespace === 'string' && !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) {
        return { error: 'namespaceOverride must be a DNS-1123 label.' };
    }
    return { settings: out as AppRuntimeTargetSettings };
}

function refuse(
    httpStatus: number,
    code: string,
    message: string,
): { ok: false; refusal: AppTargetRefusal } {
    return { ok: false, refusal: { httpStatus, code, message } };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message.slice(0, 300);
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}

/**
 * Lane aw-ops — the refusal every live-app op shares: a deleting Work (`409 APP_WORK_DELETING`)
 * and one with nothing deployed (`409 app_not_deployed`). `null` ⇔ the op may go on.
 */
export function refuseUnlessDeployed(
    row: AppTargetStateRow | null | undefined,
): { ok: false; refusal: AppTargetRefusal } | null {
    if (row?.deletionRequestedAt) {
        return refuse(409, 'APP_WORK_DELETING', 'This App Work is being deleted.');
    }
    if (!row?.currentDeploymentId || row.removedAt) {
        return refuse(409, 'app_not_deployed', 'Nothing of this App is deployed right now.');
    }
    return null;
}

/** Whether the status snapshot shows a run of `jobName` still going. */
export function jobIsRunning(snapshot: unknown, jobName: string): boolean {
    const jobs = (snapshot as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(jobs)) return false;
    return jobs.some(
        (job: { name?: unknown; last?: { status?: unknown } }) =>
            text(job?.name) === jobName && text(job?.last?.status) === 'running',
    );
}

function checkViewOf(raw: unknown): AppSmokeCheckView | null {
    const check = raw as Record<string, unknown> | null;
    const name = text(check?.name);
    const status = text(check?.status);
    if (!name || (status !== 'passed' && status !== 'failed' && status !== 'skipped')) return null;
    const view: AppSmokeCheckView = { name: name.slice(0, 120), status };
    if (typeof check?.httpStatus === 'number') view.httpStatus = check.httpStatus;
    if (typeof check?.latencyMs === 'number') view.latencyMs = check.latencyMs;
    if (text(check?.failedExpectation)) {
        view.failedExpectation = text(check?.failedExpectation).slice(0, 200);
    }
    if (text(check?.classification)) view.classification = text(check?.classification);
    return view;
}

function checksOf(raw: unknown): AppSmokeCheckView[] {
    return Array.isArray(raw)
        ? raw.map(checkViewOf).filter((check): check is AppSmokeCheckView => check !== null)
        : [];
}

/**
 * `work_deployments.smokeResult` → what the Deploy tab shows. The checks' `found` excerpt (a
 * response body fragment) is dropped: viewers see smoke results too (S28).
 */
export function smokeViewOf(deploymentId: string, raw: unknown): AppSmokeView | null {
    if (!raw || typeof raw !== 'object') return null;
    const result = raw as Record<string, unknown>;
    return {
        deploymentId,
        observedAt: iso(result.observedAt as string | null | undefined),
        inCluster: checksOf(result.inCluster),
        public: checksOf(result.public),
        hairpin: checkViewOf(result.hairpin),
    };
}

/** One Deployment row → one history entry (ids, states, times; never render facts). */
export function historyEntryOf(
    deployment: Record<string, unknown>,
    currentDeploymentId: string,
): AppDeploymentHistoryEntry {
    const render = (deployment.appRender ?? {}) as {
        specCommitSha?: unknown;
        image?: { digest?: unknown };
    };
    const lastError = text(deployment.lastError);
    const smoke = smokeViewOf(String(deployment.id), deployment.smokeResult);
    const checks = smoke ? [...smoke.inCluster, ...smoke.public] : [];
    return {
        id: String(deployment.id),
        state: String(deployment.state ?? ''),
        trigger: text(deployment.appTrigger) || null,
        buildId: text(deployment.buildId) || null,
        commitSha: text(render.specCommitSha) || text(deployment.commitSha) || null,
        imageDigest: text(render.image?.digest) || null,
        createdAt: iso(deployment.createdAt as Date | string | null | undefined),
        completedAt: iso(deployment.completedAt as Date | string | null | undefined),
        current: Boolean(currentDeploymentId) && String(deployment.id) === currentDeploymentId,
        code: lastError ? lastError.split(':')[0].slice(0, 60) : null,
        smoke: smoke
            ? {
                  passed: checks.filter((check) => check.status === 'passed').length,
                  failed: checks.filter((check) => check.status === 'failed').length,
                  observedAt: smoke.observedAt,
              }
            : null,
    };
}

function opStateOf(state: string): AppStatusOpEntry['state'] {
    switch (state) {
        case 'READY':
            return 'done';
        case 'ERROR':
        case 'TIMEOUT':
        case 'ROLLED_BACK':
            return 'failed';
        case 'CANCELED':
        case 'SUPERSEDED':
            return 'cancelled';
        default:
            return 'running';
    }
}
