/**
 * APW-06 T70 — **`AppLifecycleOpsService`**: the nine `app-cluster-op` handlers of plan §9.10
 * (`plan.md:1574`, `:1584-1595`).
 *
 * ## What this file is
 *
 * §9.10 gives the `app-cluster-op` task a router and a body:
 *
 * > `app-cluster-op.router.ts` _(new)_: `handle(payload)` routes by `op`. …
 * > `app-lifecycle-ops.service.ts` _(new)_: the nine op handlers below.
 *
 * The nine are `status-refresh`, `logs`, `pause`, `resume`, `remove`, `cancel-deploy`, `job-run`,
 * `cluster-check` and `ingress-reconcile`. The other six ids §9.2 registers —
 * `prepare-namespace` (T69), `dns-reconcile` (T48), `delete-app-work` (T58) and the three
 * `verification-*` ops (T60) — are **not** here: their owners register them on the router, and a
 * copy in this file would be a rival to theirs.
 *
 * ## The four rules every handler keeps
 *
 * 1. **R-5 — the plugin and the credential come from `AppRuntimeFacadeService`**
 *    (§9.10:1578). Nothing here compares a plugin id against a literal, and the optional member a
 *    handler needs is presence-checked on the **materialised** plugin (the facade's
 *    `bindAppMember` does that, and a plugin that lacks the member is refused
 *    `op_unsupported_on_target` rather than called through a lazy stub).
 * 2. **R-15 — an op on a deleting App Work is refused** (`app_work_deleting`) while
 *    `deletionRequestedAt` is set. The check is made here, from the runtime-state row, **before**
 *    the op's own work; the router makes the same check for the ops it routes elsewhere.
 * 3. **The op's outcome is cacheable.** Every handler but `logs` writes
 *    `app-op:<workId>:<requestId>` = `{ op, state: 'queued'|'running'|'done'|'failed', code? }`
 *    with TTL 300 000 ms, which `GET app-status` returns as `ops[]` (§2.3, §9.10:1580-1582).
 *    `logs` writes `app-logs:<workId>:<requestId>` = `{ state, tail?, code? }` **instead**, and
 *    nothing to `work_deployments`, runtime state or Activity.
 * 4. **Nothing is faked.** Every collaborator another owner still owes is injected `@Optional()`
 *    and every one of them has a **named refusal**; an op that cannot do its work says which
 *    collaborator is missing rather than reporting a green run. The provisional blocks below name
 *    each owner and the one-line swap that replaces the seam.
 *
 * ## What is honestly missing in this tree, and what happens instead
 *
 * | Owner | Seam | Until it lands |
 * | --- | --- | --- |
 * | APW-06 **T17** (`WorkAppRuntimeStateRepository`) | `WORK_APP_RUNTIME_STATES` (imported, never redeclared) | `runtime_state_unavailable` — nothing that writes the row can run |
 * | APW-07 **T16** (`AppDependenciesService`) | `APP_DEPENDENCIES_SERVICE` (T58's token) | `remove` is refused `dependencies_unavailable` by T25's own `removeAppWork` |
 * | APW-06's managed DNS task | `APPS_DOMAIN_DNS_SERVICE` (T58's token) | the record removal is reported `unbound`; the removal itself still completes |
 * | APW-06 **T31/T32** (`APP_CLUSTER_OP_DISPATCHER`) | same token T58 declares | no re-dispatch; the handler returns `deferred` with the wait it would have taken |
 * | APW-06 **T28** (`AppRuntimeEventRelayService`) | `APP_RUNTIME_EVENT_SINK` (T28's token) | the event is not emitted and the result says `events: 'unbound'` |
 * | APW-04 | `targetUpdated` on the check port | reported `unbound`; the check result itself is still recorded |
 *
 * ## The status spec, and the one thing this file has to read to get it
 *
 * `getAppStatus(ref, credential, spec)` needs an `AppStatusSpec` — component names, roles, replicas
 * and which is primary, plus the job and cron names (§3.1). Those are the **App spec's**, so the
 * read is T22's: `AppVerificationSpecSource.readVerificationSpec` is the one spec read the worker
 * binds (`APP_VERIFICATION_SPEC_SOURCE` → `AppRenderInputBuilder`,
 * `trigger-app-runtime.module.ts:267`). It is called with the **live** namespace and a 1-minute
 * ttl, and only the input's component/job/cron blocks are consumed — `purpose`, `deploymentId` and
 * the ttl are render-time facts that `AppStatusSpec` does not carry. `readVerificationSpec` refuses
 * an input it cannot build, and that refusal is reported as `status_spec_unavailable`; the honest
 * fix is a live-spec read on T22's builder, and it is reported as a routed item rather than
 * papered over.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
    AppClusterCheck,
    AppClusterCheckRequest,
    AppJobResult,
    AppJobRunRequest,
    AppLogTail,
    AppScaleResult,
    AppSmokeInput,
    AppStatusSnapshot,
    AppStatusSpec,
    AppTargetRef,
} from '@ever-works/plugin';

import { CACHE_MANAGER, type Cache } from '../cache';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import {
    AppRuntimeFacadeService,
    type AppRuntimeAccessResult,
    type AppRuntimeClusterAccess,
} from '../facades/app-runtime.facade';
import {
    AppDeployOrchestrator,
    type AppRemovalRequest,
    type AppRemovalResult,
} from './app-deploy.orchestrator';
import {
    APP_DEPENDENCIES_SERVICE,
    APP_CLUSTER_OP_DISPATCHER,
    APPS_DOMAIN_DNS_SERVICE,
    type AppClusterOpDispatcher,
    type AppsDomainDnsService,
} from './app-runtime-deletion.service';
import { AppHostsService } from './app-hosts.service';
import { APP_RUNTIME_EVENT_SINK, type AppRuntimeEventSink } from './ports';
import {
    APP_VERIFICATION_SPEC_SOURCE,
    type AppVerificationSpec,
    type AppVerificationSpecRequest,
    type AppVerificationSpecSource,
    statusSpecForSpec,
} from './app-verification-target.service';

/* -------------------------------------------------------------------------- *
 * The op set, and where each op's outcome is cached
 * -------------------------------------------------------------------------- */

/** The nine handlers this file owns, in §9.10's order. */
export const APP_LIFECYCLE_OPS = [
    'status-refresh',
    'logs',
    'pause',
    'resume',
    'remove',
    'cancel-deploy',
    'job-run',
    'cluster-check',
    'ingress-reconcile',
] as const;

export type AppLifecycleOp = (typeof APP_LIFECYCLE_OPS)[number];

/** One op payload, as §9.2's `app-cluster-op` task carries it: the op, the Work and ids. */
export interface AppLifecycleOpPayload {
    op: string;
    workId: string;
    requestId?: string | null;
    userId?: string | null;
    [key: string]: unknown;
}

/** §9.10:1580 — `app-op:<workId>:<requestId>`, the key `GET app-status` reads as `ops[]`. */
export const APP_OP_CACHE_PREFIX = 'app-op:' as const;

/** §9.10:1587 — `app-logs:<workId>:<requestId>`, read only by `GET app-logs/:requestId`. */
export const APP_LOGS_CACHE_PREFIX = 'app-logs:' as const;

/** §9.10:1581 — "TTL 300 000 ms". One constant, so the three writers cannot disagree. */
export const APP_OP_CACHE_TTL_MS = 300_000 as const;

/** §9.10:1589 — the rollout wait beyond which `resume` re-dispatches itself. */
export const APP_RESUME_WAIT_BUDGET_MS = 840_000 as const;

/** §9.10:1592 — the same budget for a still-running `job-run`. */
export const APP_JOB_RUN_WAIT_BUDGET_MS = 840_000 as const;

/** §9.10:1595 — "re-applies only the `Ingress` within 60 s". */
export const APP_INGRESS_RECONCILE_BUDGET_MS = 60_000 as const;

/** §9.10:1586 — the code a connection or credential failure records for `status-refresh`. */
export const APP_OP_CODE_CLUSTER_UNREACHABLE = 'cluster_unreachable' as const;

/** §9.10:1588 — `pause`'s refusal when the deploy lock is held (S27). */
export const APP_OP_CODE_DEPLOY_IN_PROGRESS = 'deploy_in_progress' as const;

/** §9.10:1591 — `cancel-deploy`'s refusal when no Deployment holds the lock. */
export const APP_OP_CODE_NO_DEPLOY_IN_PROGRESS = 'no_deploy_in_progress' as const;

/** R-15 — the refusal every handler makes while a deletion is in flight. */
export const APP_OP_CODE_APP_WORK_DELETING = 'app_work_deleting' as const;

/** §9.10:1578 — "refuses `op_unsupported_on_target` when the resolved plugin lacks the optional member it needs". */
export const APP_OP_CODE_UNSUPPORTED_ON_TARGET = 'op_unsupported_on_target' as const;

/** No runtime-state row can be read, so nothing that writes one can run. */
export const APP_OP_CODE_RUNTIME_STATE_UNAVAILABLE = 'runtime_state_unavailable' as const;

