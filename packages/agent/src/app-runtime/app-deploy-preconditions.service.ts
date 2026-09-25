/**
 * APW-06 T21 — the Deploy preconditions (plan §5.1, spec FR-24).
 *
 * Returns `AppPrecondition[]` — `{ code, names?, message, fixUrl? }` — and **never
 * throws for an unmet precondition** (plan §5.1:674). Every refusal is a named
 * entry a caller can render, because the two callers both need exactly that:
 * `POST /api/works/:id/deploy` answers `422 { code: 'APP_DEPLOY_PRECONDITIONS',
 * unmet }` (plan §2.2:150-151) and `app-deploy` re-runs this evaluation before it
 * starts work ("preconditions are checked on request and again when work starts",
 * FR-24; plan §5.6 step 1). The second caller is why this class holds no state: a
 * re-check that disagreed with the request-time check because of a cache would be
 * worse than no re-check.
 *
 * ## The order, and why it is the order
 *
 * | # | Check                                        | Codes                                                                   |
 * | - | -------------------------------------------- | ----------------------------------------------------------------------- |
 * | 1 | dispatcher availability (§9.2, APW06-G02)     | `worker_not_isolated`                                                    |
 * | 2 | runtime state (T17, plan §7.2)                | `app_work_deleting` · `paused` · `deploy_in_progress` · `target_none` · `target_not_checked` · `cluster_changed_unconfirmed` |
 * | 3 | App spec at **the Deployment's commit**       | `spec_invalid`                                                           |
 * | 4 | license gate (§5.2, `./app-license-gate`)     | `license_attestation_missing` · `license_blocks_target`                   |
 * | 5 | managed tier (§5.1's `managed_*` rows)        | `managed_disabled` · `managed_scope_unverified_blueprint` · `managed_ineligible` · `quota_exceeded` · `managed_sandbox_unavailable` |
 * | 6 | Build (§5.1's `WorkBuild` rows, §5.8)         | `no_green_build` · `no_green_build_for_head` · `build_image_missing` · `nothing_to_deploy` · `image_not_pinned` |
 * | 7 | env source (APW-07)                           | `env_source_unavailable` · `env_required_unset` · `cron_auth_env_unset` · `job_auth_env_unset` |
 * | 8 | dependencies (§5.1, GAP-05)                   | `dependency_not_ready`                                                   |
 * | 9 | hosts (§8.1, GAP-09)                          | `primary_domain_missing` (**advisory**) + warning `primary_url_incluster` |
 *
 * Three properties of that order are deliberate:
 *
 * - **The dispatcher is checked first.** Plan §9.2:1261-1270: "`AppDeployRequestService`
 *   and the op callers check dispatcher availability **before** the lock claim.
 *   Unavailable means the dispatcher resolved `null`, `isEnabled()` is false, or the
 *   active runtime lacks `dispatchApp*`; the request returns the precondition
 *   `worker_not_isolated` (422) and creates no row." Creating no row means nothing
 *   may be read or written on the way to that answer, so this check runs before the
 *   first seam call and ends the evaluation (asserted: the runtime-state store
 *   records zero calls).
 * - **`target_none` ends the evaluation too.** `None — don't deploy yet` (R-12) has
 *   no target to license, build for or publish to, and ACC-06-01 wants "no cluster
 *   call": stopping here is what keeps the dependency check — which *dispatches
 *   provisioning*, GAP-05 — from firing for a Work that is not deploying.
 * - **An invalid App spec ends the evaluation.** The spec is the input to every
 *   later check (strategy, env schema, job auth entries, `domains.primary.*`
 *   references), so a refusal list built from an unreadable spec would be noise
 *   about a document nobody can deploy anyway.
 *
 * ## `unmet` and `advisory` are different things, on purpose
 *
 * §5.1's `primary_domain_missing` row says the entries are *named* "and the
 * in-cluster URL is used with warning `primary_url_incluster` **instead of refusing
 * the Deployment**". So it is reported where a caller can render it — `advisory` —
 * and the warning carries the fact; `unmet` stays exactly "these refuse". A caller
 * that refused on `advisory` would break S33/FR-41, where a Work deploys with no
 * primary host and is reached by its in-cluster URL.
 *
 * ## What this file does not do
 *
 * The rows of §5.1 that belong to another task are **routed, not half-built**, and
 * are listed in the slice report:
 *
 * - render-time checks — `volume_replicas`, `volume_shrink`, `privileged_port`,
 *   `cron_too_frequent`, `managed_root_forbidden`, `image_user_unverifiable` — are
 *   the renderer's (plan §4.4, T5/T6), which is the only layer that has the spec's
 *   resolved probes, volumes and ports in hand;
 * - the worker-side registry answers — `image_not_found`,
 *   `image_private_unsupported`, `image_unresolvable` — come from §5.8's
 *   `AppImageReferenceResolver` in the worker (T27), after `prepare`;
 * - `target_not_checked`, in its §5.6-step-3 sense ("`clusterSource` must be
 *   `custom-kubeconfig` … any other value → `target_not_checked`"), is the
 *   facade's (T20), which is the only layer that resolved the credential; the
 *   reading implemented here is §5.1's own ("runtime state"): no connection check
 *   on record;
 * - `pull_credential_unavailable` is T22's builder, which is what asks
 *   `AppImagePullCredentialSource`;
 * - `namespace_foreign` / `verification_namespace_forbidden` are the target
 *   resolver's and `AppVerificationTargetService`'s;
 * - `env_source_unavailable` / `pull_credential_unavailable` as *platform
 *   configuration* are produced here for the env source only, because that is the
 *   one this class calls.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_BUILD_DEPLOYABLE_TRIGGERS,
    type AppDeployTarget,
    type AppPrecondition,
    type AppSpec,
    type AppSpecBuildStrategy,
} from '@ever-works/contracts';

import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { isUsableAppSpecStatus } from '../app-spec/app-spec.service';
import { APP_DEPENDENCIES_SERVICE } from './app-runtime-deletion.service';
import { AppLicenseGate } from './app-license-gate';
import {
    APP_RUNTIME_ENV_SOURCE,
    APPS_TIER_POLICY,
    type AppRuntimeEnvSource,
    type AppsTierPolicy,
} from './ports';

/* -------------------------------------------------------------------------- *
 * Vocabulary this file adds
 * -------------------------------------------------------------------------- */

/** §5.1 (GAP-09): reported with `primary_domain_missing`, and never a refusal. */
export const APP_PRECONDITION_PRIMARY_URL_INCLUSTER = 'primary_url_incluster';

/** The §21 reference prefix whose entries need a primary host (CONTRACTS §1). */
export const APP_SPEC_PRIMARY_DOMAIN_REF_PREFIX = 'domains.primary.';

/** No runtime-state row could be read, so nothing it carries was judged. */
export const APP_DEPLOY_WARNING_RUNTIME_STATE_UNAVAILABLE = 'runtime_state_unavailable';

/** The spec declares dependencies and no APW-07 service is bound to judge them. */
export const APP_DEPLOY_WARNING_DEPENDENCIES_UNAVAILABLE = 'dependencies_unavailable';

/* -------------------------------------------------------------------------- *
 * Provisional seams — every one of them is another owner's, named as its owner
 * fixes it (the programme's established pattern: `ports.ts`, APW-07's
 * `app-dependencies.service.ts:230-300`, `app-license-gate.ts`).
 * -------------------------------------------------------------------------- */