/** The row exists but could not be read — the truth is unknown, so nothing is dialled. */
export const APP_OP_CODE_RUNTIME_STATE_UNREADABLE = 'runtime_state_unreadable' as const;

/** No plugin and credential could be assembled for this Work (T20's own refusal codes). */
export const APP_OP_CODE_FACADE_UNAVAILABLE = 'facade_unavailable' as const;

/** The App spec could not be read, so the `AppStatusSpec` / smoke checks are unknowable. */
export const APP_OP_CODE_STATUS_SPEC_UNAVAILABLE = 'status_spec_unavailable' as const;

/** `logs` with no `requestId` has no key to be read back under. */
export const APP_OP_CODE_REQUEST_ID_REQUIRED = 'request_id_required' as const;

/** APW-07 is not bound, so T25's `removeAppWork` refuses the ordered removal. */
export const APP_OP_CODE_DEPENDENCIES_UNAVAILABLE = 'dependencies_unavailable' as const;

/** The op is not one of §9.10's nine. The router answers this too, for the ops it routes away. */
export const APP_OP_CODE_UNKNOWN_OP = 'unknown_op' as const;

/* -------------------------------------------------------------------------- *
 * Result shapes
 * -------------------------------------------------------------------------- */

/**
 * What one handler reports.
 *
 * `state` is a **string** discriminant on purpose: this package compiles with
 * `strictNullChecks: false` (`tsconfig.json:23`), under which a boolean discriminant stops
 * narrowing a union (`app-runtime.facade.ts:243-251` says the same about its own result).
 *
 * - `done` — the op's work ran and succeeded.
 * - `failed` — the op's work ran and did not succeed (a plugin error, an unreachable cluster).
 * - `refused` — the op never ran: a missing collaborator, a held lock, a deleting Work.
 * - `deferred` — the op ran, could not finish inside its budget, and would re-dispatch itself;
 *   the re-dispatch itself is T31's dispatcher and is reported `unbound` until it lands.
 */
export interface AppLifecycleOpResult {
    op: string;
    workId: string;
    state: 'done' | 'failed' | 'refused' | 'deferred';
    /** A named reason for anything that is not a plain run; never a value, host, token or log line. */
    code: string | null;
    /** Secret-free detail for the caller's log line: counts, names, codes. */
    detail: Record<string, unknown> | null;
    /** The `app-op:` key this handler wrote. `null` for `logs`, which writes `app-logs:` instead. */
    opKey: string | null;
    /** The `app-logs:` key this handler wrote; `null` for every other op. */
    logsKey: string | null;
    /** `written` · `unbound` (no `CACHE_MANAGER` in this context) · `failed` (the write threw). */
    cache: 'written' | 'unbound' | 'failed';
    /** `emitted` · `unbound` (T28's relay has not landed) · `failed`. */
    events: 'emitted' | 'unbound' | 'failed';
}

/** The `app-op:` entry `GET app-status` renders as one row of `ops[]` (§9.10:1580-1582). */
export interface AppOpCacheEntry {
    op: string;
    state: 'queued' | 'running' | 'done' | 'failed';
    code?: string;
}

/** The `app-logs:` entry `GET app-logs/:requestId` reads (§9.10:1587). */
export interface AppLogsCacheEntry {
    state: 'done' | 'failed';
    tail?: AppLogTail;
    code?: string;
}

/** The two cache keys §9.10 names, built in one place so no caller can spell one differently. */
export function appOpCacheKey(workId: unknown, requestId: unknown): string {
    return `${APP_OP_CACHE_PREFIX}${text(workId)}:${text(requestId)}`;
}

export function appLogsCacheKey(workId: unknown, requestId: unknown): string {
    return `${APP_LOGS_CACHE_PREFIX}${text(workId)}:${text(requestId)}`;
}

/* -------------------------------------------------------------------------- *
 * Provisional seams — every one of them is another owner's
 * -------------------------------------------------------------------------- */

// ── provisional — APW-06 T17, the runtime-state row ──────────────────────────
//
// `WorkAppRuntimeStateRepository` is not in this tree. The token is **not** declared here:
// `app-launcher.service.ts:223` declares `WORK_APP_RUNTIME_STATES` and T58, T60, T21, T24 and T25
// all reuse it, so this file declares the *view* §9.10 needs of the same provider. A second
// `Symbol('WORK_APP_RUNTIME_STATES')` would be a different token and would leave this consumer
// unbound (the rule T58 wrote down at `app-runtime-deletion.service.ts:397-401`).
//
// Every method below is a §9.10 row's write, named as T17's repository would name it. Each is
// optional: an unbound or partial store produces a named refusal, never a silent success.

/** One `work_app_runtime_states` row as §9.10's handlers read it (plan §7.2:1042-1072). */
export interface AppLifecycleOpStateView {
    workId?: string | null;
    target?: string | null;
    namespace?: string | null;
    /** The **deployed** cluster. `cluster-check` never writes this column (§9.10:1593). */
    clusterFingerprint?: string | null;
    currentDeploymentId?: string | null;
    deployLockId?: string | null;
    paused?: boolean | null;
    pausedAt?: Date | string | number | null;
    removedAt?: Date | string | number | null;
    deletionRequestedAt?: Date | string | number | null;
    statusSnapshot?: AppStatusSnapshot | null;
    statusObservedAt?: Date | string | number | null;
    ingressAddress?: { ip?: string | null; hostname?: string | null } | null;
}

/**
 * APW-06 T17's `WorkAppRuntimeStateRepository`, as §9.10's nine handlers consume it.
 *
 * `getOrCreate` is the only read. The rest are the writes the op table names, each one atomic
 * where §9.10 says so (`pause`'s conditional UPDATE, `cancel-deploy`'s matching-`deployLockId`
 * UPDATE); a store that cannot answer `false` from one of them is answering "the condition did not
 * hold", which is exactly the refusal the op reports.
 */
export interface AppLifecycleOpStateStore {
    getOrCreate(workId: string): Promise<AppLifecycleOpStateView | null | undefined>;
    /** §9.10:1586 — `saveSnapshot(statusSnapshot, statusObservedAt)`. */
    saveSnapshot?(
        workId: string,
        snapshot: AppStatusSnapshot,
        observedAt: string,
    ): Promise<void> | void;
    /**
     * §9.10:1588-1589 — the paused flag. The `true` half is the atomic conditional UPDATE
     * (`WHERE "deployLockId" IS NULL AND "deletionRequestedAt" IS NULL`); `false` ⇒ the condition
     * did not hold and the caller reports it.
     */
    setPaused?(workId: string, paused: boolean, at: Date): Promise<boolean | void>;
    /** T17's name (T24 declares it too) — `resume` claims it, `cancel-deploy` and `remove` read it. */
    claimDeployLock?(workId: string, deploymentId: string): Promise<boolean | void>;
    releaseDeployLock?(workId: string, deploymentId: string): Promise<boolean | void>;
    /**
     * §9.10:1591 — `UPDATE … SET cancelRequestedAt = now(), cancelRequestedByUserId = :u
     * WHERE workId = :w AND deployLockId = :deploymentId`; zero rows ⇒ `no_deploy_in_progress`.
     */
    requestCancel?(
        workId: string,
        deploymentId: string,
        userId: string | null,
    ): Promise<boolean | void>;
    /** §9.10:1593 — `clusterCheck`, `clusterCheckedAt` and the observed `ingressAddress`. */
    saveClusterCheck?(
        workId: string,
        check: AppClusterCheck & { fingerprint: string },
        checkedAt: string,
        ingressAddress: { ip?: string | null; hostname?: string | null } | null,
    ): Promise<void> | void;
    /** §9.10:1595 / §9.10:1586 — the address a check or a reconcile observed. */
    saveIngressAddress?(
        workId: string,
        address: { ip?: string | null; hostname?: string | null } | null,
    ): Promise<void> | void;
    /** §9.10:1590 — the terminal write of `remove`: `removedAt` set, `currentDeploymentId` cleared. */
    markRemoved?(workId: string, removedAt: Date): Promise<void> | void;
    /** §9.10:1592 — the run's result lands in `statusSnapshot.jobs`. */
    saveJobResult?(workId: string, job: AppJobResult): Promise<void> | void;
}

// ── provisional — APW-06 T22, the one spec read the worker binds ─────────────
//
// The token and the interface are T60's (`app-verification-target.service.ts:530-577`); the worker
// binds `APP_VERIFICATION_SPEC_SOURCE` to `AppRenderInputBuilder`. See the file header for why a
// live status read goes through the verification-shaped request.

// ── provisional — APW-06 T29, the notification producers ─────────────────────
//
// The health producers are T29's (§9.4:1337-1339) and this file does not call them; `pause`,
// `resume`, `remove` and `job-run` emit **events**, which is what §9.10's table asks for.