// ── provisional — APW-06 T17, the runtime-state row ──────────────────────────
//
// `WorkAppRuntimeState` / `WorkAppRuntimeStateRepository` do not exist in this tree
// (`APW-06/tasks.md:293-321`, plan §7.2). The token is **not** declared here:
// `app-launcher.service.ts:223` declares `WORK_APP_RUNTIME_STATES` and
// `app-runtime-deletion.service.ts:387` reuses it, so this file declares the *view*
// it needs of the same provider and reuses that one token — a second
// `Symbol('WORK_APP_RUNTIME_STATES')` would be a different token and would leave
// this consumer unbound. Only the fields §5.1's runtime-state rows read are named,
// and each is read defensively (a missing field means "not set", never "assume the
// worst").

/** One `work_app_runtime_states` row as the preconditions read it (plan §7.2:1048-1052). */
export interface AppDeployRuntimeState {
    target?: AppDeployTarget | null;
    /** `pausedAt` alone still means paused — the launcher reads the pair the same way. */
    paused?: boolean | null;
    pausedAt?: Date | string | number | null;
    deployLockId?: string | null;
    deletionRequestedAt?: Date | string | number | null;
    /** The **deployed** cluster; a `cluster-check` writes its own fingerprint inside `clusterCheck`. */
    clusterFingerprint?: string | null;
    clusterCheck?: { fingerprint?: string | null; code?: string | null } | null;
    namespace?: string | null;
    targetSettings?: { tls?: string | null; managedSubdomain?: boolean | null } | null;
}

/** APW-06 T17's `WorkAppRuntimeStateRepository`, as this task consumes it. */
export interface AppDeployRuntimeStateReader {
    getOrCreate(workId: string): Promise<AppDeployRuntimeState>;
}

// ── APW-03 T12 `AppSpecService` — bound in `app-deploy-request.module.ts` ────
//
// `AppSpecService.getEffectiveSpec(workId, commitSha?)` (plan §2.3:195-198) answers
// one of six status strings, so `status` is compared as a string and never narrowed
// (this package sets `strictNullChecks: false`, under which a boolean discriminant
// does not narrow a union anyway). `isDeployableAppSpecStatus` alone decides which pass —
// `valid_with_warnings` too, which an earlier or superseded Build's commit reads. Bound as:
// `{ provide: APP_DEPLOY_SPEC_SOURCE, useExisting: AppSpecService }`.
//
// `getEffectiveSpec` is the read §5.1 names — "APW-03 validator over
// `.works/works.yml` **at the Build's commit** (Git facade read)" — and it is
// deliberately the *only* one: `hasValidAppSpec` is APW-01's minimal-path predicate
// and answering `spec_invalid` from it would read the repository twice.

/** The effective App spec at one commit, plus the two facts §5.1 needs from it. */
export interface AppDeploySpecSnapshot {
    /** Deployable ⇔ in APW-03's `APP_SPEC_USABLE_STATUSES` (`valid`, `valid_with_warnings`); see {@link isDeployableAppSpecStatus}. */
    status: string;
    spec?: AppSpec | null;
    commitSha?: string | null;
    /** APW-03's issue list, shown as names only. */
    issues?: readonly { code?: string | null; path?: string | null }[] | null;
    /**
     * APW-03's catalog verdict for the Blueprint this App Work was created from
     * (`AppsCatalogService.isVerified(entry, now)`, `APW-03/plan.md:215`). Only the
     * managed tier's `verified-blueprints` scope reads it.
     */
    blueprintVerified?: boolean | null;
    blueprintId?: string | null;
}

/** APW-03 T12's `AppSpecService`, as the preconditions consume it. */
export interface AppDeploySpecSource {
    /** `null` when no spec can be read at all — never a half-read spec. */
    getEffectiveSpec(
        workId: string,
        commitSha?: string | null,
    ): Promise<AppDeploySpecSnapshot | null>;
}

/** DI token for {@link AppDeploySpecSource} — owned by APW-03 T12. */
export const APP_DEPLOY_SPEC_SOURCE = Symbol('APP_DEPLOY_SPEC_SOURCE');

// ── provisional — APW-05's `WorkBuild` reads ─────────────────────────────────
//
// `packages/agent/src/entities/work-build.entity.ts` does not exist in this tree
// (`APW-05/tasks.md`), so the two reads §5.1 names are declared here: the Build the
// Deployment names, and the Work's **deployable** green Builds.
//
// "Deployable" is APW-05's own word and its own constant —
// `APP_BUILD_DEPLOYABLE_TRIGGERS = ['push', 'manual']`
// (`packages/contracts/src/apps/builds.ts:55`) — applied here rather than by the
// seam, so one list decides what may deploy: a `pull_request` or `verification`
// Build succeeded at some commit, but deploying it is a preview, not a Deployment
// (`plan §8.2`: "the only requested trigger APW-05's deployable verdict accepts").

/** One `WorkBuild` as §5.1 reads it. */
export interface AppDeployBuildSnapshot {
    id: string;
    /** The commit the image was built from — the commit the App spec is read at (ACC-06-20). */
    commitSha: string;
    /** `APP_BUILD_STATUSES`; `succeeded` is the green one. */
    status: string;
    /** `APP_BUILD_TRIGGERS`; only the deployable ones count. */
    trigger?: string | null;
    /** The pushed image reference, or `null` when the Build produced nothing to run. */
    imageReference?: string | null;
}

/** APW-05's `WorkBuild` reads, as the preconditions consume them. */
export interface AppDeployBuildSource {
    getBuild(workId: string, buildId: string): Promise<AppDeployBuildSnapshot | null>;
    /** The Work's green, deployable Builds, newest first. */
    listDeployableBuilds(workId: string): Promise<readonly AppDeployBuildSnapshot[] | null>;
}

/** DI token for {@link AppDeployBuildSource} — owned by APW-05. */
export const APP_DEPLOY_BUILD_SOURCE = Symbol('APP_DEPLOY_BUILD_SOURCE');

// ── provisional — APW-06 T26, the hosts read ─────────────────────────────────
//
// `AppHostsService` (plan §8.1) does not exist in this tree (T26). §5.1's
// `primary_domain_missing` row and §5.6 step 2's `env` resolution both need one
// fact from it — the Work's **primary host** — and nothing else, so the seam is
// that one read rather than the whole service. Its owner replaces this by
// `{ provide: APP_DEPLOY_HOST_SOURCE, useExisting: AppHostsService }`.

/** APW-06 T26's `AppHostsService`, as the preconditions consume it. */
export interface AppDeployHostSource {
    /** §8.1's primary: the verified custom domain marked primary, else the managed subdomain, else `null`. */
    primaryHost(workId: string): Promise<string | null>;
}

/** DI token for {@link AppDeployHostSource} — owned by APW-06 T26. */
export const APP_DEPLOY_HOST_SOURCE = Symbol('APP_DEPLOY_HOST_SOURCE');

// ── provisional — APW-07 T16, dependency readiness ───────────────────────────
//
// `AppDependenciesService` **has** landed (`packages/agent/src/app-dependencies/`),
// and its `ensureReadyForDeploy(workId)` is exactly the call §5.1 names — "it also
// dispatches provisioning for `pending` kinds" (GAP-05). The token is reused from
// `app-runtime-deletion.service.ts:388`, never re-declared, and the view below is
// the subset this file reads of APW-07's `AppDependencyReadiness`
// (`app-dependencies.service.ts:121-128`).

/** APW-07 T16's `ensureReadyForDeploy` answer, as the preconditions read it. */
export interface AppDeployDependencyReadiness {
    ready: boolean;
    notReady: readonly { kind: string; status?: string | null; reason?: string | null }[];
    optional?: readonly string[] | null;
    /** Set when the question could not be answered at all (APW-07's `specUnavailable`). */
    reason?: string | null;
}

/** APW-07 T16's `AppDependenciesService`, as the preconditions consume it. */
export interface AppDeployDependencyService {
    ensureReadyForDeploy(workId: string): Promise<AppDeployDependencyReadiness>;
}

// ── provisional — APW-06 T31/T32, dispatcher availability ────────────────────
//
// `TriggerService` *is* the `dispatchers` view (plan §9.2:1253-1259) and gains
// `dispatchAppDeploy`; `buildJobRuntimeProviders` returns `null` when no provider
// is registered, and "for App cluster work that fallback would run cluster I/O in
// the API and break FR-5, so it does not apply" (§9.2:1261-1266). This seam is the
// availability question alone — never the dispatch itself, which this class must
// not perform.

/** The §9.2 availability probe, asked before any read or write. */
export interface AppDeployDispatcherAvailability {
    /** The dispatcher this process would use, or `null`/`undefined` when there is none. */
    resolve(): unknown;
    /** `false` ⇔ dispatch is off in this process (the other half of §9.2's rule). */
    isEnabled?(): boolean;
}

/** DI token for {@link AppDeployDispatcherAvailability} — owned by APW-06 T31/T32. */
export const APP_DEPLOY_DISPATCHER_AVAILABILITY = Symbol('APP_DEPLOY_DISPATCHER_AVAILABILITY');

/* -------------------------------------------------------------------------- *
 * Request and result
 * -------------------------------------------------------------------------- */

/** What the caller knows when it asks. */
export interface AppDeployPreconditionRequest {
    workId: string;
    /** The Build the Deployment names; `null`/absent under `build.strategy: image`/`none` (§5.8). */
    buildId?: string | null;
    /** §5.8 / §2.2: the commit the request named, which is how an `image` Deployment says where its spec is. */
    specCommitSha?: string | null;
    /** The Work's head commit on the deploy branch — what `no_green_build_for_head` compares against. */
    headCommitSha?: string | null;
    /** Who is deploying; APW-10's `eligibility(userId)` is asked for the managed tier only. */
    userId?: string | null;
    /**
     * The Deployment making the request, when there is one.
     *
     * §5.6 step 1 re-runs this evaluation **inside** the Deployment that already
     * holds the deploy lock, so without this the check would refuse the very
     * Deployment that is asking. A lock held by anybody else still refuses.
     */
    deploymentId?: string | null;
    /** `confirmClusterChange` from the deploy request (plan §2.2:148). */
    confirmClusterChange?: boolean;
}

/** One non-refusing report — `{ code, message }`, the shape §5.4's warnings already use. */
export interface AppDeployPreconditionWarning {
    code: string;
    message: string;
}

/** What was read, for the caller's `WorkDeployment.appRender` row and for T22's builder. */
export interface AppDeployPreconditionContext {
    target: AppDeployTarget | null;
    specCommitSha: string | null;
    strategy: AppBuildStrategyLike | null;
    buildId: string | null;
    /** §5.1: `no_green_build_for_head` (+ `latestGreenBuildId`) — the older Build S14 offers. */
    latestGreenBuildId: string | null;
    /** The primary host §8.1 resolves, or `null` — T22 renders the input from the same fact. */
    primaryHost: string | null;
}

/** `AppBuildStrategy`'s four values, spelled without importing the union's name twice. */
type AppBuildStrategyLike = AppSpecBuildStrategy;

/** What the caller gets. */
export interface AppDeployPreconditionResult {
    /** The refusals: `422 { code: 'APP_DEPLOY_PRECONDITIONS', unmet }`. Empty ⇔ the Deployment may start. */
    unmet: AppPrecondition[];
    /** Codes §5.1 reports **without** refusing (GAP-09's `primary_domain_missing`). */
    advisory: AppPrecondition[];
    /** Why the advisory entries are advisory — and every platform state this pass could not read. */
    warnings: AppDeployPreconditionWarning[];
    context: AppDeployPreconditionContext;
    /** `true` ⇔ `unmet` is empty. Named so a caller cannot mistake `advisory` for a refusal. */
    ready: boolean;
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * The precondition pass of §5.1. Constructed in the API's request path and in the
 * worker's `app-deploy` job (§5.6 step 1) — the same class, so the two answers
 * cannot drift.
 */
@Injectable()
export class AppDeployPreconditionsService {
    private readonly logger = new Logger(AppDeployPreconditionsService.name);

    constructor(
        // The two the order depends on come first; every collaborator is
        // `@Optional()`, so a hand-rolled construction (this file's own spec, a lean
        // worker context) passes a prefix of them and the API's module graph
        // compiles with nothing bound at all.
        @Optional()
        @Inject(APP_DEPLOY_DISPATCHER_AVAILABILITY)
        private readonly dispatchers?: AppDeployDispatcherAvailability,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: AppDeployRuntimeStateReader,
        @Optional()
        @Inject(APP_DEPLOY_SPEC_SOURCE)
        private readonly specs?: AppDeploySpecSource,
        @Optional()
        @Inject(APP_RUNTIME_ENV_SOURCE)
        private readonly env?: AppRuntimeEnvSource,
        @Optional()
        @Inject(APP_DEPENDENCIES_SERVICE)
        private readonly dependencies?: AppDeployDependencyService,
        @Optional()
        @Inject(APP_DEPLOY_BUILD_SOURCE)
        private readonly builds?: AppDeployBuildSource,
        @Optional()
        @Inject(APP_DEPLOY_HOST_SOURCE)
        private readonly hosts?: AppDeployHostSource,
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tier?: AppsTierPolicy,
        // The license gate is this epic's own class (T21), injected rather than
        // re-implemented so §5.2's mapping has exactly one home.
        @Optional()
        private readonly licenseGate?: AppLicenseGate,
    ) {}