// ── provisional — APW-06 T31/T32, the op dispatcher ──────────────────────────
//
// `APP_CLUSTER_OP_DISPATCHER` is T58's token, reused rather than redeclared. The two handlers that
// re-dispatch themselves (`resume`, `job-run`) report `deferred` with the wait they would have
// asked for; an unbound dispatcher is named in `detail.dispatch`.

// ── provisional — APW-04's `targetUpdated(workId, namespace)` ────────────────
//
// §9.10:1593 asks `cluster-check` to tell APW-04 the target moved. The port is APW-04's; it is
// declared here as the narrow `@Optional()` seam T60 declared for its own use of the same epic, so
// the check itself still records its result when nothing is bound.

/** APW-04's target-change notification, as `cluster-check` calls it (§9.10:1593). */
export interface AppTargetUpdatedPort {
    targetUpdated?(workId: string, namespace: string | null): Promise<void> | void;
}

/** DI token for {@link AppTargetUpdatedPort} — owned by APW-04. */
export const APP_TARGET_UPDATED_PORT = Symbol('APP_TARGET_UPDATED_PORT');

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/** A method that is present and callable on an `@Optional()` collaborator. */
function hasMember<T>(holder: unknown, name: string): holder is Record<string, T> {
    return !!holder && typeof (holder as Record<string, unknown>)[name] === 'function';
}