    /**
     * Evaluate every precondition §5.1 can answer without a cluster.
     *
     * Resolves — always. An unmet precondition is an entry in the result, never an
     * exception; a collaborator that throws is caught and reported as the
     * precondition that names it (`env_source_unavailable`, `spec_invalid`,
     * `no_green_build`, …), because a 500 tells the owner nothing they can act on.
     */
    async evaluate(request: AppDeployPreconditionRequest): Promise<AppDeployPreconditionResult> {
        const workId = String(request?.workId ?? '');

        const unmet: AppPrecondition[] = [];
        const advisory: AppPrecondition[] = [];
        const warnings: AppDeployPreconditionWarning[] = [];
        const context: AppDeployPreconditionContext = {
            target: null,
            specCommitSha: null,
            strategy: null,
            buildId: request?.buildId ? String(request.buildId) : null,
            latestGreenBuildId: null,
            primaryHost: null,
        };

        // ---- 1 · dispatcher availability (§9.2, APW06-G02) -------------------
        // First, and final: "the request returns the precondition `worker_not_isolated`
        // (422) and creates no row". Nothing below this line may run for that answer.
        if (!this.hasIsolatedDispatcher()) {
            unmet.push({
                code: 'worker_not_isolated',
                message:
                    'No isolated worker is available to run App cluster work, so this Deployment ' +
                    'cannot be dispatched. Production requires an operator to attest the App ' +
                    'cluster worker; nothing was queued.',
            });

            return { unmet, advisory, warnings, context, ready: false };
        }

        // ---- 2 · the runtime state (T17, plan §7.2) --------------------------
        const state = await this.readState(workId);
        if (!state) {
            warnings.push({
                code: APP_DEPLOY_WARNING_RUNTIME_STATE_UNAVAILABLE,
                message:
                    'The App runtime state could not be read, so the target, the pause flag, the ' +
                    'deploy lock and the last connection check were not judged.',
            });
        }

        const target = this.readTarget(state);
        context.target = target;

        if (state) {
            this.checkLifecycle(state, request, target, unmet, context);
            if (unmet.some((entry) => entry.code === 'target_none')) {
                // Nothing to deploy to: no licence to check, no Build to run, no host
                // to publish — and no dependency provisioning to trigger (ACC-06-01).
                return { unmet, advisory, warnings, context, ready: false };
            }
        }

        // ---- 3 · the App spec, at the Deployment's commit (ACC-06-20) --------
        const spec = await this.readSpec(workId, request, unmet, warnings);
        if (!spec) {
            return { unmet, advisory, warnings, context, ready: unmet.length === 0 };
        }

        context.specCommitSha = spec.commitSha;
        context.strategy = spec.strategy;

        // ---- 4 · the license gate (§5.2) -------------------------------------
        await this.checkLicense(workId, target, spec.commitSha, unmet, warnings);

        // ---- 5 · the managed tier (§5.1's `managed_*` rows) ------------------
        await this.checkTier(target, request, spec, unmet, warnings);

        // ---- 6 · the Build and the strategy (§5.1, §5.8) --------------------
        const build = await this.checkBuild(request, spec, target, unmet, warnings, context);
        if (build?.id) context.buildId = String(build.id);

        // ---- 7 · the primary host (needed by the env context and §8.1) -------
        const primaryHost = await this.readPrimaryHost(workId, context);
        const primaryUrl = primaryUrlFor(primaryHost, state?.targetSettings?.tls);

        // ---- 8 · the env source (APW-07) -------------------------------------
        await this.checkEnv({
            workId,
            spec,
            build,
            target,
            state,
            primaryUrl,
            primaryHost,
            unmet,
            warnings,
        });

        // ---- 9 · dependencies (GAP-05) ---------------------------------------
        await this.checkDependencies(workId, spec, unmet, warnings);

        // ---- 10 · `domains.primary.*` with no primary host (GAP-09) ----------
        this.checkPrimaryDomainRefs(spec, primaryHost, advisory, warnings);

        return { unmet, advisory, warnings, context, ready: unmet.length === 0 };
    }

    /* ---------------------------------------------------------------------- *
     * 1 · dispatcher availability
     * ---------------------------------------------------------------------- */

    /**
     * §9.2's three unavailability conditions, in one place: the dispatcher
     * resolved `null`, `isEnabled()` is false, or the resolved runtime lacks
     * `dispatchAppDeploy`.
     *
     * The third is what makes this check meaningful rather than ceremonial: a
     * runtime that exists but cannot dispatch App work would otherwise accept the
     * request, create the row and strand it (the "no in-process fallback" rule,
     * §9.2:1261-1266).
     */
    private hasIsolatedDispatcher(): boolean {
        if (!this.dispatchers || typeof this.dispatchers.resolve !== 'function') {
            return false;
        }

        try {
            if (
                typeof this.dispatchers.isEnabled === 'function' &&
                this.dispatchers.isEnabled() === false
            ) {
                return false;
            }

            const resolved = this.dispatchers.resolve();
            if (!resolved) return false;

            return (
                typeof (resolved as { dispatchAppDeploy?: unknown }).dispatchAppDeploy ===
                'function'
            );
        } catch (error) {
            this.logger.warn(
                `Resolving the App deploy dispatcher failed (${
                    error instanceof Error ? error.message : String(error)
                }); App cluster work is treated as not isolated.`,
            );
            return false;
        }
    }

    /* ---------------------------------------------------------------------- *
     * 2 · runtime state
     * ---------------------------------------------------------------------- */