/** A trimmed string, or `''`. */
function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** `error.message` when there is one, `String(error)` otherwise, one line and bounded. */
function messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return String(message || 'unknown error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

/** An ISO instant — the caller's clock, never a clock inside a renderer (R-5). */
function isoOf(at: Date | number): string {
    return new Date(at).toISOString();
}

/**
 * The nine op handlers of §9.10, as the router's delegations.
 *
 * Every handler is public so a spec drives it directly, and `handle` is the only entry the router
 * uses. Nothing here throws: a refusal is a `state`, never an exception, because the router has to
 * write the outcome to the cache and report it to the run log either way.
 */
@Injectable()
export class AppLifecycleOpsService {
    private readonly logger = new Logger(AppLifecycleOpsService.name);

    constructor(
        // T20's facade — the only place a plugin and a credential are assembled (R-5). Injected by
        // its class token, which the worker module provides, and typed as the one method §9.10 uses.
        @Optional()
        @Inject(AppRuntimeFacadeService)
        private readonly facade?: AppLifecycleAccessResolver,
        // T26's hosts service — `ingress-reconcile`'s host set (§9.10:1595).
        @Optional()
        @Inject(AppHostsService)
        private readonly hosts?: AppLifecycleHostSource,
        // T25's orchestrator — it owns the two dependency hooks' order (§5.6 step 8).
        @Optional()
        @Inject(AppDeployOrchestrator)
        private readonly removal?: AppLifecycleRemovalOwner,
        // T22's builder, through T60's token — see the header.
        @Optional()
        @Inject(APP_VERIFICATION_SPEC_SOURCE)
        private readonly specs?: AppVerificationSpecSource,
        // The 300 s cache behind `app-op:` / `app-logs:` (§6.4:978).
        @Optional()
        @Inject(CACHE_MANAGER)
        private readonly cache?: Cache,
        // T17's row.
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly states?: AppLifecycleOpStateStore,
        // T28's relay, through the one event-sink port.
        @Optional()
        @Inject(APP_RUNTIME_EVENT_SINK)
        private readonly events?: AppRuntimeEventSink,
        // APW-07 T16 — only `remove`'s ordering depends on it, and T25 owns that call.
        @Optional()
        @Inject(APP_DEPENDENCIES_SERVICE)
        private readonly dependencies?: unknown,
        // The managed DNS record's removal (§9.10:1590).
        @Optional()
        @Inject(APPS_DOMAIN_DNS_SERVICE)
        private readonly appsDns?: AppsDomainDnsService,
        // T31/T32 — the two self-re-dispatching handlers.
        @Optional()
        @Inject(APP_CLUSTER_OP_DISPATCHER)
        private readonly dispatcher?: AppClusterOpDispatcher,
        // APW-04's target-change port.
        @Optional()
        @Inject(APP_TARGET_UPDATED_PORT)
        private readonly targetUpdated?: AppTargetUpdatedPort,
    ) {}

    /* ---------------------------------------------------------------------- *
     * The one entry the router uses
     * ---------------------------------------------------------------------- */

    /** Route one payload to its handler. An op outside §9.10's nine is refused `unknown_op`. */
    async handle(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const op = text(payload?.op);
        const workId = text(payload?.workId);

        if (!workId) {
            return this.refusal(payload, 'invalid_payload', {
                detail: { reason: 'no workId was carried' },
            });
        }

        switch (op as AppLifecycleOp) {
            case 'status-refresh':
                return this.statusRefresh(payload);
            case 'logs':
                return this.logs(payload);
            case 'pause':
                return this.pause(payload);
            case 'resume':
                return this.resume(payload);
            case 'remove':
                return this.remove(payload);
            case 'cancel-deploy':
                return this.cancelDeploy(payload);
            case 'job-run':
                return this.jobRun(payload);
            case 'cluster-check':
                return this.clusterCheck(payload);
            case 'ingress-reconcile':
                return this.ingressReconcile(payload);
            default:
                return this.refusal(payload, APP_OP_CODE_UNKNOWN_OP, {
                    detail: { op, known: [...APP_LIFECYCLE_OPS] },
                });
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1586 — status-refresh
     * ---------------------------------------------------------------------- */

    /**
     * `getAppStatus` → `saveSnapshot(statusSnapshot, statusObservedAt)`.
     *
     * On a connection or credential error the **previous snapshot is kept** and the op is recorded
     * `failed` with `cluster_unreachable` (ACC-06-31: a stale snapshot with an honest failure beats
     * an empty one that reads as "nothing is deployed").
     */
    async statusRefresh(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const getAppStatus = access.access.getAppStatus;
        if (typeof getAppStatus !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'getAppStatus' },
            });
        }

        const spec = await this.statusSpec(workId, access.access);
        if (!spec) {
            return this.refusal(payload, APP_OP_CODE_STATUS_SPEC_UNAVAILABLE, {
                detail: { member: 'getAppStatus' },
            });
        }

        try {
            const snapshot = await getAppStatus(access.access.ref, access.access.credential, spec);
            const observedAt = isoOf(Date.now());
            const saved = await this.saveSnapshot(workId, snapshot, observedAt);

            return this.done(payload, {
                detail: {
                    components: snapshot?.components?.length ?? 0,
                    jobs: snapshot?.jobs?.length ?? 0,
                    observedAt,
                    snapshot: saved,
                },
            });
        } catch (error) {
            // ACC-06-31 — the previous snapshot stays; the op carries the failure.
            this.logger.warn(`status-refresh could not read work ${workId}: ${messageOf(error)}`);

            return this.failed(payload, APP_OP_CODE_CLUSTER_UNREACHABLE, {
                detail: { message: messageOf(error) },
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1587 — logs
     * ---------------------------------------------------------------------- */

    /**
     * `getAppLogs` (already redacted by T13) → `app-logs:<workId>:<requestId>`.
     *
     * **Nothing else is written**: no `work_deployments` row, no runtime state, no Activity. The
     * `workId` prefix is what makes another Work's `requestId` answer 404 on the read side, so a
     * `requestId` is required — without one there is no key a reader could ever name.
     */
    async logs(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const requestId = text(payload?.requestId);
        if (!requestId) {
            return this.refusal(payload, APP_OP_CODE_REQUEST_ID_REQUIRED, {});
        }

        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const getAppLogs = access.access.getAppLogs;
        if (typeof getAppLogs !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'getAppLogs' },
            });
        }

        const key = appLogsCacheKey(workId, requestId);
        const request = this.logRequest(payload);

        try {
            const tail = await getAppLogs(access.access.ref, access.access.credential, request);
            const status = await this.writeLogs(key, { state: 'done', tail });

            return {
                ...this.base(payload, 'done', null),
                opKey: null,
                logsKey: key,
                cache: status,
                events: 'unbound',
                detail: {
                    containers: tail?.containers?.length ?? 0,
                    redactedNames: tail?.redactedNames?.length ?? 0,
                },
            };
        } catch (error) {
            const code = APP_OP_CODE_CLUSTER_UNREACHABLE;
            const status = await this.writeLogs(key, { state: 'failed', code });
            this.logger.warn(`logs could not be read for work ${workId}: ${messageOf(error)}`);

            return {
                ...this.base(payload, 'failed', code),
                opKey: null,
                logsKey: key,
                cache: status,
                events: 'unbound',
                detail: { message: messageOf(error) },
            };
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1588 — pause
     * ---------------------------------------------------------------------- */

    /**
     * The atomic `UPDATE … SET paused = true, pausedAt = now()
     * WHERE workId = :w AND deployLockId IS NULL AND deletionRequestedAt IS NULL`; zero rows is
     * `deploy_in_progress` (S27). Then `scaleApp('pause')`, `app.deploy.paused`, and the snapshot is
     * refreshed.
     */
    async pause(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        const claimed = await this.setPaused(workId, true);
        if (claimed === false) {
            // §9.10:1588 — the conditional UPDATE matched zero rows: a Deployment holds the lock.
            return this.refusal(payload, APP_OP_CODE_DEPLOY_IN_PROGRESS, {
                detail: { deployLockId: guard.state?.deployLockId ?? null },
            });
        }
        if (claimed === null) {
            return this.refusal(payload, APP_OP_CODE_RUNTIME_STATE_UNAVAILABLE, {
                detail: { member: 'setPaused' },
            });
        }

        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const scaleApp = access.access.scaleApp;
        if (typeof scaleApp !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'scaleApp' },
            });
        }

        try {
            const result = await scaleApp(access.access.ref, access.access.credential, 'pause', {});
            const events = await this.emit('app.deploy.paused', {
                workId,
                userId: text(payload?.userId) || null,
                target: access.access.target,
            });
            // §9.10:1588 — "refresh the snapshot" after the scale.
            const refreshed = await this.statusRefresh(payload);

            return {
                ...this.base(
                    payload,
                    refreshed.state === 'refused' ? 'done' : refreshed.state,
                    null,
                ),
                detail: {
                    components: result?.components?.length ?? 0,
                    snapshot: refreshed.detail?.snapshot ?? null,
                },
                events,
            };
        } catch (error) {
            this.logger.warn(`pause failed for work ${workId}: ${messageOf(error)}`);

            return this.failed(payload, APP_OP_CODE_CLUSTER_UNREACHABLE, {
                detail: { message: messageOf(error) },
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1589 — resume
     * ---------------------------------------------------------------------- */

    /**
     * Claim the lock, `scaleApp('resume', <declared replicas>, { smoke, deadlines })`, then clear
     * `paused`, emit `app.deploy.resumed` (with a `code` on failure and **no rollback** — FR-49),
     * save the snapshot and release the lock.
     *
     * When the rollout wait would exceed {@link APP_RESUME_WAIT_BUDGET_MS} the handler answers
     * `deferred` with the `{ stage: 'wait' }` re-dispatch §9.10 asks for; the dispatch itself is
     * T31's and an unbound dispatcher is named in `detail.dispatch`.
     */
    async resume(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const requestId = text(payload?.requestId);
        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        // The plugin and the credential first: a Work with no usable target is refused for *that*
        // reason, not for the spec the target would have rendered.
        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const spec = await this.liveSpec(workId, guard.state);
        if (!spec) {
            return this.refusal(payload, APP_OP_CODE_STATUS_SPEC_UNAVAILABLE, {
                detail: { member: 'scaleApp' },
            });
        }

        const scaleApp = access.access.scaleApp;
        if (typeof scaleApp !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'scaleApp' },
            });
        }

        const claimed = await this.claimLock(workId, requestId);
        if (claimed === false) {
            return this.refusal(payload, APP_OP_CODE_DEPLOY_IN_PROGRESS, {
                detail: { deployLockId: guard.state?.deployLockId ?? null },
            });
        }

        try {
            const result = await scaleApp(
                access.access.ref,
                access.access.credential,
                'resume',
                replicasOf(spec),
                { smoke: smokeInputsOf(spec), deadlines: deadlinesOf(spec) },
            );

            const failure = result?.failure?.code ?? null;
            await this.setPaused(workId, false);
            const events = await this.emit('app.deploy.resumed', {
                workId,
                userId: text(payload?.userId) || null,
                target: access.access.target,
                code: failure,
            });
            // FR-49 — no rollback: the app stays resumed and health notifications follow FR-47.
            const refreshed = await this.statusRefresh(payload);

            return {
                ...this.base(payload, failure ? 'failed' : 'done', failure),
                detail: {
                    components: result?.components?.length ?? 0,
                    smoke: result?.smoke?.checks?.length ?? 0,
                    snapshot: refreshed.detail?.snapshot ?? null,
                },
                events,
            };
        } catch (error) {
            this.logger.warn(`resume failed for work ${workId}: ${messageOf(error)}`);
            await this.setPaused(workId, false);

            return this.failed(payload, APP_OP_CODE_CLUSTER_UNREACHABLE, {
                detail: { message: messageOf(error) },
            });
        } finally {
            await this.releaseLock(workId, requestId);
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1590 — remove
     * ---------------------------------------------------------------------- */

    /**
     * Refuse while the deploy lock is held, then the two §5.6 step 8 orders — with T25's
     * `removeAppWork` owning the dependency hooks so both removal paths stay one implementation:
     *
     * - **with data** (`deleteData`): `onAppRemoved(workId, { deleteData: true })` runs **first**;
     *   when it reports remnants the op ends `may-remain` and **no volume is deleted**;
     * - **keep data**: `destroyApp({ deleteVolumes: false })` first, then
     *   `onAppRemoved(workId, { deleteData: false })`.
     *
     * Then the managed DNS record, `removedAt`, the cleared `currentDeploymentId`, and
     * `app.deploy.removed` with `kept[]`.
     */
    async remove(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const deleteData = payload?.deleteData === true || payload?.deleteStoredData === true;

        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }
        if (text(guard.state?.deployLockId)) {
            return this.refusal(payload, APP_OP_CODE_DEPLOY_IN_PROGRESS, {
                detail: { deployLockId: guard.state?.deployLockId ?? null },
            });
        }

        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const destroyApp = access.access.destroyApp;
        if (typeof destroyApp !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'destroyApp' },
            });
        }

        if (!hasMember<AppLifecycleRemovalOwner['removeAppWork']>(this.removal, 'removeAppWork')) {
            return this.refusal(payload, APP_OP_CODE_DEPENDENCIES_UNAVAILABLE, {
                detail: { member: 'removeAppWork' },
            });
        }

        const removal = await this.orderedRemoval({
            workId,
            deleteData,
            access: access.access,
            destroyApp,
        });
        if (removal.refusal) {
            return this.refusal(payload, removal.refusal, { detail: removal.detail });
        }

        // §9.10:1590 — the managed record goes after the workloads, and a DNS refusal never keeps
        // the runtime: the removal has already happened by this point.
        const dns = await this.removeManagedRecord(workId);
        const marked = await this.markRemoved(workId);
        const events = await this.emit('app.deploy.removed', {
            workId,
            userId: text(payload?.userId) || null,
            target: access.access.target,
            names: removal.kept,
        });

        return {
            ...this.base(payload, removal.remnants.length > 0 ? 'failed' : 'done', removal.code),
            detail: {
                kept: removal.kept,
                mayRemain: removal.remnants,
                namespaceDeleted: removal.namespaceDeleted,
                dns,
                removedAt: marked,
            },
            events,
        };
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1591 — cancel-deploy
     * ---------------------------------------------------------------------- */

    /**
     * `UPDATE … SET cancelRequestedAt = now(), cancelRequestedByUserId = :u
     * WHERE workId = :w AND deployLockId = :deploymentId`; zero rows ⇒ `no_deploy_in_progress`.
     *
     * The matching `deployLockId` is what makes a stale flag harmless: `hooks.isCancelled()` reads
     * the row with the same lock id, and `releaseDeployLock` clears both columns in one UPDATE. The
     * queued Build is left alone.
     *
     * **This is the one handler that does not resolve the plugin and the credential**, and the
     * omission is the contract rather than a shortcut: §9.10:1591's whole body is one UPDATE on the
     * runtime-state row, and requiring a cluster credential for it would refuse a cancel exactly
     * when the cluster is unreachable — which is when a member most needs to stop a Deployment that
     * is going nowhere. Nothing here is dialled, so there is nothing for R-5 to assemble.
     */
    async cancelDeploy(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const deploymentId = text(payload?.deploymentId) || text(payload?.deployLockId);

        if (!deploymentId) {
            return this.refusal(payload, APP_OP_CODE_NO_DEPLOY_IN_PROGRESS, {
                detail: { reason: 'no deploymentId was carried' },
            });
        }

        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        const store = this.states;
        if (!hasMember<AppLifecycleOpStateStore['requestCancel']>(store, 'requestCancel')) {
            return this.refusal(payload, APP_OP_CODE_RUNTIME_STATE_UNAVAILABLE, {
                detail: { member: 'requestCancel' },
            });
        }

        try {
            const matched = await store.requestCancel(
                workId,
                deploymentId,
                text(payload?.userId) || null,
            );
            if (matched === false) {
                return this.refusal(payload, APP_OP_CODE_NO_DEPLOY_IN_PROGRESS, {
                    detail: { deploymentId },
                });
            }

            return this.done(payload, { detail: { deploymentId } });
        } catch (error) {
            return this.failed(payload, APP_OP_CODE_RUNTIME_STATE_UNREADABLE, {
                detail: { message: messageOf(error) },
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1592 — job-run
     * ---------------------------------------------------------------------- */

    /**
     * `runAppJob` with the **live** image, then the result into `statusSnapshot.jobs` and
     * `app.job.succeeded|failed`.
     *
     * A Job of the same name that is still active is refused (`job_active`) rather than started a
     * second time, and a run that is still going near {@link APP_JOB_RUN_WAIT_BUDGET_MS} answers
     * `deferred` for the `{ stage: 'wait', jobName }` re-dispatch §9.10 asks for.
     */
    async jobRun(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const name = text(payload?.jobName);
        if (!name) {
            return this.refusal(payload, 'invalid_payload', {
                detail: { reason: 'no jobName was carried' },
            });
        }

        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const runAppJob = access.access.runAppJob;
        if (typeof runAppJob !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'runAppJob' },
            });
        }

        const spec = await this.liveSpec(workId, guard.state);
        if (!spec) {
            return this.refusal(payload, APP_OP_CODE_STATUS_SPEC_UNAVAILABLE, {
                detail: { member: 'runAppJob' },
            });
        }

        const declared = (spec.input.jobs ?? []).find((job) => text(job?.name) === name);
        if (!declared) {
            return this.refusal(payload, 'unknown_job', { detail: { jobName: name } });
        }

        const active = await this.activeJob(workId, guard.state, name);
        if (active) {
            return this.refusal(payload, 'job_active', { detail: { jobName: name } });
        }

        const image = this.liveImage(guard.state);
        if (!image) {
            return this.refusal(payload, APP_OP_CODE_STATUS_SPEC_UNAVAILABLE, {
                detail: { member: 'runAppJob', reason: 'no recorded image' },
            });
        }

        const request: AppJobRunRequest = {
            name,
            image,
            confirmFirstDeploy: payload?.confirmFirstDeploy === true,
        };

        try {
            const job = await runAppJob(access.access.ref, access.access.credential, request);
            const status = text(job?.status);
            const code = status === 'failed' || status === 'timeout' ? 'job_failed' : null;
            const saved = await this.saveJob(workId, job);

            if (status === 'running') {
                // §9.10:1592 — still active near the budget: the caller waits and comes back with
                // `job-run { stage: 'wait', jobName }`.
                return {
                    ...this.base(payload, 'deferred', null),
                    detail: {
                        jobName: name,
                        stage: 'wait',
                        budgetMs: APP_JOB_RUN_WAIT_BUDGET_MS,
                        dispatch: this.dispatchState(),
                    },
                };
            }

            const events = await this.emit(code ? 'app.job.failed' : 'app.job.succeeded', {
                workId,
                userId: text(payload?.userId) || null,
                target: access.access.target,
                code,
                names: [name],
            });

            return {
                ...this.base(payload, code ? 'failed' : 'done', code),
                detail: { jobName: name, status, runName: job?.runName ?? null, saved },
                events,
            };
        } catch (error) {
            this.logger.warn(`job-run ${name} failed for work ${workId}: ${messageOf(error)}`);

            return this.failed(payload, 'job_failed', {
                detail: { jobName: name, message: messageOf(error) },
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1593 — cluster-check
     * ---------------------------------------------------------------------- */

    /**
     * §6.1's guard runs inside the plugin; `checkAppCluster` then supplies the fingerprint, the
     * missing permissions and the observed `ingressAddress`.
     *
     * It **never** writes the `clusterFingerprint` **column**: that column is the *deployed*
     * cluster, written by §5.6, so a check of a different cluster can never silently re-point a live
     * app (ACC-06-05, ACC-06-54). The fingerprint lives inside `clusterCheck`.
     */
    async clusterCheck(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const checkAppCluster = access.access.checkAppCluster;
        if (typeof checkAppCluster !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'checkAppCluster' },
            });
        }

        const namespace = text(payload?.namespace) || text(guard.state?.namespace) || null;
        const request: AppClusterCheckRequest = {
            namespace,
            needsCreateNamespace: namespace === null,
        };

        try {
            const check = await checkAppCluster(access.access.credential, request);
            const result = { ...check, fingerprint: text(check?.fingerprint) };
            const ingressAddress = check?.error ? null : this.ingressAddressOf(check);
            const checkedAt = isoOf(Date.now());
            const saved = await this.saveClusterCheck(workId, result, checkedAt, ingressAddress);

            // §9.10:1593 — after the check, not before: APW-04 is told the target moved only once
            // the check that re-read it has an answer.
            const notified = await this.notifyTargetUpdated(workId, namespace);

            return this.done(payload, {
                detail: {
                    ok: check?.ok === true,
                    fingerprint: result.fingerprint,
                    controllerNamespace: text(check?.controllerNamespace) || null,
                    ingressAddress,
                    checkedAt,
                    saved,
                    targetUpdated: notified,
                },
            });
        } catch (error) {
            this.logger.warn(`cluster-check failed for work ${workId}: ${messageOf(error)}`);

            return this.failed(payload, APP_OP_CODE_CLUSTER_UNREACHABLE, {
                detail: { message: messageOf(error) },
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1595 — ingress-reconcile
     * ---------------------------------------------------------------------- */

    /**
     * The hosts from T26's service, `publishAppHosts(...)`, then the address it observed is saved.
     *
     * **Zero `deployApp` calls** (ACC-06-25): this op is the one that must be able to fix a DNS
     * record without touching a single workload, which is why it cannot go through the orchestrator.
     */
    async ingressReconcile(payload: AppLifecycleOpPayload): Promise<AppLifecycleOpResult> {
        const workId = text(payload?.workId);
        const guard = await this.guard(workId);
        if (guard.refusal) {
            return this.refusal(payload, guard.refusal, { detail: guard.detail });
        }

        const access = await this.access(workId);
        if (access.refusal) {
            return this.refusal(payload, access.refusal, { detail: access.detail });
        }

        const publishAppHosts = access.access.publishAppHosts;
        if (typeof publishAppHosts !== 'function') {
            return this.refusal(payload, APP_OP_CODE_UNSUPPORTED_ON_TARGET, {
                detail: { member: 'publishAppHosts' },
            });
        }

        const hosts = await this.hostSet(workId);
        if (!hosts) {
            return this.refusal(payload, 'hosts_unavailable', {
                detail: { member: 'resolveHosts' },
            });
        }

        try {
            const published = await publishAppHosts(access.access.ref, access.access.credential, {
                primary: hosts.primary,
                extra: [...hosts.extra],
                previous: [...hosts.previous],
                tls: hosts.tls,
                issuer: hosts.issuer,
            });
            const ingressAddress = published?.ingressAddress ?? null;
            const saved = await this.saveIngressAddress(workId, ingressAddress);

            return this.done(payload, {
                detail: {
                    primary: hosts.primary,
                    extra: hosts.extra.length,
                    previous: hosts.previous.length,
                    ingressAddress,
                    tls: hosts.tls,
                    budgetMs: APP_INGRESS_RECONCILE_BUDGET_MS,
                    saved,
                    // ACC-06-25's own evidence: this op never renders a Deployment.
                    deployAppCalls: 0,
                },
            });
        } catch (error) {
            this.logger.warn(`ingress-reconcile failed for work ${workId}: ${messageOf(error)}`);

            return this.failed(payload, APP_OP_CODE_CLUSTER_UNREACHABLE, {
                detail: { message: messageOf(error) },
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * Guards and shared reads
     * ---------------------------------------------------------------------- */

    /** R-15 + the row the handlers read. Nothing is dialled when the row cannot be read. */
    private async guard(workId: string): Promise<{
        refusal: string | null;
        detail: Record<string, unknown> | null;
        state: AppLifecycleOpStateView | null;
    }> {
        const store = this.states;
        if (!hasMember<AppLifecycleOpStateStore['getOrCreate']>(store, 'getOrCreate')) {
            return {
                refusal: APP_OP_CODE_RUNTIME_STATE_UNAVAILABLE,
                detail: { member: 'getOrCreate' },
                state: null,
            };
        }

        let state: AppLifecycleOpStateView | null = null;
        try {
            state = (await store.getOrCreate(workId)) ?? null;
        } catch (error) {
            return {
                refusal: APP_OP_CODE_RUNTIME_STATE_UNREADABLE,
                detail: { message: messageOf(error) },
                state: null,
            };
        }

        if (state?.deletionRequestedAt) {
            return {
                refusal: APP_OP_CODE_APP_WORK_DELETING,
                detail: { deletionRequestedAt: String(state.deletionRequestedAt) },
                state,
            };
        }

        return { refusal: null, detail: null, state };
    }

    /** The plugin and the credential, or the facade's own refusal, mapped to one code. */
    private async access(workId: string): Promise<{
        refusal: string | null;
        detail: Record<string, unknown> | null;
        access: AppLifecycleAccess;
    }> {
        if (
            !hasMember<AppLifecycleAccessResolver['resolveClusterAccess']>(
                this.facade,
                'resolveClusterAccess',
            )
        ) {
            return {
                refusal: APP_OP_CODE_FACADE_UNAVAILABLE,
                detail: { member: 'resolveClusterAccess' },
                access: null as unknown as AppLifecycleAccess,
            };
        }

        let resolved: AppRuntimeAccessResult;
        try {
            resolved = await this.facade.resolveClusterAccess(workId);
        } catch (error) {
            return {
                refusal: APP_OP_CODE_FACADE_UNAVAILABLE,
                detail: { message: messageOf(error) },
                access: null as unknown as AppLifecycleAccess,
            };
        }

        if (resolved?.outcome === 'refused') {
            // T20's own closed union — `not_found`, `target_none`, `target_unavailable`,
            // `tier_closed`, `target_not_checked`, `cluster_unreachable`, `runtime_state_unreadable`
            // — reported verbatim rather than remapped into a second vocabulary.
            return {
                refusal: text(resolved.refusal) || APP_OP_CODE_FACADE_UNAVAILABLE,
                detail: { facade: 'refused' },
                access: null as unknown as AppLifecycleAccess,
            };
        }

        const cluster = resolved?.access as AppRuntimeClusterAccess;
        if (!cluster?.ref) {
            return {
                refusal: APP_OP_CODE_FACADE_UNAVAILABLE,
                detail: { facade: 'no access' },
                access: null as unknown as AppLifecycleAccess,
            };
        }

        return {
            refusal: null,
            detail: null,
            access: {
                target: cluster.target,
                ref: cluster.ref,
                credential: cluster.credential,
                getAppStatus: bindMember<
                    (
                        ref: AppTargetRef,
                        credential: string,
                        spec: AppStatusSpec,
                    ) => Promise<AppStatusSnapshot>
                >(cluster.plugin, 'getAppStatus'),
                getAppLogs: bindMember<
                    (ref: AppTargetRef, credential: string, req: unknown) => Promise<AppLogTail>
                >(cluster.plugin, 'getAppLogs'),
                scaleApp: bindMember<
                    (
                        ref: AppTargetRef,
                        credential: string,
                        mode: 'pause' | 'resume',
                        replicas: Record<string, number>,
                        checks?: { smoke: AppSmokeInput[]; deadlines: Record<string, number> },
                    ) => Promise<AppScaleResult>
                >(cluster.plugin, 'scaleApp'),
                destroyApp: bindMember<
                    (
                        ref: AppTargetRef,
                        credential: string,
                        opts: { deleteVolumes: boolean },
                    ) => Promise<{
                        deleted: readonly unknown[];
                        kept: readonly unknown[];
                        namespaceDeleted: boolean;
                    }>
                >(cluster.plugin, 'destroyApp'),
                runAppJob: bindMember<
                    (
                        ref: AppTargetRef,
                        credential: string,
                        job: AppJobRunRequest,
                    ) => Promise<AppJobResult>
                >(cluster.plugin, 'runAppJob'),
                checkAppCluster: bindMember<
                    (credential: string, req: AppClusterCheckRequest) => Promise<AppClusterCheck>
                >(cluster.plugin, 'checkAppCluster'),
                publishAppHosts: bindMember<
                    (
                        ref: AppTargetRef,
                        credential: string,
                        hosts: {
                            primary: string | null;
                            extra: string[];
                            previous: string[];
                            tls: string;
                            issuer: string | null;
                        },
                    ) => Promise<{
                        ingressAddress: { ip?: string; hostname?: string } | null;
                    }>
                >(cluster.plugin, 'publishAppHosts'),
            },
        };
    }

    /**
     * The live `AppStatusSpec`, from T22's one spec read (see the header).
     *
     * The request carries the **live** namespace and a 1-minute ttl — the smallest value
     * `readVerificationSpec` accepts — because a status read writes no namespace annotation; only
     * the input's component/job/cron blocks are consumed, and those are the App spec's at the
     * Deployment's commit.
     */
    private async statusSpec(
        workId: string,
        access: AppLifecycleAccess,
    ): Promise<AppStatusSpec | null> {
        const spec = await this.readSpec(workId, access);
        return spec ? statusSpecOf(spec) : null;
    }

    /** The live spec itself, for `resume`'s replicas/checks and `job-run`'s declared job. */
    private liveSpec(
        workId: string,
        state: AppLifecycleOpStateView | null,
    ): Promise<AppVerificationSpec | null> {
        return this.readSpec(workId, null, state);
    }

    private async readSpec(
        workId: string,
        access: AppLifecycleAccess | null,
        knownState?: AppLifecycleOpStateView | null,
    ): Promise<AppVerificationSpec | null> {
        if (
            !hasMember<AppVerificationSpecSource['readVerificationSpec']>(
                this.specs,
                'readVerificationSpec',
            )
        ) {
            return null;
        }

        const state = knownState !== undefined && knownState !== null ? knownState : null;
        const namespace = text(state?.namespace) || text(access?.ref?.namespace);
        if (!namespace) {
            return null;
        }

        const request: AppVerificationSpecRequest = {
            workId,
            namespace,
            provisioningId: text(state?.currentDeploymentId) || workId,
            attempt: 1,
            specCommitSha: this.specCommitSha(state),
            buildId: null,
            imageDigest: null,
            // The smallest ttl `readVerificationSpec` accepts; nothing here writes an annotation.
            ttlMinutes: 1,
        };

        try {
            const spec = await this.specs.readVerificationSpec(request);
            return spec?.input ? spec : null;
        } catch (error) {
            this.logger.warn(
                `The App spec for work ${workId} could not be read: ${messageOf(error)}`,
            );
            return null;
        }
    }

    /** The commit the live spec is read at: the row's own, when the row carries one. */
    private specCommitSha(state: AppLifecycleOpStateView | null): string | null {
        const row = state as unknown as {
            specCommitSha?: string | null;
            commitSha?: string | null;
        };
        return text(row?.specCommitSha) || text(row?.commitSha) || null;
    }

    /* ---------------------------------------------------------------------- *
     * §9.10:1590 — the two removal orders, and the record
     * ---------------------------------------------------------------------- */

    private async orderedRemoval(input: {
        workId: string;
        deleteData: boolean;
        access: AppLifecycleAccess;
        destroyApp: NonNullable<AppLifecycleAccess['destroyApp']>;
    }): Promise<{
        refusal: string | null;
        detail: Record<string, unknown> | null;
        kept: string[];
        remnants: string[];
        code: string | null;
        namespaceDeleted: boolean;
    }> {
        const { workId, deleteData, access, destroyApp } = input;
        const request: AppRemovalRequest = { workId, deleteData };

        let dependencies: AppRemovalResult;
        try {
            dependencies = deleteData
                ? await this.removal.removeAppWork({ ...request, deleteData: true })
                : ({
                      status: 'removed',
                      code: null,
                      reason: null,
                      mayRemain: [],
                  } as AppRemovalResult);
        } catch (error) {
            return {
                refusal: APP_OP_CODE_DEPENDENCIES_UNAVAILABLE,
                detail: { message: messageOf(error) },
                kept: [],
                remnants: [],
                code: null,
                namespaceDeleted: false,
            };
        }

        if (deleteData && dependencies?.status === 'refused') {
            return {
                refusal: text(dependencies.code) || APP_OP_CODE_DEPENDENCIES_UNAVAILABLE,
                detail: { message: dependencies.reason ?? null },
                kept: [],
                remnants: [],
                code: null,
                namespaceDeleted: false,
            };
        }

        if (deleteData && (dependencies?.mayRemain?.length ?? 0) > 0) {
            // §9.10:1590 — "`remaining` ⇒ end with `mayRemain[]` and delete no volume".
            return {
                refusal: null,
                detail: { reason: dependencies.reason ?? null },
                kept: [],
                remnants: [...dependencies.mayRemain],
                code: text(dependencies.code) || 'dependencies_remaining',
                namespaceDeleted: false,
            };
        }

        let destroyed: Awaited<ReturnType<NonNullable<AppLifecycleAccess['destroyApp']>>>;
        try {
            destroyed = await destroyApp(access.ref, access.credential, {
                deleteVolumes: deleteData,
            });
        } catch (error) {
            return {
                refusal: APP_OP_CODE_CLUSTER_UNREACHABLE,
                detail: { message: messageOf(error) },
                kept: [],
                remnants: [],
                code: null,
                namespaceDeleted: false,
            };
        }

        if (!deleteData) {
            // The keep-data order: `destroyApp` first, then the dependency hook (§5.6 step 8).
            try {
                await this.removal.removeAppWork({ ...request, deleteData: false });
            } catch (error) {
                this.logger.warn(
                    `The dependency hook for work ${workId} failed after the destroy: ${messageOf(error)}`,
                );
            }
        }

        return {
            refusal: null,
            detail: null,
            kept: objectNames(destroyed?.kept),
            remnants: [],
            code: null,
            namespaceDeleted: destroyed?.namespaceDeleted === true,
        };
    }

    /** §9.10:1590 — "Then remove the managed DNS record". A refusal is reported, never fatal. */
    private async removeManagedRecord(
        workId: string,
    ): Promise<'removed' | 'nothing' | 'unbound' | 'failed'> {
        if (!hasMember<AppsDomainDnsService['removeRecord']>(this.appsDns, 'removeRecord')) {
            return 'unbound';
        }
        try {
            const removed = await this.appsDns.removeRecord(workId);
            return removed === false ? 'nothing' : 'removed';
        } catch (error) {
            this.logger.warn(
                `The managed DNS record for work ${workId} could not be removed: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    /* ---------------------------------------------------------------------- *
     * The runtime-state writes, each reported rather than assumed
     * ---------------------------------------------------------------------- */

    private async saveSnapshot(
        workId: string,
        snapshot: AppStatusSnapshot,
        observedAt: string,
    ): Promise<'written' | 'unbound' | 'failed'> {
        const store = this.states;
        if (!hasMember<AppLifecycleOpStateStore['saveSnapshot']>(store, 'saveSnapshot')) {
            return 'unbound';
        }
        try {
            await store.saveSnapshot(workId, snapshot, observedAt);
            return 'written';
        } catch (error) {
            this.logger.warn(
                `The status snapshot for work ${workId} could not be saved: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    /** `true` ⇒ the conditional UPDATE matched; `false` ⇒ it did not; `null` ⇒ no store. */
    private async setPaused(workId: string, paused: boolean): Promise<boolean | null> {
        const store = this.states;
        if (!hasMember<AppLifecycleOpStateStore['setPaused']>(store, 'setPaused')) {
            return null;
        }
        try {
            const answer = await store.setPaused(workId, paused, new Date());
            if (answer === false) {
                return false;
            }
            return true;
        } catch (error) {
            this.logger.warn(
                `The paused flag for work ${workId} could not be written: ${messageOf(error)}`,
            );
            return null;
        }
    }

    private async claimLock(workId: string, requestId: string): Promise<boolean | null> {
        const store = this.states;
        if (
            !text(requestId) ||
            !hasMember<AppLifecycleOpStateStore['claimDeployLock']>(store, 'claimDeployLock')
        ) {
            return null;
        }
        try {
            return (await store.claimDeployLock(workId, requestId)) === false ? false : true;
        } catch (error) {
            this.logger.warn(
                `The deploy lock for work ${workId} could not be claimed: ${messageOf(error)}`,
            );
            return null;
        }
    }

    private async releaseLock(workId: string, requestId: string): Promise<void> {
        const store = this.states;
        if (
            !text(requestId) ||
            !hasMember<AppLifecycleOpStateStore['releaseDeployLock']>(store, 'releaseDeployLock')
        ) {
            return;
        }
        try {
            await store.releaseDeployLock(workId, requestId);
        } catch (error) {
            this.logger.warn(
                `The deploy lock for work ${workId} could not be released: ${messageOf(error)}`,
            );
        }
    }

    private async markRemoved(workId: string): Promise<string | null> {
        const store = this.states;
        if (!hasMember<AppLifecycleOpStateStore['markRemoved']>(store, 'markRemoved')) {
            return null;
        }
        const at = new Date();
        try {
            await store.markRemoved(workId, at);
            return isoOf(at.getTime());
        } catch (error) {
            this.logger.warn(
                `The removal of work ${workId} could not be recorded: ${messageOf(error)}`,
            );
            return null;
        }
    }

    private async saveClusterCheck(
        workId: string,
        check: AppClusterCheck & { fingerprint: string },
        checkedAt: string,
        ingressAddress: { ip?: string | null; hostname?: string | null } | null,
    ): Promise<'written' | 'unbound' | 'failed'> {
        const store = this.states;
        if (!hasMember<AppLifecycleOpStateStore['saveClusterCheck']>(store, 'saveClusterCheck')) {
            return 'unbound';
        }
        try {
            await store.saveClusterCheck(workId, check, checkedAt, ingressAddress);
            return 'written';
        } catch (error) {
            this.logger.warn(
                `The cluster check for work ${workId} could not be saved: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    private async saveIngressAddress(
        workId: string,
        address: { ip?: string | null; hostname?: string | null } | null,
    ): Promise<'written' | 'unbound' | 'failed'> {
        const store = this.states;
        if (
            !hasMember<AppLifecycleOpStateStore['saveIngressAddress']>(store, 'saveIngressAddress')
        ) {
            return 'unbound';
        }
        try {
            await store.saveIngressAddress(workId, address);
            return 'written';
        } catch (error) {
            this.logger.warn(
                `The ingress address for work ${workId} could not be saved: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    private async saveJob(
        workId: string,
        job: AppJobResult,
    ): Promise<'written' | 'unbound' | 'failed'> {
        const store = this.states;
        if (!hasMember<AppLifecycleOpStateStore['saveJobResult']>(store, 'saveJobResult')) {
            return 'unbound';
        }
        try {
            await store.saveJobResult(workId, job);
            return 'written';
        } catch (error) {
            this.logger.warn(
                `The job result for work ${workId} could not be saved: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    /* ---------------------------------------------------------------------- *
     * The small reads
     * ---------------------------------------------------------------------- */

    /** The `AppLogRequest` §4.8's limits are applied to, from the payload's own fields. */
    private logRequest(payload: AppLifecycleOpPayload): {
        component?: string;
        job?: string;
        deploymentId?: string;
        previous?: boolean;
        lines: number;
        secretValues: Record<string, string>;
    } {
        const lines = Number(payload?.lines);
        const secrets = payload?.secretValues;

        return {
            component: text(payload?.component) || undefined,
            job: text(payload?.job) || undefined,
            deploymentId: text(payload?.deploymentId) || undefined,
            previous: payload?.previous === true,
            // §4.8: 1–500, 200 by default. Bounded here so no caller can ask for more.
            lines: Number.isFinite(lines) ? Math.min(500, Math.max(1, Math.floor(lines))) : 200,
            secretValues:
                secrets && typeof secrets === 'object' ? (secrets as Record<string, string>) : {},
        };
    }

    /** The live image a `job-run` uses: the current Deployment's recorded reference. */
    private liveImage(state: AppLifecycleOpStateView | null): string | null {
        const row = state as unknown as {
            imageReference?: string | null;
            appRender?: { image?: { reference?: string | null } | null } | null;
        };
        return text(row?.imageReference) || text(row?.appRender?.image?.reference) || null;
    }

    /** §9.10:1592 — the Job of the same name that is still active, if the snapshot knows one. */
    private async activeJob(
        workId: string,
        state: AppLifecycleOpStateView | null,
        name: string,
    ): Promise<boolean> {
        const jobs = state?.statusSnapshot?.jobs ?? [];
        const entry = jobs.find((job) => text(job?.name) === name);
        if (text(entry?.last?.status) === 'running') {
            return true;
        }

        return (await this.jobState(workId, name)) === 'running';
    }

    private async jobState(workId: string, name: string): Promise<string | null> {
        const store = this.states as unknown as {
            findJobState?: (workId: string, name: string) => Promise<string | null>;
        };
        if (
            !hasMember<(workId: string, name: string) => Promise<string | null>>(
                store,
                'findJobState',
            )
        ) {
            return null;
        }
        try {
            return text(await store.findJobState(workId, name)) || null;
        } catch {
            return null;
        }
    }

    /** The T26 host set, as §9.10:1595's `publishAppHosts` call needs it. */
    private async hostSet(workId: string): Promise<{
        primary: string | null;
        extra: string[];
        previous: string[];
        tls: string;
        issuer: string | null;
    } | null> {
        if (!hasMember<AppLifecycleHostSource['resolveHosts']>(this.hosts, 'resolveHosts')) {
            return null;
        }

        try {
            const hosts = await this.hosts.resolveHosts(workId);
            if (!hosts) {
                return null;
            }
            const settings = hosts as unknown as { tls?: string | null; issuer?: string | null };

            return {
                primary: text(hosts.primary) || null,
                extra: [...(hosts.extra ?? [])],
                previous: [...(hosts.previous ?? [])],
                tls: text(settings.tls) || 'none',
                issuer: text(settings.issuer) || null,
            };
        } catch (error) {
            this.logger.warn(
                `The published hosts for work ${workId} could not be read: ${messageOf(error)}`,
            );
            return null;
        }
    }

    /** §6.3:1002-1005 — the address the check observed, which only a successful check may carry. */
    private ingressAddressOf(
        check: AppClusterCheck,
    ): { ip?: string | null; hostname?: string | null } | null {
        const address = (
            check as unknown as { ingressAddress?: { ip?: string; hostname?: string } }
        )?.ingressAddress;
        return address ?? null;
    }

    /** §9.10:1593 — APW-04's `targetUpdated`, reported rather than assumed. */
    private async notifyTargetUpdated(
        workId: string,
        namespace: string | null,
    ): Promise<'notified' | 'unbound' | 'failed'> {
        if (
            !hasMember<AppTargetUpdatedPort['targetUpdated']>(this.targetUpdated, 'targetUpdated')
        ) {
            return 'unbound';
        }
        try {
            await this.targetUpdated.targetUpdated(workId, namespace);
            return 'notified';
        } catch (error) {
            this.logger.warn(
                `APW-04's targetUpdated for work ${workId} failed: ${messageOf(error)}`,
            );
            return 'failed';
        }
    }

    /** §9.10:1589 / :1592 — the dispatcher the two self-re-dispatching ops would use. */
    private dispatchState(): 'available' | 'unbound' {
        return hasMember<AppClusterOpDispatcher['dispatch']>(this.dispatcher, 'dispatch')
            ? 'available'
            : 'unbound';
    }

    /* ---------------------------------------------------------------------- *
     * The cache, the events and the result builders
     * ---------------------------------------------------------------------- */

    private async writeOp(
        key: string,
        entry: AppOpCacheEntry,
    ): Promise<'written' | 'unbound' | 'failed'> {
        if (!this.cache || typeof this.cache.set !== 'function') {
            return 'unbound';
        }
        try {
            await this.cache.set(key, entry, APP_OP_CACHE_TTL_MS);
            return 'written';
        } catch (error) {
            this.logger.warn(`The op entry ${key} could not be cached: ${messageOf(error)}`);
            return 'failed';
        }
    }

    private async writeLogs(
        key: string,
        entry: AppLogsCacheEntry,
    ): Promise<'written' | 'unbound' | 'failed'> {
        if (!this.cache || typeof this.cache.set !== 'function') {
            return 'unbound';
        }
        try {
            await this.cache.set(key, entry, APP_OP_CACHE_TTL_MS);
            return 'written';
        } catch (error) {
            this.logger.warn(`The log entry ${key} could not be cached: ${messageOf(error)}`);
            return 'failed';
        }
    }

    /** T28's sink, or a named `unbound`. An event that cannot be emitted is never pretended. */
    private async emit(
        name: string,
        payload: Record<string, unknown>,
    ): Promise<'emitted' | 'unbound' | 'failed'> {
        if (!hasMember<AppRuntimeEventSink['emit']>(this.events, 'emit')) {
            return 'unbound';
        }
        try {
            await this.events.emit({ name, payload });
            return 'emitted';
        } catch (error) {
            this.logger.warn(`The ${name} event could not be emitted: ${messageOf(error)}`);
            return 'failed';
        }
    }

    private base(
        payload: AppLifecycleOpPayload,
        state: AppLifecycleOpResult['state'],
        code: string | null,
    ): AppLifecycleOpResult {
        return {
            op: text(payload?.op),
            workId: text(payload?.workId),
            state,
            code,
            detail: null,
            opKey: null,
            logsKey: null,
            cache: 'unbound',
            events: 'unbound',
        };
    }

    private async done(
        payload: AppLifecycleOpPayload,
        opts: { detail?: Record<string, unknown> | null },
    ): Promise<AppLifecycleOpResult> {
        return this.settle(payload, 'done', null, null, opts?.detail ?? null);
    }

    private async failed(
        payload: AppLifecycleOpPayload,
        code: string,
        opts: { detail?: Record<string, unknown> | null },
    ): Promise<AppLifecycleOpResult> {
        return this.settle(payload, 'failed', code, code, opts?.detail ?? null);
    }

    private async refusal(
        payload: AppLifecycleOpPayload,
        code: string,
        opts: { detail?: Record<string, unknown> | null },
    ): Promise<AppLifecycleOpResult> {
        return this.settle(payload, 'refused', code, code, opts?.detail ?? null);
    }

    /**
     * The one place an outcome becomes a row: the cache entry is written for every op **but**
     * `logs` (which has its own key and writes it itself), and the result carries what happened to
     * that write rather than assuming it.
     */
    private async settle(
        payload: AppLifecycleOpPayload,
        state: AppLifecycleOpResult['state'],
        code: string | null,
        cacheCode: string | null,
        detail: Record<string, unknown> | null,
    ): Promise<AppLifecycleOpResult> {
        const base = this.base(payload, state, code);
        const workId = base.workId;
        const requestId = text(payload?.requestId);
        const op = base.op;

        if (op === 'logs' || !workId || !requestId) {
            return { ...base, detail };
        }

        const opKey = appOpCacheKey(workId, requestId);
        const cache = await this.writeOp(opKey, {
            op,
            state: state === 'refused' ? 'failed' : state === 'failed' ? 'failed' : 'done',
            ...(cacheCode ? { code: cacheCode } : {}),
        });

        return { ...base, opKey, cache, detail };
    }
}

/* -------------------------------------------------------------------------- *
 * Shapes and pure helpers
 * -------------------------------------------------------------------------- */

/** The plugin members §9.10's handlers call, already bound to the resolved plugin (R-5). */
export interface AppLifecycleAccess {
    target: 'your-cluster' | 'ever-works-apps';
    ref: AppTargetRef;
    credential: string;
    getAppStatus?: (
        ref: AppTargetRef,
        credential: string,
        spec: AppStatusSpec,
    ) => Promise<AppStatusSnapshot>;
    getAppLogs?: (ref: AppTargetRef, credential: string, req: unknown) => Promise<AppLogTail>;
    scaleApp?: (
        ref: AppTargetRef,
        credential: string,
        mode: 'pause' | 'resume',
        replicas: Record<string, number>,
        checks?: { smoke: AppSmokeInput[]; deadlines: Record<string, number> },
    ) => Promise<AppScaleResult>;
    destroyApp?: (
        ref: AppTargetRef,
        credential: string,
        opts: { deleteVolumes: boolean },
    ) => Promise<{
        deleted: readonly unknown[];
        kept: readonly unknown[];
        namespaceDeleted: boolean;
    }>;
    runAppJob?: (
        ref: AppTargetRef,
        credential: string,
        job: AppJobRunRequest,
    ) => Promise<AppJobResult>;
    checkAppCluster?: (credential: string, req: AppClusterCheckRequest) => Promise<AppClusterCheck>;
    publishAppHosts?: (
        ref: AppTargetRef,
        credential: string,
        hosts: {
            primary: string | null;
            extra: string[];
            previous: string[];
            tls: string;
            issuer: string | null;
        },
    ) => Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }>;
}

/** T20's facade, as this file consumes it — one method, one result union (R-5). */
export interface AppLifecycleAccessResolver {
    resolveClusterAccess(workId: string): Promise<AppRuntimeAccessResult>;
}

/** T26's `AppHostsService`, as `ingress-reconcile` consumes it. */
export interface AppLifecycleHostSource {
    resolveHosts(workId: string): Promise<{
        primary: string | null;
        extra: readonly string[];
        previous: readonly string[];
    } | null>;
}

/** T25's `AppDeployOrchestrator`, as `remove` consumes it — it owns §5.6 step 8's order. */
export interface AppLifecycleRemovalOwner {
    removeAppWork(request: AppRemovalRequest): Promise<AppRemovalResult>;
}

/** An optional plugin member, bound to the plugin — the facade's own rule, restated here. */
export function bindMember<T>(plugin: unknown, name: string): T | undefined {
    const member = (plugin as Record<string, unknown> | undefined)?.[name];
    if (typeof member !== 'function') {
        return undefined;
    }
    return (member as (...args: unknown[]) => unknown).bind(plugin) as unknown as T;
}

/** §3.1's `AppStatusSpec`, from the live spec — components, jobs **and** cron. */
export function statusSpecOf(spec: AppVerificationSpec): AppStatusSpec {
    const fromVerification = statusSpecForSpec(spec);

    return {
        ...fromVerification,
        // T60's mapper answers `cron: []` because a verification renders no CronJob (§4.12:649-652);
        // a live status read observes them, and §9.10:1586's snapshot carries their last runs.
        cron: (spec?.input?.cron ?? []).map((entry) => String(entry?.name ?? '')),
    };
}

/** The declared replicas per component — `scaleApp('resume', …)`'s fourth argument (FR-49). */
export function replicasOf(spec: AppVerificationSpec): Record<string, number> {
    const replicas: Record<string, number> = {};
    for (const component of spec?.input?.components ?? []) {
        const name = text(component?.name);
        if (name) {
            replicas[name] = Number(component?.replicas ?? 0);
        }
    }
    return replicas;
}

/** The App spec's smoke checks — the phase-5 checks a resume re-runs (§9.10:1589). */
export function smokeInputsOf(spec: AppVerificationSpec): AppSmokeInput[] {
    return [...(spec?.input?.smoke ?? [])].map((check) => ({ ...check }));
}

/** The per-component rollout deadline `isComponentRolledOut` waits on (§5.3, §9.10:1589). */
export function deadlinesOf(spec: AppVerificationSpec): Record<string, number> {
    const deadlines: Record<string, number> = {};
    for (const component of spec?.input?.components ?? []) {
        const name = text(component?.name);
        if (name) {
            deadlines[name] = Number(component?.deadlineSeconds ?? 0);
        }
    }
    return deadlines;
}

/** `{ kind, name }` pairs as their `kind/name` strings — the only shape used for a report. */
function objectNames(kept: readonly unknown[] | undefined): string[] {
    return (kept ?? []).map((entry) => {
        const object = entry as { kind?: unknown; name?: unknown } | undefined;
        return `${text(object?.kind)}/${text(object?.name)}`;
    });
}