    /** One guarded read; `null` means "nothing could be read", never "assume the worst". */
    private async readState(workId: string): Promise<AppDeployRuntimeState | null> {
        if (!this.runtimeStates || typeof this.runtimeStates.getOrCreate !== 'function') {
            return null;
        }

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

    /** The target the row records, or `null` when it records none. */
    private readTarget(state: AppDeployRuntimeState | null): AppDeployTarget | null {
        const target = state?.target;
        return target === 'your-cluster' || target === 'ever-works-apps' || target === 'none'
            ? target
            : null;
    }

    /**
     * The five lifecycle rows of §5.1 that are runtime state: deleting, paused, a
     * lock held by somebody else, `none`, and the connection check.
     *
     * Order inside is "the most final answer first": a Work being deleted is not
     * paused-and-deployable, it is going away.
     */
    private checkLifecycle(
        state: AppDeployRuntimeState,
        request: AppDeployPreconditionRequest,
        target: AppDeployTarget | null,
        unmet: AppPrecondition[],
        context: AppDeployPreconditionContext,
    ): void {
        if (isSet(state.deletionRequestedAt)) {
            unmet.push({
                code: 'app_work_deleting',
                message: 'This App Work is being deleted, so no Deployment may start for it.',
            });
            return;
        }

        if (state.paused === true || isSet(state.pausedAt)) {
            unmet.push({
                code: 'paused',
                message: 'This App Work is paused. Resume it before deploying.',
            });
        }

        const lockId = state.deployLockId ? String(state.deployLockId) : null;
        const ownDeploymentId = request?.deploymentId ? String(request.deploymentId) : null;
        if (lockId && lockId !== ownDeploymentId) {
            unmet.push({
                code: 'deploy_in_progress',
                names: [lockId],
                message: 'Another Deployment of this App Work is already running.',
            });
        }

        if (target === null || target === 'none') {
            unmet.push({
                code: 'target_none',
                message:
                    'This App Work has no deploy target yet. Choose a cluster (or Ever Works Apps) ' +
                    'before deploying.',
            });
            return;
        }

        // The connection check is the owner's own act on **Your cluster**
        // (`POST :id/app-target/check`). On the managed tier the edge belongs to the
        // platform, so its absence is not the owner's precondition to meet.
        if (target === 'your-cluster') {
            const check = state.clusterCheck ?? null;
            const checkedFingerprint = check?.fingerprint ? String(check.fingerprint) : null;
            const deployedFingerprint = state.clusterFingerprint
                ? String(state.clusterFingerprint)
                : null;

            if (!check || (check.code && String(check.code).length > 0)) {
                // FR-24 asks for "the target … and its last connection check passed", and
                // §9.1 lands the refusal code in `clusterCheck` when it did not. A check
                // that failed and a check that never ran are the same precondition, but
                // they are not the same message.
                const code = check?.code ? String(check.code) : null;

                unmet.push({
                    code: 'target_not_checked',
                    names: code ? [code] : undefined,
                    message: code
                        ? `The last cluster connection check failed (${code}). Run the check again ` +
                          'after fixing it, then Deploy.'
                        : 'This App Work has no completed cluster connection check on record. Run ' +
                          'the check before deploying.',
                });
            } else if (
                checkedFingerprint &&
                deployedFingerprint &&
                checkedFingerprint !== deployedFingerprint &&
                request?.confirmClusterChange !== true
            ) {
                // The check was made against a *different* cluster than the one this Work
                // is deployed on: re-pointing a live app must be confirmed, never inferred
                // (plan §6.3: the fingerprint column "stays the deployed cluster").
                unmet.push({
                    code: 'cluster_changed_unconfirmed',
                    message:
                        'The connection check was made against a different cluster than the one ' +
                        'this App Work runs on. Confirm the change before deploying.',
                });
            }
        }

        context.target = target;
    }

    /* ---------------------------------------------------------------------- *
     * 3 · the App spec at the Deployment's commit
     * ---------------------------------------------------------------------- */

    /**
     * Read the App spec **at the commit this Deployment will run** — the Build's
     * commit for `dockerfile`/`auto`, the request's `specCommitSha` for `image` —
     * and never "the latest applied spec" (ACC-06-20, FR-25: "the image and the App
     * spec always come from the same commit").
     *
     * Returns `null` when the evaluation must stop: no spec source, an unreadable
     * spec, or a spec with validation errors. Each case has already pushed its
     * refusal.
     */
    private async readSpec(
        workId: string,
        request: AppDeployPreconditionRequest,
        unmet: AppPrecondition[],
        warnings: AppDeployPreconditionWarning[],
    ): Promise<ResolvedSpec | null> {
        if (!this.specs || typeof this.specs.getEffectiveSpec !== 'function') {
            unmet.push({
                code: 'spec_invalid',
                message:
                    'The App spec cannot be read: no App spec source is available in this process.',
            });
            return null;
        }

        // The commit is chosen without reading the spec's own `build.strategy`,
        // which lives *in* the spec: a Build names its commit, and an `image`
        // request names the spec commit it was made for (§5.8). Only a request with
        // neither is read at the deploy branch's head.
        const requestedCommit = request?.specCommitSha ? String(request.specCommitSha) : null;
        const buildId = request?.buildId ? String(request.buildId) : null;

        let commitSha: string | null = requestedCommit;
        let build: AppDeployBuildSnapshot | null = null;

        if (buildId) {
            build = await this.readBuild(workId, buildId, unmet);
            if (build?.commitSha) commitSha = build.commitSha;
        }

        const snapshot = await this.readEffectiveSpec(workId, commitSha, unmet);
        if (!snapshot) return null;

        if (!isDeployableAppSpecStatus(snapshot.status)) {
            const issues = (snapshot.issues ?? [])
                .map((issue) => String(issue?.code ?? issue?.path ?? '').trim())
                .filter((name) => name.length > 0)
                .slice(0, APP_DEPLOY_SPEC_ISSUE_NAMES_MAX);

            unmet.push({
                code: 'spec_invalid',
                names: issues.length > 0 ? issues : undefined,
                message:
                    `The App spec is not valid at ${String(snapshot.commitSha ?? commitSha ?? 'HEAD')} ` +
                    `(status: ${String(snapshot.status ?? 'unknown')}). Fix the spec before deploying; ` +
                    'the Build still runs.',
            });
            return null;
        }

        const spec = snapshot.spec ?? null;
        if (!spec) {
            warnings.push({
                code: APP_DEPLOY_WARNING_RUNTIME_STATE_UNAVAILABLE,
                message: 'The App spec read reported a usable status but carried no spec document.',
            });
        }

        return {
            spec,
            commitSha: String(snapshot.commitSha ?? commitSha ?? '') || null,
            strategy: effectiveStrategy(spec),
            build,
            blueprintVerified: snapshot.blueprintVerified ?? null,
            blueprintId: snapshot.blueprintId ?? null,
        };
    }

    /** One guarded `getEffectiveSpec`; a throw is `spec_invalid`, never a 500. */
    private async readEffectiveSpec(
        workId: string,
        commitSha: string | null,
        unmet: AppPrecondition[],
    ): Promise<AppDeploySpecSnapshot | null> {
        try {
            const snapshot = await this.specs.getEffectiveSpec(workId, commitSha ?? undefined);
            if (snapshot) return snapshot;
        } catch (error) {
            this.logger.warn(
                `Reading the App spec of Work ${workId} at ${String(commitSha ?? 'HEAD')} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            unmet.push({
                code: 'spec_invalid',
                message:
                    `The App spec could not be read at ${String(commitSha ?? 'HEAD')}. Retry when ` +
                    'the repository is reachable.',
            });
            return null;
        }

        unmet.push({
            code: 'spec_invalid',
            message:
                `No App spec was found at ${String(commitSha ?? 'HEAD')}. Add ` +
                '`.works/works.yml` (kind `app`) before deploying.',
        });
        return null;
    }

    /* ---------------------------------------------------------------------- *
     * 4 · license
     * ---------------------------------------------------------------------- */

    /** Plan §5.2, through this epic's own gate — the mapping lives there and only there. */
    private async checkLicense(
        workId: string,
        target: AppDeployTarget | null,
        specCommitSha: string | null,
        unmet: AppPrecondition[],
        warnings: AppDeployPreconditionWarning[],
    ): Promise<void> {
        if (!this.licenseGate || target === null) return;

        try {
            const verdict = await this.licenseGate.evaluate({
                workId,
                target,
                commitSha: specCommitSha,
            });

            unmet.push(...(verdict?.preconditions ?? []));
            warnings.push(...(verdict?.warnings ?? []));
        } catch (error) {
            // `AppLicenseGate.evaluate` never throws by contract; a throw here means a
            // collaborator broke that contract, and the honest answer is the same
            // unreadable-verdict warning the gate itself would have produced.
            this.logger.warn(
                `The license gate failed for App Work ${workId} (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            warnings.push({
                code: 'license_eligibility_unavailable',
                message: 'The license classification could not be read for this Deployment.',
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * 5 · the managed tier
     * ---------------------------------------------------------------------- */

    /**
     * §5.1's managed rows, all read through APW-10's port (R-5: the tier state
     * enters through `AppsTierPolicy` and never through an environment read).
     *
     * `capReached` maps to `quota_exceeded` and every other reason to
     * `managed_ineligible` (+ the reasons): APW-10's own plan fixes that mapping
     * ("`capReached` is a presentation of APW-06's cap, not a second cap. **Do not
     * add a competing limit here**", `APW-10/plan.md:715`), and the cap itself is
     * `config.everWorks.apps.getMaxPerUser()` (T19).
     */
    private async checkTier(
        target: AppDeployTarget | null,
        request: AppDeployPreconditionRequest,
        spec: ResolvedSpec,
        unmet: AppPrecondition[],
        warnings: AppDeployPreconditionWarning[],
    ): Promise<void> {
        if (target !== 'ever-works-apps') return;

        if (!this.tier || typeof this.tier.isOpen !== 'function' || this.tier.isOpen() !== true) {
            unmet.push({
                code: 'managed_disabled',
                message:
                    'Ever Works Apps is not open on this installation, so the managed target ' +
                    'cannot run this App Work. Your own cluster remains available.',
            });
            return;
        }

        if (
            typeof this.tier.managedScope === 'function' &&
            this.tier.managedScope() === 'verified-blueprints'
        ) {
            if (spec.blueprintVerified !== true) {
                unmet.push({
                    code: 'managed_scope_unverified_blueprint',
                    names: spec.blueprintId ? [String(spec.blueprintId)] : undefined,
                    message:
                        'Ever Works Apps currently runs verified App Blueprints only, and this App ' +
                        'Work has no verified Blueprint behind it. Your own cluster remains available.',
                });
            }
        }

        if (typeof this.tier.podPolicy === 'function') {
            try {
                const podPolicy = this.tier.podPolicy();
                if (
                    !podPolicy ||
                    podPolicy.runtimeClassName === null ||
                    podPolicy.runtimeClassName === undefined
                ) {
                    // R-24: without a sandboxed runtime class the tier cannot accept
                    // user-controlled code, and the refusal is named rather than silent.
                    unmet.push({
                        code: 'managed_sandbox_unavailable',
                        message:
                            'Ever Works Apps has no sandboxed container runtime configured, so it ' +
                            'cannot run this App Work yet.',
                    });
                }
            } catch (error) {
                this.logger.warn(
                    `Reading the Apps tier pod policy failed (${
                        error instanceof Error ? error.message : String(error)
                    }).`,
                );
            }
        }

        const userId = request?.userId ? String(request.userId) : null;
        if (!userId || typeof this.tier.eligibility !== 'function') {
            if (!userId) {
                warnings.push({
                    code: 'managed_eligibility_unchecked',
                    message:
                        'The requesting user was not supplied, so tier eligibility was not evaluated.',
                });
            }
            return;
        }

        try {
            const eligibility = await this.tier.eligibility(userId);
            if (eligibility && eligibility.eligible !== true) {
                const reasons = (eligibility.reasons ?? []).map((reason) => String(reason));

                if (reasons.includes(MANAGED_CAP_REACHED_REASON)) {
                    unmet.push({
                        code: 'quota_exceeded',
                        names: reasons,
                        message:
                            'This account has reached its Ever Works Apps limit, so no further App ' +
                            'Work may be deployed there. Your own cluster remains available.',
                    });
                }

                // Every reason that is not the cap is an ineligibility of its own; an
                // `eligible: false` with no reason at all is still a refusal, because the
                // tier answered "no" and a Deployment may not start on a "no" it cannot
                // explain away.
                const blocking = reasons.filter((reason) => reason !== MANAGED_CAP_REACHED_REASON);
                if (blocking.length > 0 || reasons.length === 0) {
                    unmet.push({
                        code: 'managed_ineligible',
                        // §5.1 writes this code as "`managed_ineligible` (+ reasons)"; the four
                        // fields `AppPrecondition` fixes have no slot for them, so the reasons
                        // ride in `names` — the plural field the contract added for exactly
                        // "one code about several things".
                        names: blocking.length > 0 ? blocking : reasons,
                        message:
                            'This account is not eligible for Ever Works Apps' +
                            (blocking.length > 0 ? ` (${blocking.join(', ')})` : '') +
                            '. Your own cluster remains available.',
                    });
                }
            }
        } catch (error) {
            this.logger.warn(
                `Reading the Apps tier eligibility failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }

    /* ---------------------------------------------------------------------- *
     * 6 · the Build
     * ---------------------------------------------------------------------- */

    /**
     * §5.1's Build rows, for the strategies that produce a Build — "**`build.strategy:
     * dockerfile` and `auto` only**" (§5.1:682, §5.8). Under `image` there is no
     * Build and this method can never yield `no_green_build*` (FR-64, ACC-06-52);
     * under `none` there is nothing to run at all (`nothing_to_deploy`).
     *
     * `latestGreenBuildId` travels in `names` (ACC-06-19's S14 — the older Build the
     * Deploy tab offers) and in the context, because `AppPrecondition` is the shared
     * contract and this epic does not add a field to it (R-26, `packages/contracts`
     * is not this task's to edit).
     */
    private async checkBuild(
        request: AppDeployPreconditionRequest,
        spec: ResolvedSpec,
        target: AppDeployTarget | null,
        unmet: AppPrecondition[],
        warnings: AppDeployPreconditionWarning[],
        context: AppDeployPreconditionContext,
    ): Promise<AppDeployBuildSnapshot | null> {
        const strategy = spec.strategy;

        if (strategy === 'none') {
            unmet.push({
                code: 'nothing_to_deploy',
                message:
                    'This App spec has no build strategy, so there is no image to run. Builds still ' +
                    'run; set `build.strategy` to `dockerfile`, `auto` or `image` to deploy.',
            });
            return null;
        }

        if (strategy === 'image') {
            // §5.8: the image is the spec's own reference at that commit. On the managed
            // tier a tag-only reference is refused **on request**, before any work starts.
            const reference = String(spec.spec?.build?.image ?? '').trim();
            if (
                target === 'ever-works-apps' &&
                reference.length > 0 &&
                !isDigestPinned(reference)
            ) {
                unmet.push({
                    code: 'image_not_pinned',
                    names: [reference],
                    message:
                        'Ever Works Apps requires an image pinned by digest. Use ' +
                        '`<repository>@sha256:<64 hex>` in the App spec.',
                });
            }
            return null;
        }

        // `dockerfile` and `auto`: a green, deployable Build is required.
        const buildId = request?.buildId ? String(request.buildId) : null;

        if (buildId) {
            const build =
                spec.build ?? (await this.readBuild(String(request.workId ?? ''), buildId, unmet));
            if (!build) return null;

            if (!isDeployableBuild(build)) {
                unmet.push({
                    code: 'no_green_build',
                    names: [build.id],
                    message:
                        `Build ${build.id} is not a green, deployable Build (status: ` +
                        `${String(build.status)}). Request a new Build or Deploy an earlier one.`,
                });
                return build;
            }

            if (!build.imageReference) {
                unmet.push({
                    code: 'build_image_missing',
                    names: [build.id],
                    message:
                        `Build ${build.id} produced no image, so there is nothing to run. Re-run the ` +
                        'Build.',
                });
            }

            return build;
        }

        const latest = await this.latestDeployableBuild(
            String(request?.workId ?? ''),
            unmet,
            warnings,
        );
        if (!latest) {
            unmet.push({
                code: 'no_green_build',
                message:
                    'No green Build exists for this App Work yet. Wait for a Build to succeed, then ' +
                    'Deploy.',
            });
            return null;
        }

        context.latestGreenBuildId = String(latest.id);

        const headCommitSha = request?.headCommitSha ? String(request.headCommitSha) : null;
        if (headCommitSha && String(latest.commitSha ?? '') !== headCommitSha) {
            unmet.push({
                code: 'no_green_build_for_head',
                names: [String(latest.id)],
                message:
                    `The newest green Build is ${latest.id}, which was built from another commit. ` +
                    'Deploy that Build, or wait for a Build of the current head.',
            });
            return latest;
        }

        if (!latest.imageReference) {
            unmet.push({
                code: 'build_image_missing',
                names: [String(latest.id)],
                message: `Build ${latest.id} produced no image, so there is nothing to run. Re-run the Build.`,
            });
        }

        return latest;
    }

    /** One guarded `getBuild`. */
    private async readBuild(
        workId: string,
        buildId: string,
        unmet: AppPrecondition[],
    ): Promise<AppDeployBuildSnapshot | null> {
        if (!this.builds || typeof this.builds.getBuild !== 'function') {
            unmet.push({
                code: 'no_green_build',
                names: [buildId],
                message:
                    'No Build records are available in this process, so the Build could not be read.',
            });
            return null;
        }

        try {
            const build = await this.builds.getBuild(workId, buildId);
            if (build) return build;
        } catch (error) {
            this.logger.warn(
                `Reading Build ${buildId} of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }

        unmet.push({
            code: 'no_green_build',
            names: [buildId],
            message: `Build ${buildId} could not be read for this App Work. Request a new Build.`,
        });
        return null;
    }

    /** The newest green, deployable Build — the one S14 offers when the head has none. */
    private async latestDeployableBuild(
        workId: string,
        unmet: AppPrecondition[],
        warnings: AppDeployPreconditionWarning[],
    ): Promise<AppDeployBuildSnapshot | null> {
        if (!this.builds || typeof this.builds.listDeployableBuilds !== 'function') {
            warnings.push({
                code: 'builds_unavailable',
                message: 'No Build records are available in this process, so no Build was offered.',
            });
            return null;
        }

        let builds: readonly AppDeployBuildSnapshot[] | null = null;
        try {
            builds = await this.builds.listDeployableBuilds(workId);
        } catch (error) {
            this.logger.warn(
                `Listing the Builds of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }

        const deployable = (builds ?? []).filter((build) => isDeployableBuild(build));
        return deployable.length > 0 ? deployable[0] : null;
    }

    /* ---------------------------------------------------------------------- *
     * 7 · the primary host
     * ---------------------------------------------------------------------- */

    /** §8.1's primary host, read once for the env context and the domain check. */
    private async readPrimaryHost(
        workId: string,
        context: AppDeployPreconditionContext,
    ): Promise<string | null> {
        if (!this.hosts || typeof this.hosts.primaryHost !== 'function') {
            return null;
        }

        try {
            const host = await this.hosts.primaryHost(workId);
            context.primaryHost = host ? String(host) : null;
            return context.primaryHost;
        } catch (error) {
            this.logger.warn(
                `Reading the primary host of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return null;
        }
    }

    /* ---------------------------------------------------------------------- *
     * 8 · env
     * ---------------------------------------------------------------------- */

    /**
     * §5.1's env rows: `unsetRequired` is `env_required_unset` (one entry naming
     * every unset value, per the contract's own note that "three unset env values
     * are one `env_required_unset` naming three entries, not three rows a caller has
     * to merge"), and the spec's job/cron `http.authEnv` entries must resolve to a
     * non-empty value (FR-24: "cron and job authentication values are set and
     * non-empty").
     *
     * The resolution is the **non-ephemeral** one, with `buildCommitSha: null` under
     * `build.strategy: image` — exactly the context §5.6 step 2 and T22's builder
     * pass (ACC-06-52).
     */
    private async checkEnv(input: {
        workId: string;
        spec: ResolvedSpec;
        build: AppDeployBuildSnapshot | null;
        target: AppDeployTarget | null;
        state: AppDeployRuntimeState | null;
        primaryUrl: string | null;
        primaryHost: string | null;
        unmet: AppPrecondition[];
        warnings: AppDeployPreconditionWarning[];
    }): Promise<void> {
        const { workId, spec, build, target, state, primaryUrl, primaryHost, unmet, warnings } =
            input;

        if (!this.env || typeof this.env.resolve !== 'function') {
            unmet.push({
                code: 'env_source_unavailable',
                message:
                    'No App env source is available in this process, so no environment value could ' +
                    'be checked.',
            });
            return;
        }

        const buildCommitSha =
            spec.strategy === 'image' || spec.strategy === 'none'
                ? null
                : (build?.commitSha ?? spec.commitSha);

        let resolution: Awaited<ReturnType<AppRuntimeEnvSource['resolve']>>;
        try {
            resolution = await this.env.resolve(workId, String(spec.commitSha ?? ''), {
                target: target ?? 'none',
                primaryUrl,
                primaryHost,
                buildCommitSha: buildCommitSha ?? null,
                internalUrls: internalUrlsFor(spec.spec, state?.namespace ?? null),
            });
        } catch (error) {
            this.logger.warn(
                `Resolving the App env of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            unmet.push({
                code: 'env_source_unavailable',
                message:
                    'The App environment could not be resolved, so no Deployment may start. Retry ' +
                    'when the env store is reachable.',
            });
            return;
        }

        const unsetRequired = (resolution?.unsetRequired ?? []).map((name) => String(name));
        if (unsetRequired.length > 0) {
            unmet.push({
                code: 'env_required_unset',
                names: unsetRequired,
                message: unsetRequired
                    .map((name) => `\`${name}\``)
                    .join(', ')
                    .concat(' must be set before this App Work can deploy.'),
            });
        }

        // A `secret: true` value is never returned, so a name that resolved appears in
        // `secretNames` instead of `values` — the two together are "this entry has a
        // value". `unsetRequired` above is what says it does not.
        const resolvedNames = new Set<string>([
            ...Object.keys(resolution?.values ?? {}),
            ...(resolution?.secretNames ?? []).map((name) => String(name)),
        ]);

        const unsetJobAuth = authEnvNames(spec.spec?.jobs).filter(
            (name) => !hasValue(resolvedNames, resolution, name),
        );
        const unsetCronAuth = authEnvNames(spec.spec?.cron).filter(
            (name) => !hasValue(resolvedNames, resolution, name),
        );

        if (unsetJobAuth.length > 0) {
            unmet.push({
                code: 'job_auth_env_unset',
                names: unsetJobAuth,
                message:
                    'A job sends an Authorization header from an env entry that has no value: ' +
                    `${unsetJobAuth.join(', ')}.`,
            });
        }

        if (unsetCronAuth.length > 0) {
            unmet.push({
                code: 'cron_auth_env_unset',
                names: unsetCronAuth,
                message:
                    'A scheduled call sends an Authorization header from an env entry that has no ' +
                    `value: ${unsetCronAuth.join(', ')}.`,
            });
        }
    }

    /* ---------------------------------------------------------------------- *
     * 9 · dependencies
     * ---------------------------------------------------------------------- */

    /**
     * `AppDependenciesService.ensureReadyForDeploy(workId)` — the one call that both
     * answers "is every dependency ready" **and** "dispatches provisioning for
     * `pending` kinds" (GAP-05, ACC-06-54). Called exactly once per evaluation, and
     * the single `dependency_not_ready` entry names every kind it reports.
     */
    private async checkDependencies(
        workId: string,
        spec: ResolvedSpec,
        unmet: AppPrecondition[],
        warnings: AppDeployPreconditionWarning[],
    ): Promise<void> {
        const declared = declaredDependencyKinds(spec.spec);

        if (!this.dependencies || typeof this.dependencies.ensureReadyForDeploy !== 'function') {
            if (declared.length > 0) {
                warnings.push({
                    code: APP_DEPLOY_WARNING_DEPENDENCIES_UNAVAILABLE,
                    message:
                        `This App spec declares ${declared.join(', ')}, but no dependency service is ` +
                        'bound in this process, so nothing was provisioned and nothing was judged.',
                });
            }
            return;
        }

        let readiness: AppDeployDependencyReadiness;
        try {
            readiness = await this.dependencies.ensureReadyForDeploy(workId);
        } catch (error) {
            this.logger.warn(
                `Checking the dependencies of Work ${workId} failed (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            unmet.push({
                code: 'dependency_not_ready',
                names: declared.length > 0 ? declared : undefined,
                message:
                    'The dependencies of this App Work could not be checked, so no Deployment may ' +
                    'start yet.',
            });
            return;
        }

        const notReady = (readiness?.notReady ?? []).map((entry) => String(entry?.kind ?? ''));
        const names = notReady.filter((kind) => kind.length > 0);

        if (readiness?.ready === true && names.length === 0) {
            return;
        }

        unmet.push({
            code: 'dependency_not_ready',
            names: names.length > 0 ? names : declared.length > 0 ? declared : undefined,
            message:
                names.length > 0
                    ? `These dependencies are not ready yet: ${names.join(', ')}. Provisioning was ` +
                      'requested; Deploy again when they are ready.'
                    : 'The dependencies of this App Work are not ready' +
                      (readiness?.reason ? ` (${String(readiness.reason)})` : '') +
                      '.',
        });
    }

    /* ---------------------------------------------------------------------- *
     * 10 · `domains.primary.*`
     * ---------------------------------------------------------------------- */

    /**
     * GAP-09: entries whose source is `domains.primary.*` while no primary host
     * exists are **named**, and "the in-cluster URL is used with warning
     * `primary_url_incluster` **instead of refusing the Deployment**" (§5.1's own
     * words) — so the entry is advisory and the warning carries the fact.
     */
    private checkPrimaryDomainRefs(
        spec: ResolvedSpec,
        primaryHost: string | null,
        advisory: AppPrecondition[],
        warnings: AppDeployPreconditionWarning[],
    ): void {
        if (primaryHost) return;

        const names = primaryDomainRefs(spec.spec);
        if (names.length === 0) return;

        advisory.push({
            code: 'primary_domain_missing',
            names,
            message:
                `These values read \`domains.primary.*\`, but this App Work has no primary host yet: ` +
                `${names.join(', ')}. The in-cluster URL is used instead.`,
        });

        warnings.push({
            code: APP_PRECONDITION_PRIMARY_URL_INCLUSTER,
            message:
                'No primary host is published for this App Work, so in-cluster URLs are used for ' +
                'the entries that reference `domains.primary.*`.',
        });
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — the parts worth testing without a container
 * -------------------------------------------------------------------------- */

/** How many spec issue codes one `spec_invalid` entry names. */
export const APP_DEPLOY_SPEC_ISSUE_NAMES_MAX = 10;

/** APW-10's reason code whose presentation is APW-06's cap (`APW-10/plan.md:715`). */
export const MANAGED_CAP_REACHED_REASON = 'capReached';

/** What `readSpec` resolved, in the shape the later checks need. */
interface ResolvedSpec {
    spec: AppSpec | null;
    /** The commit the spec **and** the image come from (ACC-06-20). */
    commitSha: string | null;
    strategy: AppBuildStrategyLike;
    /** The Build the request named, already read — never read twice. */
    build: AppDeployBuildSnapshot | null;
    blueprintVerified: boolean | null;
    blueprintId: string | null;
}

/** Whether a stored timestamp/flag is set — the row's own truthiness, never a guess. */
function isSet(value: Date | string | number | boolean | null | undefined): boolean {
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}

/**
 * The effective build strategy of a spec: `build.strategy`, else `none`.
 *
 * `none` is the documented default **only while `components` is empty**
 * (`APP_SPEC_BLOCK_DEFAULTS`'s note, `app-spec.types.ts:997-998`); a spec whose
 * components are non-empty without a strategy is a validation error (R2's
 * `components_require_strategy`), so a spec that reached this point with a `valid`
 * status and no strategy is a component-less one.
 */
function effectiveStrategy(spec: AppSpec | null | undefined): AppBuildStrategyLike {
    const strategy = spec?.build?.strategy;
    return strategy ?? 'none';
}

/** A green Build that may be deployed: `succeeded`, and a trigger APW-05 accepts. */
function isDeployableBuild(build: AppDeployBuildSnapshot | null | undefined): boolean {
    if (!build) return false;
    if (String(build.status ?? '') !== 'succeeded') return false;

    const trigger = build.trigger ? String(build.trigger) : null;
    if (!trigger) return true;

    return (APP_BUILD_DEPLOYABLE_TRIGGERS as readonly string[]).includes(trigger);
}

/** §5.8: a digest-pinned reference is `<repository>@sha256:<64 hex>`. */
function isDigestPinned(reference: string): boolean {
    return /@sha256:[0-9a-f]{64}$/i.test(reference.trim());
}

/** `https` unless the owner chose no TLS at all (FR-41/FR-42, plan §3:231). */
function primaryUrlFor(host: string | null, tls: string | null | undefined): string | null {
    if (!host) return null;
    return `http${String(tls ?? '') === 'none' ? '' : 's'}://${host}`;
}

/**
 * `components.<name>.internalUrl` — `http://<name>.<namespace>.svc.cluster.local`
 * (CONTRACTS §1, `packages/plugin/src/contracts/capabilities/app-deployment.types.ts:237-238`).
 *
 * Spelled here rather than imported because the agent never imports the `k8s`
 * plugin (plan §6.1:933) and the string is a contract, not an implementation: a
 * namespace that is not known yet contributes no entry, which is what leaves APW-07
 * to report such a value as unresolved rather than this pass inventing an address.
 */
function internalUrlsFor(
    spec: AppSpec | null | undefined,
    namespace: string | null,
): Record<string, string> {
    const urls: Record<string, string> = {};
    if (!namespace) return urls;

    for (const component of spec?.components ?? []) {
        const name = String(component?.name ?? '').trim();
        if (name.length > 0) {
            urls[name] = `http://${name}.${String(namespace)}.svc.cluster.local`;
        }
    }

    return urls;
}

/** Every `http.authEnv` a job names — the values FR-24 requires to be set and non-empty. */
function authEnvNames(entries: unknown): string[] {
    const names: string[] = [];

    for (const entry of (entries as readonly { http?: { authEnv?: string } }[]) ?? []) {
        const name = String(entry?.http?.authEnv ?? '').trim();
        if (name.length > 0 && !names.includes(name)) names.push(name);
    }

    return names;
}

/** Whether one auth env entry resolved — a non-empty value, or a secret that resolved by name. */
function hasValue(
    resolvedNames: Set<string>,
    resolution: { values?: Record<string, string> } | null | undefined,
    name: string,
): boolean {
    const value = resolution?.values ? resolution.values[name] : undefined;
    if (typeof value === 'string' && value.trim().length > 0) return true;

    // A `secret: true` value is never returned by the env source (Constitution VII),
    // so its presence in `secretNames` is the evidence that it resolved.
    return resolvedNames.has(name);
}

/** The `dependencies.*` kinds an App spec declares, in the spec's own vocabulary. */
function declaredDependencyKinds(spec: AppSpec | null | undefined): string[] {
    const dependencies = spec?.dependencies;
    if (!dependencies) return [];

    return (['postgres', 'redis', 'objectStorage', 'smtp'] as const).filter(
        (kind) => dependencies[kind] !== undefined && dependencies[kind] !== null,
    );
}

/**
 * Every env entry whose source text reads `domains.primary.*` — `from`, `template`
 * or a job/cron `http.body` placeholder. The values themselves are never read;
 * only the reference text, which is why the names are safe to report.
 */
function primaryDomainRefs(spec: AppSpec | null | undefined): string[] {
    const names: string[] = [];

    const record = (name: unknown, ...texts: unknown[]): void => {
        const entryName = String(name ?? '').trim();
        if (entryName.length === 0 || names.includes(entryName)) return;

        for (const text of texts) {
            if (typeof text === 'string' && text.includes(APP_SPEC_PRIMARY_DOMAIN_REF_PREFIX)) {
                names.push(entryName);
                return;
            }
        }
    };

    for (const entry of spec?.env ?? []) {
        record(entry?.name, entry?.from, entry?.template);
    }

    for (const job of spec?.jobs ?? []) {
        record(job?.name, JSON.stringify(job?.http?.body ?? ''));
    }

    for (const cron of spec?.cron ?? []) {
        record(cron?.name, JSON.stringify(cron?.http?.body ?? ''));
    }

    return names;
}

/**
 * §5.1 row 3's status rule: may a Deployment use the App spec `getEffectiveSpec` answered?
 *
 * Exactly APW-03's usable statuses — `APP_SPEC_USABLE_STATUSES`, `valid` and
 * `valid_with_warnings` — because warnings never stop anything (the rule that constant's own
 * doc records) and APW-05 already builds a `valid_with_warnings` commit. `getEffectiveSpec`
 * answers that status for a commit that is neither the stored effective one nor a usable
 * head: an earlier Build, a Build a newer push superseded, a rollback commit. A literal
 * `=== 'valid'` refused all three as `spec_invalid`.
 *
 * It lives here, and T22's `AppRenderInputBuilder` imports it from here, so this pass and the
 * builder that re-reads the same spec (§5.6 step 2) apply one rule and cannot drift apart.
 */
export function isDeployableAppSpecStatus(status: unknown): boolean {
    return isUsableAppSpecStatus(status);
}
