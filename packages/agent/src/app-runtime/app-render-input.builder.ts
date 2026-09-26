/**
 * APW-06 T22 — the **render-input builder**: everything a Deployment knows, in one place, turned
 * into the `AppRenderInput` a deployment plugin consumes.
 *
 * Spec: `APW-06-app-runtime/tasks.md:392-408` (T22, including its **Added (APW06-G08 / APW06-G04)**
 * paragraph). Plan: **§5.6 step 2** (`plan.md:805-813` — "Build `AppRenderInput`
 * (`app-render-input.builder.ts`): spec at `build.commitSha` (for strategy `image`, at
 * `specCommitSha` — §5.8), env + dependency egress (`AppRuntimeEnvSource`), pull credential
 * (`AppImagePullCredentialSource`), hosts (§8), ingress/TLS/network from target settings, policy
 * from `AppsTierPolicy` (`ever-works-apps`) or the your-cluster defaults"), **§5.8**
 * (`plan.md:866-899`, APW06-G04 — Deployments without a Build), §3/§3.1 (`plan.md:209-246`,
 * `:322-376` — the normative field reference), §9.6 (`plan.md:1358-1466` — the ports), §4.2/§4.4/§4.5
 * (the per-target defaults this file spells where the plan states them as literals), §4.7 (the env
 * Secret and the platform ConfigMap), §4.10 (`extraEgress`), §4.11 (hosts, TLS, URL scheme), §7.2
 * (`targetSettings`) and §8.1 (hosts). Acceptance: **ACC-06-16**, **ACC-06-20**, **ACC-06-52**.
 *
 * ## What this file is, and what it deliberately is not
 *
 * It is the **only** place an `AppRenderInput` is assembled (plan §6.4:980 lists it as a local
 * provider of the worker composition). It performs no cluster I/O, opens no database, writes no row,
 * emits no event, takes no lock and dispatches nothing — every fact it needs is either read through
 * the three read-only seams of T21/APW-03/APW-05 (§5.1's `AppDeploySpecSource`,
 * `AppDeployBuildSource`, `AppDeployHostSource`), asked of a §9.6 port, or handed in by the caller
 * from the runtime state it already loaded (§5.6 step 1).
 *
 * **Three rules shape the whole file.**
 *
 * 1. **Image and App spec come from the same commit (ACC-06-20).** For `dockerfile` and `auto` both
 *    values are read from **one** `AppDeployBuildSnapshot`: `specCommitSha = build.commitSha`,
 *    `image.reference = build.imageReference`, and the App spec is read **at that commit**
 *    (`getEffectiveSpec(workId, build.commitSha)`). Nothing here reads "the latest applied" commit,
 *    the deploy-branch head, or a second Build.
 * 2. **A credential reaches user code only through its port (ACC-06-16).** The pull block is exactly
 *    `AppImagePullCredentialSource.resolve(workId, buildId)`'s answer — no field added, none
 *    rewritten — and the env map is exactly `AppRuntimeEnvSource.resolve(...)`'s `values`, with no
 *    platform key merged in. `DeployService.collectServerSideRuntimeEnv` and
 *    `DeployService.resolveGhcrReadToken`
 *    (`apps/api/src/plugins-capabilities/deploy/deploy.service.ts:1289,1408`) assemble platform and
 *    Git credentials for platform-generated sites; plan §1.2:63-70 states the rule this file exists
 *    to keep — "User-controlled code must receive neither, so neither may be called for kind `app`" —
 *    and `packages/agent` cannot import `apps/api` at all, which is why the spec proves it by reading
 *    this file's own source as well as by spying on every collaborator this class has.
 * 3. **`build.strategy: image` has no Build (§5.8, ACC-06-52).** The image comes from the App spec at
 *    `specCommitSha`, `buildCommitSha` is **`null`** (APW-03 schema §21 guarantees no spec reaching
 *    this point references `build.commitSha`), `image.pull` is absent (public images only) and
 *    `AppImagePullCredentialSource` is **never called** — not for a tag, not for a digest, not once.
 *    A request that names a Build *and* resolves to that strategy is refused with
 *    `build_not_applicable` — the same code T24's deploy request returns with its `400`
 *    (`tasks.md:426`) — because silently preferring one of the two would break rule 1 for the other.
 *
 * ## The `target` the env source receives (APW06-G08)
 *
 * `AppRuntimeEnvSource.resolve` is handed `ctx.target: AppDeployTarget` verbatim from the resolved
 * `ref` — for **every** target, including `none`, because §5.6 step 2's rule is that APW-07 decides
 * `ew-dep://` placeholders from the target "rather than from the stored row" (`plan.md:812-813`,
 * `ports.ts:145-156`). Gating on the target is §5.1's job (`target_none`), not this file's.
 *
 * ## `purpose: 'verification'` reads and writes nothing (R-10)
 *
 * {@link AppRenderInputBuilder.readVerificationSpec} assembles the *spec side* of the input and
 * stops at the four facts a verification has: the App spec at the attempt's commit, the Build's (or
 * the spec's) image, the components/jobs/smoke and the resolved target's policy. It **never** calls
 * `AppRuntimeEnvSource.resolve` — the stored path, which R-10 forbids a verification from touching
 * (`ports.ts:158-182`) — never reads T26's live host set (§4.12:649-652 publishes nothing), and
 * resolves no egress: T60 resolves the ephemeral env itself and completes the input with
 * `withEphemeralEnv` (`app-verification-target.service.ts:586-598`), which is where a verification's
 * env Secret comes from.
 *
 * ## Provisional seams (each routed, none silent)
 *
 * - **T26's hosts read is not in this tree.** `app-hosts.service.ts` is T26 and the plan fixes no
 *   method name for a host **set**; it fixes `onPrimaryChanged(workId)` (§8.2:1108) and
 *   `appUrlScheme(tls, hostKind)` (§4.11:621). T21's seam (`APP_DEPLOY_HOST_SOURCE`,
 *   `app-deploy-preconditions.service.ts:244-250`) carries `primaryHost(workId)` alone, so this file
 *   declares the **view it needs** of the same provider — `resolveHosts?(workId)` — and reuses that
 *   one token rather than declaring a second `Symbol` (a second `Symbol('APP_DEPLOY_HOST_SOURCE')`
 *   would be a different token and would leave one of the two consumers unbound). The swap is
 *   `{ provide: APP_DEPLOY_HOST_SOURCE, useExisting: AppHostsService }`, which both consumers then
 *   share; until T26 lands, a bound seam without `resolveHosts` still yields the primary host and
 *   records the warning `hosts_incomplete` — never a silently empty host list.
 * - **`resolveHostAddresses` is the DNS half of §6.1's shared helper.** Plan §6.1:923-934
 *   (APW06-G20) puts `resolvePublicAddresses(host, …)` in
 *   `packages/plugin/src/helpers/cluster-address-policy.ts`, which **does not exist in this tree**.
 *   It is also the *wrong* verdict here: a dependency outside the App Work's namespace may
 *   legitimately be private (an in-cluster Postgres), so §4.10:577's `ew-allow-deps` needs the
 *   destination's `/32`s, not a public-address judgement. The `node:dns` lookup below is therefore
 *   `protected` and overridden by the spec; when APW06-G20 lands, only this one method changes.
 * - **The digest pin belongs to T72.** §5.8's identity resolution (an anonymous registry `HEAD`, a
 *   tag resolved to a digest once) is `app-image-reference.resolver.ts` — T72 (`tasks.md:1240-1245`),
 *   which also lists this file as the place the recorded digest is consumed. `imageDigest` is
 *   therefore an optional fact of the request: absent, the spec's own reference is used verbatim;
 *   present, the reference is pinned to it. Neither path ever calls the registry.
 *
 * ## The one name in two packages (reported, R-26)
 *
 * `components.<name>.internalUrl` is spelled in three places by construction: the pure helper
 * `internalUrl()` in the k8s plugin (`packages/plugins/k8s/src/app/app-names.ts:236`), T21's private
 * `internalUrlsFor` (`app-deploy-preconditions.service.ts:1520`), and {@link internalUrlsFor} here.
 * The string is a **contract** (`packages/plugin/src/contracts/capabilities/app-deployment.types.ts:237-238`),
 * the agent may not import the k8s plugin (plan §6.1:933), and T21's helper is module-private — so
 * the alternative to spelling it twice is editing another task's file. The values are identical by
 * test, and the only consumers that must agree at runtime are `AppRuntimeEnvSource` and the
 * renderer's own Service, which both read the same contract.
 */

import * as dns from 'node:dns';
import { isIP } from 'node:net';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_MANAGED_CRON_MIN_INTERVAL_MIN,
    appComponentDeadlineSeconds,
    type AppSpec,
    type AppSpecComponent,
    type AppSpecProbe,
} from '@ever-works/contracts';
import type {
    AppComponentInput,
    AppCronInput,
    AppJobInput,
    AppLimitRangeInput,
    AppQuotaInput,
    AppRenderInput,
    AppSmokeInput,
    AppTargetRef,
} from '@ever-works/plugin';

import {
    APP_DEPLOY_BUILD_SOURCE,
    APP_DEPLOY_HOST_SOURCE,
    APP_DEPLOY_SPEC_SOURCE,
    isDeployableAppSpecStatus,
    type AppDeployBuildSnapshot,
    type AppDeployBuildSource,
    type AppDeployHostSource,
    type AppDeploySpecSnapshot,
    type AppDeploySpecSource,
} from './app-deploy-preconditions.service.js';
import {
    APP_IMAGE_PULL_CREDENTIAL_SOURCE,
    APP_RUNTIME_ENV_SOURCE,
    APPS_TIER_POLICY,
    type AppImagePullCredentialSource,
    type AppRuntimeEnvSource,
    type AppsTierPolicy,
} from './ports.js';
import type {
    AppVerificationSpec,
    AppVerificationSpecRequest,
    AppVerificationSpecSource,
} from './app-verification-target.service.js';

/* -------------------------------------------------------------------------- *
 * Vocabulary this file adds
 * -------------------------------------------------------------------------- */

/** No host source is bound at all, so nothing is published — a warning, never a refusal (§5.1:686's advisory row). */
export const APP_RENDER_WARNING_HOST_SOURCE_UNAVAILABLE = 'host_source_unavailable';

/**
 * The host source is bound but answers only `primaryHost`, so custom domains that are not the
 * primary one are not published by this Deployment (T26's `resolveHosts` is what carries them).
 */
export const APP_RENDER_WARNING_HOSTS_INCOMPLETE = 'hosts_incomplete';

/** A dependency host could not be resolved, so `ew-allow-deps` does not name it (§4.10:577). */
export const APP_RENDER_WARNING_EGRESS_UNRESOLVED = 'egress_unresolved';

/** `deploymentShort` is 8 characters (§3:217; the golden harness's `deploymentId.replace(/-/g,'').slice(0,8)`). */
export const APP_RENDER_DEPLOYMENT_SHORT_LENGTH = 8;

/** §4.2:435-436's your-cluster defaults, as quantities. `ever-works-apps` differs only in `max`. */
export const APP_RENDER_DEFAULT_LIMIT_RANGE: AppLimitRangeInput = {
    defaultRequest: { cpu: '100m', memory: '128Mi' },
    defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
    max: { cpu: '8', memory: '64Gi' },
};

/** §4.2:436 — the managed tier's per-container ceiling. */
export const APP_RENDER_MANAGED_LIMIT_RANGE_MAX = { cpu: '2', memory: '4Gi' } as const;

/**
 * §4.5:516 — "web startup `tcpSocket`, period 10 s, `failureThreshold: 60`". These are the numbers
 * §5.3:769-771's worked example is computed from (`10 × 60 + 10 × 3 + 120 = 750`), and the renderer
 * applies them itself where the spec is silent
 * (`packages/plugins/k8s/src/app/app-manifest.renderer.ts:147-152`).
 *
 * **Reported conflict.** APW-03's `APP_SPEC_BLOCK_DEFAULTS` documents `30` for
 * `components[].probes.startup.failureThreshold`
 * (`packages/contracts/src/apps/app-spec.types.ts:1028`) while §4.5:516, §5.3:769-771 and the
 * renderer say `60`. The plan is the spec of record, so this file computes `750` for the web
 * default — which is also what the renderer's own `componentDeadlineSeconds({})` produces and what
 * both golden inputs carry
 * (`packages/plugins/k8s/src/app/__tests__/fixtures/render-input.single-web.json:46`). A probe the
 * spec **declares** is resolved from the schema's documented defaults instead, so
 * `probes: { startup: { tcp: true } }` contributes the schema's `30`.
 */
export const APP_RENDER_WEB_STARTUP_PROBE = { periodSeconds: 10, failureThreshold: 60 } as const;

/** §4.5:516 / APW-03 schema §10 — the web readiness default (`{ tcp: true }`'s numbers). */
export const APP_RENDER_WEB_READINESS_PROBE = { periodSeconds: 10, failureThreshold: 3 } as const;

/**
 * APW-03 schema §10's documented probe defaults, applied to a **declared** probe whose timings are
 * silent (`APP_SPEC_BLOCK_DEFAULTS`, `app-spec.types.ts:1025-1036`). A `worker` contributes nothing
 * when it declares no probe at all — the schema's readiness default is "`{ tcp: true }` for `web`
 * only" (`app-spec.types.ts:1004`) — which is why a worker's deadline is §5.3's floor (300) and a
 * web component's is 750, exactly as the golden inputs record
 * (`fixtures/render-input.web-worker-volume.json:45,58`).
 */
const PROBE_DEFAULTS = {
    startup: { periodSeconds: 10, timeoutSeconds: 5, initialDelaySeconds: 0, failureThreshold: 30 },
    readiness: {
        periodSeconds: 10,
        timeoutSeconds: 5,
        initialDelaySeconds: 0,
        failureThreshold: 3,
    },
    liveness: { periodSeconds: 10, timeoutSeconds: 5, initialDelaySeconds: 0, failureThreshold: 3 },
} as const;

/** APW-03 schema §10's documented component defaults (`APP_SPEC_BLOCK_DEFAULTS`, `:1023-1040`). */
const COMPONENT_DEFAULTS = {
    replicas: 1,
    cpu: '250m',
    memory: '512Mi',
} as const;

/** §3:234's `extraEgress` entry, as this file builds it. */
export interface AppRenderEgressEntry {
    cidr: string;
    ports: readonly number[];
}

/* -------------------------------------------------------------------------- *
 * Provisional seam — APW-06 T26, the published host set (§8.1)
 * -------------------------------------------------------------------------- */

/** §3:227 — the host block of the render input. */
export interface AppRenderHosts {
    primary: string | null;
    extra: readonly string[];
    previous: readonly string[];
    /**
     * §4.11:621-626's `appUrlScheme(tls, hostKind)` answer for the primary host, when T26 can give
     * it. Optional and additive: `external` + a managed subdomain is `http` while `external` + a
     * custom domain is `https`, and only `AppHostsService` knows which of the two a host is. This
     * file falls back to T21's reading (`http` only when TLS is off) rather than guessing.
     */
    primaryUrl?: string | null;
}

/**
 * APW-06 T26's `AppHostsService`, as this builder consumes it — T21's seam **plus** the host set
 * §8.1 resolves. `resolveHosts` is optional so a seam that answers only `primaryHost` still builds a
 * usable input (with the warning {@link APP_RENDER_WARNING_HOSTS_INCOMPLETE}).
 */
export interface AppRenderHostSource extends AppDeployHostSource {
    resolveHosts?(workId: string): Promise<AppRenderHosts | null>;
}

/** The two facts §9.10's `cluster-check` observed that §5.6 step 2's `ingress` block reads (§6.3:1002-1005). */
export interface AppRenderClusterCheckView {
    controllerNamespace?: string | null;
    ingressClasses?: readonly { name?: string | null; isDefault?: boolean | null }[] | null;
}

/** §7.2:1049 — the `targetSettings` row, as the render input reads it. */
export interface AppRenderTargetSettings {
    namespaceOverride?: string | null;
    ingressClass?: string | null;
    controllerNamespace?: string | null;
    tls?: string | null;
    issuer?: string | null;
    storageClass?: string | null;
    networkIsolation?: boolean | null;
    allowRoot?: boolean | null;
    managedSubdomain?: boolean | null;
    primaryDomain?: string | null;
}

/* -------------------------------------------------------------------------- *
 * Request and result
 * -------------------------------------------------------------------------- */

/** Everything §5.6 step 2 needs; the caller already holds all of it after step 1. */
export interface AppRenderInputRequest {
    workId: string;
    /** The Work's slug — `ever-works.io/part-of` and the `workSlug` field of §3:215. */
    workSlug: string;
    /**
     * §4.1's resolved ref — `target`, `namespace`, `kubeContext` and `clusterFingerprint` — from
     * §9.9's `AppRuntimeTargetResolver.resolve(workId)`, the only place cluster access is assembled.
     * `namespace` is what makes `components.<name>.internalUrl` knowable here (§4.3:470).
     */
    ref: AppTargetRef;
    /** The `WorkDeployment` row being rendered (the input's `deploymentId`, §3:216). */
    deploymentId: string;
    /** 8 hex; derived from `deploymentId` when absent (§3:217). */
    deploymentShort?: string | null;
    /** The Deployment's Build; `null`/absent under `build.strategy: image` / `none` (§5.8:868-875). */
    buildId?: string | null;
    /** §5.8: the commit a request named — **the** spec commit under `build.strategy: image`. */
    specCommitSha?: string | null;
    /** §5.8: the digest T72's resolver recorded, when it ran. Never resolved here. */
    imageDigest?: string | null;
    /** §5.6 step 6's bookkeeping: the first Deployment of this cluster fingerprint. */
    isFirstDeploymentOnCluster?: boolean | null;
    /** §5.5 / FR-34: pre-deploy jobs are skipped on a rollback by default. */
    skipPreDeployJobs?: boolean | null;
    /** §7.2:1049 — ingress/TLS/network come from the target settings. */
    targetSettings?: AppRenderTargetSettings | null;
    /** §9.10's `cluster-check` result, as §5.6 step 2's ingress block reads it. Settings win. */
    clusterCheck?: AppRenderClusterCheckView | null;
    /** §4.12 / R-10: `verification` renders a per-attempt namespace. Default `deploy`. */
    purpose?: 'deploy' | 'verification' | null;
    /** Required when `purpose` is `verification`; the namespace's expiry annotation (§3:214). */
    ttlMinutes?: number | null;
    /** FR-52/FR-53: a preview Deployment (§3:245). */
    preview?: { prNumber: number } | null;
}

/** One non-refusing report, the shape §5.4's warnings already use. */
export interface AppRenderInputWarning {
    code: string;
    message: string;
}

/**
 * The builder's answer.
 *
 * `status` is a **string discriminant** for the caller to switch on: `packages/agent` sets
 * `strictNullChecks: false`, under which a boolean or a union of object shapes does not narrow
 * (`app-deploy-preconditions.service.ts:157-163`, `ports.ts:18-28`). `status: 'ready'` ⇔ `input` is
 * the render input; every other status carries the `code` the caller reports — §5.1's own vocabulary
 * (`no_green_build`, `build_image_missing`, `nothing_to_deploy`, `target_not_checked`,
 * `env_source_unavailable`, `pull_credential_unavailable`, `managed_disabled`,
 * `managed_sandbox_unavailable`, `tier_pod_policy_unavailable`, `build_not_applicable`) plus
 * `spec_unavailable` / `spec_invalid`, the two the spec read can answer and the two T60 already
 * reports for the identical condition (`app-verification-target.service.ts:61`).
 */
export interface AppRenderInputResult {
    status: 'ready' | 'unavailable';
    input: AppRenderInput | null;
    /** The named reason when `status` is `unavailable`; `null` when the input was built. */
    code: string | null;
    /** A short, secret-free explanation for the caller's log line and `appRender.warnings`. */
    reason: string | null;
    warnings: AppRenderInputWarning[];
}

/** What {@link AppRenderInputBuilder.readSpec} answers — APW-03's `status` string, never narrowed. */
interface AppRenderSpecRead {
    status: 'ready' | 'unavailable';
    code: string | null;
    reason: string | null;
    snapshot: AppDeploySpecSnapshot | null;
}

/** The target's policy, ingress and isolation, as §5.6 step 2 resolves them. */
interface AppRenderTargetPolicy {
    status: 'ready' | 'unavailable';
    code: string | null;
    reason: string | null;
    policy: AppRenderInput['policy'];
    ingress: AppRenderInput['ingress'];
    isolation: boolean;
}

/* -------------------------------------------------------------------------- *
 * The builder
 * -------------------------------------------------------------------------- */

/**
 * §5.6 step 2. Constructed in the worker's `TriggerAppRuntimeModule` (plan §6.4:980) and — like every
 * other App runtime class — constructible with **nothing** bound, because every collaborator is
 * `@Optional()` and each absent one has a defined answer (the table at
 * `app-verification-target.service.ts:53-67` is the house pattern): a refusal for the reads that
 * cannot be guessed, a warning for the two that can.
 */
@Injectable()
export class AppRenderInputBuilder implements AppVerificationSpecSource {
    private readonly logger = new Logger(AppRenderInputBuilder.name);

    constructor(
        @Optional()
        @Inject(APP_DEPLOY_SPEC_SOURCE)
        private readonly specs?: AppDeploySpecSource,
        @Optional()
        @Inject(APP_DEPLOY_BUILD_SOURCE)
        private readonly builds?: AppDeployBuildSource,
        @Optional()
        @Inject(APP_RUNTIME_ENV_SOURCE)
        private readonly env?: AppRuntimeEnvSource,
        @Optional()
        @Inject(APP_IMAGE_PULL_CREDENTIAL_SOURCE)
        private readonly pullCredentials?: AppImagePullCredentialSource,
        @Optional()
        @Inject(APP_DEPLOY_HOST_SOURCE)
        private readonly hosts?: AppRenderHostSource,
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tier?: AppsTierPolicy,
    ) {}

    /**
     * Build the render input of §3 for one Deployment. Resolves — always; an unmet platform state is
     * a named `code` in the result, never an exception, because a throw inside `app-deploy` would
     * leave the Deployment row without the reason (the rule §5.1 states for its own pass).
     */
    async build(request: AppRenderInputRequest): Promise<AppRenderInputResult> {
        const prepared = await this.assemble(request);

        return prepared.result;
    }

    /**
     * §4.12's spec side, for T60's `verification-deploy` — the same assembly, with the parts a
     * verification must not have (§4.12:649-652: no Ingress, no TLS, no CronJob, no DNS) and without
     * the `env` block, which is APW-07's **ephemeral** resolution (R-10) and therefore T60's call,
     * not this one's.
     *
     * `undefined` when the input cannot be built — "never a half-built input"
     * (`app-verification-target.service.ts:572`). The namespace is the verification namespace T60
     * already derived, and the target is `your-cluster`: §4.12:638 runs verifications on **your**
     * cluster only.
     */
    async readVerificationSpec(
        request: AppVerificationSpecRequest,
    ): Promise<AppVerificationSpec | undefined> {
        const workId = text(request?.workId);
        const namespace = text(request?.namespace);
        const ttlMinutes = request?.ttlMinutes;

        if (!workId || !namespace || !isPositiveNumber(ttlMinutes)) {
            return undefined;
        }

        const attempt = isPositiveNumber(request?.attempt) ? Math.floor(request.attempt) : 1;
        const provisioningId = text(request?.provisioningId);
        // The slug is not part of T60's request; `AppVerificationSpecRequest` may carry it
        // additively, and §4.1's namespace name carries it by construction either way.
        const slug =
            text((request as { workSlug?: string | null })?.workSlug) ||
            workSlugFromNamespace(namespace);

        const prepared = await this.assemble({
            workId,
            workSlug: slug,
            ref: { workId, namespace, target: 'your-cluster' },
            // §4.1's Job name is `job-<name>-<deploymentShort>` and a verification has no
            // `WorkDeployment` row (§4.12:656-661): the attempt's own short id is the honest suffix.
            deploymentId: `verification-${provisioningId || workId}-${attempt}`,
            specCommitSha: request?.specCommitSha,
            buildId: request?.buildId,
            imageDigest: request?.imageDigest,
            // §4.12:649-652 — no Ingress and no TLS; the namespace's policies come from
            // `prepareAppNamespace`, and the first-deploy jobs *do* run (they are the migration).
            targetSettings: { tls: 'none', networkIsolation: true },
            purpose: 'verification',
            ttlMinutes: ttlMinutes,
            isFirstDeploymentOnCluster: true,
            skipPreDeployJobs: false,
        });

        if (prepared.result.status !== 'ready' || !prepared.result.input) {
            return undefined;
        }

        return {
            input: withoutEnv(prepared.result.input),
            dependencyKinds: declaredDependencyKinds(prepared.spec),
        };
    }

    /**
     * The assembly both entry points share, returning the result **and** the spec it was read from —
     * the one fact `readVerificationSpec` needs for `dependencyKinds` and must not read twice.
     */
    private async assemble(
        request: AppRenderInputRequest,
    ): Promise<{ result: AppRenderInputResult; spec: AppSpec | null }> {
        const warnings: AppRenderInputWarning[] = [];
        const workId = text(request?.workId);
        const ref = normaliseRef(request?.ref, workId);

        if (!ref) {
            // §9.6:1439 — the target was never resolved, so there is no namespace to render into.
            return refuse(
                'target_not_checked',
                'no resolved App target was handed to the builder',
                null,
            );
        }

        // ---- 1 · the Build, when the request names one (§5.6 step 2, ACC-06-20) ----------------
        const buildId = text(request?.buildId) || null;
        let build: AppDeployBuildSnapshot | null = null;
        let requestedCommit = text(request?.specCommitSha) || null;

        if (buildId) {
            const read = await this.readBuild(workId, buildId);

            if (read === undefined) {
                return refuse('no_green_build', `Build ${buildId} could not be read`, null);
            }

            if (read === null) {
                // §5.1:682 — the Deployment names a Build that is not this Work's.
                return refuse(
                    'no_green_build',
                    `Build ${buildId} does not belong to this App Work`,
                    null,
                );
            }

            if (String(read.status ?? '') !== 'succeeded') {
                return refuse(
                    'no_green_build',
                    `Build ${buildId} is ${text(read.status) || 'unknown'}, not succeeded`,
                    null,
                );
            }

            if (!text(read.imageReference)) {
                // §5.1:682 — a green Build that produced nothing to run.
                return refuse(
                    'build_image_missing',
                    `Build ${buildId} carries no image reference`,
                    null,
                );
            }

            build = read;
            // ACC-06-20: the App spec is read at the Build's own commit, never at the head.
            requestedCommit = text(read.commitSha) || null;
        }

        // ---- 2 · the App spec, at the Deployment's commit (ACC-06-20) -------------------------
        const spec = await this.readSpec(workId, requestedCommit);

        if (spec.status !== 'ready' || !spec.snapshot) {
            return refuse(
                spec.code ?? 'spec_unavailable',
                spec.reason ?? 'the App spec could not be read',
                null,
            );
        }

        const specBody = spec.snapshot.spec ?? null;
        const strategy = text(specBody?.build?.strategy) || 'none';
        const publishedImage = strategy === 'image';
        // ACC-06-20: the commit the App spec was **read at**, which is the Build's own commit for a
        // Build-backed Deployment. APW-03's snapshot may echo the effective/head commit instead
        // (`getEffectiveSpec` returns the stored spec when it is the head's), and taking that value
        // would put an image from one commit beside a spec from another — the exact drift ACC-06-20
        // forbids. The snapshot's `commitSha` is therefore only the answer to a head read (an
        // `image`-strategy request that named no commit).
        const specCommitSha = requestedCommit || text(spec.snapshot.commitSha) || '';

        if (strategy === 'none') {
            // §5.8:898-899 — Builds still run, but there is nothing to run.
            return refuse(
                'nothing_to_deploy',
                'the effective App spec builds no image to run',
                specBody,
            );
        }

        if (publishedImage && build) {
            // §5.8:874-875 with T24's `400 build_not_applicable` (`tasks.md:426`): the strategy is
            // the authority for the image, the commit and the credential, and a Deployment that
            // names a Build as well cannot honour all three.
            return refuse(
                'build_not_applicable',
                'a published-image App spec declares no Build, but the request named one',
                specBody,
            );
        }

        if (!publishedImage && !build) {
            return refuse(
                'no_green_build',
                `strategy ${strategy} deploys a Build and the request named none`,
                specBody,
            );
        }

        // ---- 3 · the image (ACC-06-20 · ACC-06-52) -------------------------------------------
        let imageReference: string;
        let pullCredential: { server: string; username: string; password: string } | null = null;

        if (publishedImage) {
            // §5.8:883-885 — the spec's own reference, and the pull-credential port is **never**
            // called: a published-image Deployment runs a public image only.
            imageReference = text(specBody?.build?.image);

            if (!imageReference) {
                // §5.1:682 / APW-03 R19 — `build.image` is required with `strategy: image`.
                return refuse(
                    'build_image_missing',
                    'the App spec declares no build.image',
                    specBody,
                );
            }

            imageReference = pinnedReference(imageReference, text(request?.imageDigest) || null);
        } else {
            // ACC-06-20: the same Build snapshot the commit came from supplies the reference.
            imageReference = text((build as AppDeployBuildSnapshot).imageReference);

            if (!this.pullCredentials?.resolve) {
                // §5.1:695 — platform configuration: the per-App-Work read-only credential is the
                // only way a private image may be pulled, and guessing one is not an option.
                return refuse(
                    'pull_credential_unavailable',
                    'no App image pull credential source is bound',
                    specBody,
                );
            }

            pullCredential = await this.resolvePullCredential(workId, buildId as string);

            if (pullCredential === undefined) {
                return refuse(
                    'pull_credential_unavailable',
                    'the App image pull credential could not be resolved',
                    specBody,
                );
            }
        }

        // ---- 4 · hosts (§8.1) and the primary URL (§4.11) -------------------------------------
        // §4.12:649-652 — a verification publishes nothing (no Ingress, no TLS, no DNS record), so
        // it neither asks T26 nor renders a host. Asking would be worse than useless: the live
        // host set belongs to the App Work's own Deployment, not to a throwaway namespace.
        const verification = request?.purpose === 'verification';
        const settings = request?.targetSettings ?? null;
        const hosts = verification
            ? ({ primary: null, extra: [], previous: [] } as AppRenderHosts)
            : await this.readHosts(workId, warnings);
        const primaryHost = hosts.primary;
        const primaryUrl =
            text(hosts.primaryUrl) || urlForHost(primaryHost, text(settings?.tls) || null);

        // ---- 5 · the target's policy, ingress and network -------------------------------------
        const targetPolicy = this.resolveTargetPolicy(ref, settings, request?.clusterCheck ?? null);

        if (targetPolicy.status !== 'ready') {
            return refuse(
                targetPolicy.code ?? 'tier_pod_policy_unavailable',
                targetPolicy.reason ?? 'the deploy target has no usable policy',
                specBody,
            );
        }

        // ---- 6 · env and dependency egress (§9.6, §5.6 step 2) --------------------------------
        // 🛑 A verification resolves **nothing** here: R-10 (`resolveEphemeral`'s contract,
        // `ports.ts:158-182`) says a verification reads no stored generated value and writes none,
        // and `AppRuntimeEnvSource.resolve` is the stored path. T60 resolves the ephemeral env and
        // completes the input with `withEphemeralEnv` (`app-verification-target.service.ts:586-598`),
        // so this file must contribute an empty `env` and an empty egress rather than a live read.
        const internalUrls = internalUrlsFor(specBody, ref.namespace);
        const preview = request?.preview ?? null;
        let envValues: Record<string, string> = {};
        let secretNames: string[] = [];
        let extraEgress: AppRenderEgressEntry[] = [];

        if (!verification) {
            if (!this.env?.resolve) {
                return refuse(
                    'env_source_unavailable',
                    'no App runtime env source is bound',
                    specBody,
                );
            }

            let envAnswer: Awaited<ReturnType<AppRuntimeEnvSource['resolve']>>;

            try {
                envAnswer = await this.env.resolve(workId, specCommitSha, {
                    // APW06-G08: the target, verbatim, for every value of the union.
                    target: ref.target,
                    primaryUrl,
                    primaryHost,
                    // §5.8:875 — "the env-source context carries `buildCommitSha: null`" under `image`.
                    buildCommitSha: publishedImage
                        ? null
                        : text((build as AppDeployBuildSnapshot).commitSha) || null,
                    internalUrls,
                    ...(preview && isPositiveNumber(preview.prNumber) ? { preview } : {}),
                });
            } catch (error) {
                this.logger.warn(
                    `App env resolution failed for work ${workId}: ${messageOf(error)}`,
                );

                return refuse('env_source_unavailable', messageOf(error), specBody);
            }

            reportEnvGaps(envAnswer, warnings);

            // Exactly the port's answer (ACC-06-16), and nothing merged in.
            envValues = { ...(envAnswer?.values ?? {}) };
            secretNames = [...(envAnswer?.secretNames ?? [])];
            extraEgress = await this.resolveEgress(envAnswer?.egress, warnings);
        }

        // ---- 7 · the input itself (§3) --------------------------------------------------------
        const deploymentShort =
            text(request?.deploymentShort) || deploymentShortFor(text(request?.deploymentId));

        const input: AppRenderInput = {
            ref,
            purpose: request?.purpose === 'verification' ? 'verification' : 'deploy',
            workSlug: text(request?.workSlug),
            deploymentId: text(request?.deploymentId),
            deploymentShort,
            specCommitSha,
            isFirstDeploymentOnCluster: request?.isFirstDeploymentOnCluster === true,
            skipPreDeployJobs: request?.skipPreDeployJobs === true,
            image: {
                reference: imageReference,
                ...(pullCredential
                    ? {
                          pull: {
                              server: pullCredential.server,
                              username: pullCredential.username,
                              password: pullCredential.password,
                          },
                      }
                    : {}),
            },
            components: componentInputs(specBody, ref.namespace),
            jobs: jobInputs(specBody),
            cron: cronInputs(specBody),
            smoke: smokeInputs(specBody),
            env: {
                // Exactly the port's answer (ACC-06-16) — a copy of `values` and nothing else, so no
                // platform key can appear that the env source did not return. The checksum stays
                // empty so the renderer's `effectiveEnvChecksum` derives §4.7's one checksum over
                // **both** maps (env Secret + platform ConfigMap), exactly as R-10's ephemeral path
                // does (`app-verification-target.service.ts:579-585`). No port, no `values`.
                values: envValues,
                checksum: '',
                secretNames,
            },
            hosts: {
                primary: primaryHost,
                extra: [...(hosts.extra ?? [])],
                previous: [...(hosts.previous ?? [])],
            },
            ingress: targetPolicy.ingress,
            network: {
                isolation: targetPolicy.isolation,
                extraEgress,
                // §4.11:628-633 — FR-37's self-address check is the spec's own declaration.
                needsHairpin: specBody?.domains?.needsHairpin === true,
            },
            policy: targetPolicy.policy,
            ...(preview && isPositiveNumber(preview.prNumber)
                ? { preview: { prNumber: Math.floor(preview.prNumber) } }
                : {}),
            ...(request?.purpose === 'verification' && isPositiveNumber(request?.ttlMinutes)
                ? { ttlMinutes: Math.floor(request.ttlMinutes) }
                : {}),
        };

        return {
            result: { status: 'ready', input, code: null, reason: null, warnings },
            spec: specBody,
        };
    }

    /* ---------------------------------------------------------------------- *
     * The three reads
     * ---------------------------------------------------------------------- */

    /** `undefined` = the read threw or no source is bound; `null` = no such Build. Never a guessed Build. */
    private async readBuild(
        workId: string,
        buildId: string,
    ): Promise<AppDeployBuildSnapshot | null | undefined> {
        if (!this.builds?.getBuild) return undefined;

        try {
            return (await this.builds.getBuild(workId, buildId)) ?? null;
        } catch (error) {
            this.logger.warn(
                `Build ${buildId} read failed for work ${workId}: ${messageOf(error)}`,
            );

            return undefined;
        }
    }

    /** The App spec at one commit. `status` is APW-03's own string, never narrowed: T21's `isDeployableAppSpecStatus` decides. */
    private async readSpec(workId: string, commitSha: string | null): Promise<AppRenderSpecRead> {
        if (!this.specs?.getEffectiveSpec) {
            return {
                status: 'unavailable',
                code: 'spec_unavailable',
                reason: 'no App spec source is bound',
                snapshot: null,
            };
        }

        let snapshot: AppDeploySpecSnapshot | null;

        try {
            snapshot = (await this.specs.getEffectiveSpec(workId, commitSha)) ?? null;
        } catch (error) {
            return {
                status: 'unavailable',
                code: 'spec_unavailable',
                reason: messageOf(error),
                snapshot: null,
            };
        }

        if (!snapshot) {
            return {
                status: 'unavailable',
                code: 'spec_unavailable',
                reason: `no App spec at ${commitSha ?? 'the deploy branch head'}`,
                snapshot: null,
            };
        }

        if (!isDeployableAppSpecStatus(snapshot.status)) {
            return {
                status: 'unavailable',
                code: 'spec_invalid',
                // Names only: APW-03's issues carry codes and paths, never values.
                reason: `the App spec is ${text(snapshot.status) || 'unreadable'} at ${
                    commitSha ?? 'the deploy branch head'
                }`,
                snapshot,
            };
        }

        return { status: 'ready', code: null, reason: null, snapshot };
    }

    /**
     * §8.1's hosts. A seam that can answer the whole set is asked once; T21's narrower seam still
     * yields the primary host. A throwing or unbound seam is a **warning**, never a refusal —
     * §5.1:686 is the plan's own precedent ("the in-cluster URL is used with warning … instead of
     * refusing the Deployment"), and an App Work with no published host is a legal state (§8.1's
     * `primary` is `null` when no custom domain is primary and no managed subdomain is allocated).
     */
    private async readHosts(
        workId: string,
        warnings: AppRenderInputWarning[],
    ): Promise<AppRenderHosts> {
        const empty: AppRenderHosts = { primary: null, extra: [], previous: [] };

        if (!this.hosts) {
            warnings.push({
                code: APP_RENDER_WARNING_HOST_SOURCE_UNAVAILABLE,
                message: 'No App host source is bound, so this Deployment publishes no host.',
            });

            return empty;
        }

        if (this.hosts.resolveHosts) {
            try {
                const hosts = await this.hosts.resolveHosts(workId);

                if (hosts) {
                    return {
                        primary: text(hosts.primary) || null,
                        extra: [...(hosts.extra ?? [])],
                        previous: [...(hosts.previous ?? [])],
                        primaryUrl: text(hosts.primaryUrl) || null,
                    };
                }
            } catch (error) {
                warnings.push({
                    code: APP_RENDER_WARNING_HOST_SOURCE_UNAVAILABLE,
                    message: `The App host set could not be read: ${messageOf(error)}`,
                });

                return empty;
            }
        } else {
            warnings.push({
                code: APP_RENDER_WARNING_HOSTS_INCOMPLETE,
                message:
                    'The App host source answers only the primary host, so non-primary custom domains are not published.',
            });
        }

        if (!this.hosts.primaryHost) return empty;

        try {
            return { ...empty, primary: text(await this.hosts.primaryHost(workId)) || null };
        } catch (error) {
            warnings.push({
                code: APP_RENDER_WARNING_HOST_SOURCE_UNAVAILABLE,
                message: `The primary App host could not be resolved: ${messageOf(error)}`,
            });

            return empty;
        }
    }

    /** `undefined` = the port refused or threw; `null` = the port answered "no credential" (a public image). */
    private async resolvePullCredential(
        workId: string,
        buildId: string,
    ): Promise<{ server: string; username: string; password: string } | null | undefined> {
        try {
            const credential = await this.pullCredentials?.resolve(workId, buildId);

            if (!credential || !text(credential.server) || !text(credential.username)) return null;

            // Verbatim, field for field: the pull block is the port's answer (ACC-06-16).
            return {
                server: credential.server,
                username: credential.username,
                password: credential.password,
            };
        } catch (error) {
            this.logger.warn(
                `App pull credential resolution failed for work ${workId}: ${messageOf(error)}`,
            );

            return undefined;
        }
    }

    /* ---------------------------------------------------------------------- *
     * §4.10's dependency egress
     * ---------------------------------------------------------------------- */

    /**
     * `AppRuntimeEnvSource`'s `egress` is `{ host, ports }` (§9.6:1399) while §3:234's `extraEgress` is
     * `{ cidr, ports }`, so every host becomes one CIDR per resolved address: `/32` for IPv4 and
     * `/128` for IPv6 — the exact destination, never a range, because `ew-allow-deps` (§4.10:577) is
     * what keeps a dependency reachable and a wider CIDR would admit more than the dependency.
     *
     * A host that cannot be resolved contributes **nothing** and records
     * {@link APP_RENDER_WARNING_EGRESS_UNRESOLVED}: the alternative — inventing a CIDR — would either
     * be a no-op or, worse, a rule that admits something else.
     */
    private async resolveEgress(
        egress: readonly { host: string; ports: number[] }[] | null | undefined,
        warnings: AppRenderInputWarning[],
    ): Promise<AppRenderEgressEntry[]> {
        const resolved: AppRenderEgressEntry[] = [];
        const seen = new Set<string>();

        for (const entry of egress ?? []) {
            const host = text(entry?.host);
            const ports = [
                ...new Set((entry?.ports ?? []).filter((port) => isPositiveNumber(port))),
            ].map((port) => Math.floor(port));

            if (!host || ports.length === 0) continue;

            let addresses: string[];

            try {
                addresses = await this.resolveHostAddresses(host);
            } catch (error) {
                warnings.push({
                    code: APP_RENDER_WARNING_EGRESS_UNRESOLVED,
                    message: `The dependency host ${host} could not be resolved: ${messageOf(error)}`,
                });

                continue;
            }

            if (!Array.isArray(addresses) || addresses.length === 0) {
                warnings.push({
                    code: APP_RENDER_WARNING_EGRESS_UNRESOLVED,
                    message: `The dependency host ${host} resolved to no address.`,
                });

                continue;
            }

            for (const address of addresses) {
                const cidr = cidrFor(address);
                if (!cidr) continue;

                const key = `${cidr}|${ports.join(',')}`;
                if (seen.has(key)) continue;
                seen.add(key);

                resolved.push({ cidr, ports });
            }
        }

        return resolved;
    }

    /**
     * The addresses one host resolves to. `protected` so the spec pins them without touching DNS —
     * the seam T60 uses for its clock (`app-verification-target.service.ts:655-659`) — and the single
     * place §6.1's shared resolver lands when APW06-G20 adds it (`plan.md:923-934`).
     *
     * A literal IP is returned as-is: `dns.lookup` on a literal is a no-op, and skipping it keeps a
     * CIDR for an address the caller already knows from depending on a resolver at all.
     */
    protected async resolveHostAddresses(host: string): Promise<string[]> {
        if (isIP(host) !== 0) return [host];

        const addresses = await dns.promises.lookup(host, { all: true });

        return addresses.map((entry) => entry.address);
    }

    /* ---------------------------------------------------------------------- *
     * §5.6 step 2's "policy from AppsTierPolicy (ever-works-apps) or the your-cluster defaults"
     * ---------------------------------------------------------------------- */

    /**
     * The `policy`, `ingress` and `network.isolation` of the target.
     *
     * `ever-works-apps` is read from `AppsTierPolicy` and nothing is defaulted: the tier owns the
     * sandbox runtime class (§5.1:689 ⇒ `managed_sandbox_unavailable` when it is `null`, R-24), the
     * quota, the limit range and the edge ingress (§9.6:1361-1373). A closed or unbindable policy is
     * a refusal — a managed Deployment rendered with your-cluster defaults would run user code
     * outside the tier's sandbox, which is what R-5 and D15 exist to prevent.
     */
    private resolveTargetPolicy(
        ref: AppTargetRef,
        settings: AppRenderTargetSettings | null,
        clusterCheck: AppRenderClusterCheckView | null,
    ): AppRenderTargetPolicy {
        const yourCluster: AppRenderTargetPolicy = {
            status: 'ready',
            code: null,
            reason: null,
            policy: {
                podSecurity: 'baseline',
                // §4.4:480 — `false` unless the owner allowed root for this App Work.
                allowRoot: settings?.allowRoot === true,
                runtimeClassName: null,
                // §4.2:411 — a ResourceQuota is drawn on `ever-works-apps` only.
                quota: null,
                limitRange: yourClusterLimitRange(),
                // §4.9's 5-minute rule is the managed tier's
                // (`packages/contracts/src/apps/app-runtime.ts:862-868`); the renderer applies it on
                // `ever-works-apps` only, so the same number here is inert on Your cluster and keeps
                // one value in the program (the golden input and `minimalRenderInput` both carry 5).
                cronMinIntervalMinutes: APP_MANAGED_CRON_MIN_INTERVAL_MIN,
                // §5.5:797 — a first Deployment that failed leaves nothing running.
                scaleFailedFirstDeployToZero: true,
                // §4.10:589-593 — only the managed tier turns "not enforced" into a failure.
                requireIsolationEnforced: false,
            },
            ingress: {
                className: text(settings?.ingressClass) || defaultIngressClass(clusterCheck),
                controllerNamespace:
                    text(settings?.controllerNamespace) ||
                    text(clusterCheck?.controllerNamespace) ||
                    null,
                // §4.11:616-626 — the owner's three choices (FR-42); the selector's shown default is
                // "Certificates from issuer" (§10.2:633), so an unset setting is that choice, not
                // "no TLS". `edge` is the managed tier's and is never rendered here.
                tls: normaliseTls(settings?.tls),
                issuer: text(settings?.issuer) || null,
            },
            isolation: settings?.networkIsolation !== false,
        };

        if (ref.target !== 'ever-works-apps') return yourCluster;

        if (!this.tier?.isOpen) {
            return {
                ...yourCluster,
                status: 'unavailable',
                code: 'managed_disabled',
                reason: 'no managed hosting policy is bound',
            };
        }

        if (!this.tier.isOpen()) {
            // §5.1:688 — the tier is closed, so the managed target is not offered at all.
            return {
                ...yourCluster,
                status: 'unavailable',
                code: 'managed_disabled',
                reason: 'the managed hosting tier is closed',
            };
        }

        let podPolicy: ReturnType<AppsTierPolicy['podPolicy']>;

        try {
            podPolicy = this.tier.podPolicy();
        } catch (error) {
            return {
                ...yourCluster,
                status: 'unavailable',
                code: 'tier_pod_policy_unavailable',
                reason: messageOf(error),
            };
        }

        if (!text(podPolicy?.runtimeClassName)) {
            // §5.1:689 / R-24 — a sandbox runtime class is the managed tier's precondition.
            return {
                ...yourCluster,
                status: 'unavailable',
                code: 'managed_sandbox_unavailable',
                reason: 'the managed tier names no sandbox runtime class',
            };
        }

        let ingress: ReturnType<AppsTierPolicy['ingress']>;

        try {
            ingress = this.tier.ingress();
        } catch (error) {
            return {
                ...yourCluster,
                status: 'unavailable',
                code: 'tier_ingress_unavailable',
                reason: messageOf(error),
            };
        }

        return {
            status: 'ready',
            code: null,
            reason: null,
            policy: {
                podSecurity: 'restricted',
                allowRoot: false,
                runtimeClassName: text(podPolicy.runtimeClassName),
                quota: (podPolicy.quota ?? null) as AppQuotaInput,
                limitRange: (podPolicy.limitRange ?? {
                    ...yourClusterLimitRange(),
                    max: { ...APP_RENDER_MANAGED_LIMIT_RANGE_MAX },
                }) as AppLimitRangeInput,
                cronMinIntervalMinutes: APP_MANAGED_CRON_MIN_INTERVAL_MIN,
                scaleFailedFirstDeployToZero: true,
                requireIsolationEnforced: true,
            },
            ingress: {
                className: text(ingress?.className) || null,
                controllerNamespace: text(ingress?.controllerNamespace) || null,
                tls: 'edge',
                issuer: null,
            },
            // §4.4:487 / D15 — the managed tier always isolates.
            isolation: true,
        };
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — the §3 resolution rules
 * -------------------------------------------------------------------------- */

/** A named refusal plus the spec (when one was read) for the caller's `dependencyKinds`. */
function refuse(
    code: string,
    reason: string,
    spec: AppSpec | null,
): { result: AppRenderInputResult; spec: AppSpec | null } {
    return {
        result: { status: 'unavailable', input: null, code, reason, warnings: [] },
        spec,
    };
}

/** §3.1:564-568 — the input without its `env` block, for T60's ephemeral completion (R-10). */
function withoutEnv(input: AppRenderInput): Omit<AppRenderInput, 'env'> {
    // `AppRenderInput`'s members are `readonly`, so the copy is widened before the key is dropped.
    const copy = { ...input } as Record<string, unknown>;
    delete copy['env'];

    return copy as unknown as Omit<AppRenderInput, 'env'>;
}

/** A fresh §4.2 your-cluster `LimitRange`, so no caller can mutate the exported constant's leaves. */
function yourClusterLimitRange(): AppLimitRangeInput {
    return {
        defaultRequest: { ...APP_RENDER_DEFAULT_LIMIT_RANGE.defaultRequest },
        defaultLimit: { ...APP_RENDER_DEFAULT_LIMIT_RANGE.defaultLimit },
        max: { ...APP_RENDER_DEFAULT_LIMIT_RANGE.max },
    };
}

/** `deploymentId` → 8 hex (the golden harness's rule, `golden/check.mjs:657`). */
export function deploymentShortFor(deploymentId: string): string {
    return text(deploymentId).replace(/-/g, '').slice(0, APP_RENDER_DEPLOYMENT_SHORT_LENGTH);
}

/**
 * `components.<name>.internalUrl` — `http://<name>.<namespace>.svc.cluster.local` (CONTRACTS §1,
 * plan §4.3:468-471), for every component, which is the map T21's precondition pass builds from the
 * same fact (`app-deploy-preconditions.service.ts:1520-1535`). §21:440 is what refuses a *worker*
 * reference at validation time; this map is not the validator, and the renderer draws a Service for a
 * `web` component only, so including a worker resolves nothing an invalid spec could use.
 *
 * The namespace is `ref.namespace`, known before rendering (§4.3:470), so there is no
 * "namespace not decided yet" case here.
 */
export function internalUrlsFor(
    spec: AppSpec | null | undefined,
    namespace: string,
): Record<string, string> {
    const urls: Record<string, string> = {};
    const ns = text(namespace);

    if (!ns) return urls;

    for (const component of spec?.components ?? []) {
        const name = text(component?.name);

        if (name) urls[name] = `http://${name}.${ns}.svc.cluster.local`;
    }

    return urls;
}

/**
 * `domains.primaryComponent` when declared, else the only `web` component (APW-03 schema §15:349;
 * the renderer's own `primaryWebComponent`, `app-manifest.renderer.ts:791-801`). Spelled here for the
 * same reason `internalUrl` is: the agent may not import the k8s plugin, and §3.1's `primary` field
 * is the one value the renderer must not have to re-derive.
 */
export function primaryComponentName(spec: AppSpec | null | undefined): string | null {
    const declared = text(spec?.domains?.primaryComponent);

    if (declared) return declared;

    const webs = (spec?.components ?? []).filter((component) => component?.role === 'web');

    return webs.length === 1 ? text(webs[0]?.name) || null : null;
}

/**
 * `AppComponentInput[]` — APW-03's `components[]` with the schema §10 defaults resolved, plus
 * `primary`, `deadlineSeconds` and `internalUrl` (§3.1:328-329).
 *
 * The deadline is §5.3:769-771's formula through the contract's own `appComponentDeadlineSeconds`
 * (R-1 — imported, never re-implemented), fed the **resolved** probe timings: a declared probe
 * contributes the schema's defaults for the fields it leaves silent, and a component with no probe
 * at all contributes the web defaults of §4.5 — hence 750 for a web component and 300 (the floor)
 * for a worker, which is what the golden inputs carry.
 */
export function componentInputs(
    spec: AppSpec | null | undefined,
    namespace: string,
): AppComponentInput[] {
    const primary = primaryComponentName(spec);
    const buildTarget = text(spec?.build?.target);

    return (spec?.components ?? []).map((component): AppComponentInput => {
        const name = text(component?.name);
        const role = component?.role === 'worker' ? 'worker' : 'web';
        const resources = component?.resources ?? {};
        const memory = text(resources.memory) || COMPONENT_DEFAULTS.memory;
        const target = text(component?.target) || buildTarget;

        return {
            name,
            role,
            ...(component?.command ? { command: [...component.command] } : {}),
            ...(component?.args ? { args: [...component.args] } : {}),
            // §3.1:328 — `components[].target` is `build.target` when the component is silent.
            ...(target ? { target } : {}),
            ...(isPositiveNumber(component?.port) ? { port: Math.floor(component.port) } : {}),
            replicas: isPositiveNumber(component?.replicas)
                ? Math.floor(component.replicas)
                : COMPONENT_DEFAULTS.replicas,
            writableRootFilesystem: component?.writableRootFilesystem === true,
            // APW06-G26: passed through **verbatim** and never derived (the renderer's own rule).
            ...(isPositiveNumber(component?.runAsUser)
                ? { runAsUser: Math.floor(component.runAsUser) }
                : {}),
            probes: probeInputs(component),
            resources: {
                cpu: text(resources.cpu) || COMPONENT_DEFAULTS.cpu,
                memory,
                ...(text(resources.cpuLimit) ? { cpuLimit: text(resources.cpuLimit) } : {}),
                // APW-03 schema §10's relative default: `2 × memory`.
                memoryLimit: text(resources.memoryLimit) || doubleQuantity(memory),
            },
            volumes: (component?.volumes ?? []).map((volume) => ({
                name: text(volume?.name),
                path: text(volume?.path),
                size: text(volume?.size),
                backup: volume?.backup !== false,
            })),
            primary: name.length > 0 && name === primary,
            deadlineSeconds: appComponentDeadlineSeconds({
                startup: deadlineProbe(component?.probes?.startup, 'startup', role),
                readiness: deadlineProbe(component?.probes?.readiness, 'readiness', role),
            }),
            internalUrl: `http://${name}.${text(namespace)}.svc.cluster.local`,
        };
    });
}

/** §3.1:330 — APW-03's `jobs[]` with `component` resolved (schema §13:313, `domains.primaryComponent`). */
export function jobInputs(spec: AppSpec | null | undefined): AppJobInput[] {
    const primary = primaryComponentName(spec);

    return (spec?.jobs ?? []).map((job): AppJobInput => {
        const component = text(job?.component) || primary;

        return {
            name: text(job?.name),
            when: text(job?.when) as AppJobInput['when'],
            component: component || '',
            ...(job?.command ? { command: [...job.command] } : {}),
            ...(job?.http ? { http: cloneHttp(job.http) } : {}),
            ...(isPositiveNumber(job?.timeoutSeconds)
                ? { timeoutSeconds: Math.floor(job.timeoutSeconds) }
                : {}),
            ...(isPositiveNumber(job?.retries) ? { retries: Math.floor(job.retries) } : {}),
        };
    });
}

/** §3.1:331 — APW-03's `cron[]`; only `component` is resolved (schema §14's defaults are the renderer's). */
export function cronInputs(spec: AppSpec | null | undefined): AppCronInput[] {
    const primary = primaryComponentName(spec);

    return (spec?.cron ?? []).map((cron): AppCronInput => {
        const component = text(cron?.component) || primary;

        return {
            name: text(cron?.name),
            schedule: text(cron?.schedule),
            ...(component ? { component } : {}),
            ...(cron?.command ? { command: [...cron.command] } : {}),
            ...(cron?.http ? { http: cloneHttp(cron.http) } : {}),
            ...(isPositiveNumber(cron?.timeoutSeconds)
                ? { timeoutSeconds: Math.floor(cron.timeoutSeconds) }
                : {}),
            ...(cron?.concurrency ? { concurrency: cron.concurrency } : {}),
        };
    });
}

/** §3.1:332 — APW-03's `smoke[]` with `name` and `component` resolved (schema §16:354-369). */
export function smokeInputs(spec: AppSpec | null | undefined): AppSmokeInput[] {
    const primary = primaryComponentName(spec);

    return (spec?.smoke ?? []).map((smoke): AppSmokeInput => {
        const component = text(smoke?.component) || primary;

        return {
            name: text(smoke?.name),
            component: component || '',
            http: {
                ...(text(smoke?.http?.method) ? { method: smoke.http.method } : {}),
                path: text(smoke?.http?.path),
                ...(smoke?.http?.body === undefined ? {} : { body: smoke.http.body }),
            },
            ...(smoke?.expect
                ? {
                      expect: {
                          ...(smoke.expect.status ? { status: [...smoke.expect.status] } : {}),
                          ...(smoke.expect.bodyContains
                              ? { bodyContains: [...smoke.expect.bodyContains] }
                              : {}),
                          ...(smoke.expect.bodyNotContains
                              ? { bodyNotContains: [...smoke.expect.bodyNotContains] }
                              : {}),
                          ...(isPositiveNumber(smoke.expect.maxLatencyMs)
                              ? { maxLatencyMs: Math.floor(smoke.expect.maxLatencyMs) }
                              : {}),
                      },
                  }
                : {}),
            ...(text(smoke?.when) ? { when: smoke.when } : {}),
        };
    });
}

/** §4.8/§4.9: an `http` block is data; `body` may hold `{{env.NAME}}` placeholders and is copied. */
function cloneHttp(http: {
    method?: string;
    path: string;
    body?: unknown;
    authEnv?: string;
    authScheme?: string;
    expect?: { status?: readonly number[] };
}): NonNullable<AppJobInput['http']> {
    return {
        ...(text(http?.method) ? { method: http.method } : {}),
        path: text(http?.path),
        ...(http?.body === undefined ? {} : { body: http.body }),
        ...(text(http?.authEnv) ? { authEnv: text(http.authEnv) } : {}),
        ...(text(http?.authScheme) ? { authScheme: http.authScheme } : {}),
        ...(http?.expect?.status ? { expect: { status: [...http.expect.status] } } : {}),
    } as NonNullable<AppJobInput['http']>;
}

/**
 * The probes of §3.1's `AppComponentInput`, with the four timings resolved: a declared probe carries
 * all four numbers (the type requires them, and the renderer writes a declared probe verbatim —
 * `app-manifest.renderer.ts:1139-1160`). A probe the spec does not declare is **omitted**, so the
 * renderer draws its own §4.5 default for a web component and nothing for a worker.
 */
function probeInputs(component: AppSpecComponent | null | undefined): AppComponentInput['probes'] {
    const declared = component?.probes ?? {};
    const probes: Record<string, unknown> = {};

    for (const kind of ['startup', 'readiness', 'liveness'] as const) {
        const probe = declared[kind];
        if (!probe) continue;

        const defaults = PROBE_DEFAULTS[kind];

        probes[kind] = {
            ...(text(probe.http) ? { http: text(probe.http) } : {}),
            ...(probe.tcp === true ? { tcp: true as const } : {}),
            periodSeconds: isPositiveNumber(probe.periodSeconds)
                ? probe.periodSeconds
                : defaults.periodSeconds,
            timeoutSeconds: isPositiveNumber(probe.timeoutSeconds)
                ? probe.timeoutSeconds
                : defaults.timeoutSeconds,
            initialDelaySeconds: isNonNegativeNumber(probe.initialDelaySeconds)
                ? probe.initialDelaySeconds
                : defaults.initialDelaySeconds,
            failureThreshold: isPositiveNumber(probe.failureThreshold)
                ? probe.failureThreshold
                : defaults.failureThreshold,
        };
    }

    return probes as AppComponentInput['probes'];
}

/** The §5.3 formula's two inputs for one probe kind, with the web defaults where the spec is silent. */
function deadlineProbe(
    probe: AppSpecProbe | null | undefined,
    kind: 'startup' | 'readiness',
    role: 'web' | 'worker',
): { periodSeconds: number; failureThreshold: number } {
    const web = kind === 'startup' ? APP_RENDER_WEB_STARTUP_PROBE : APP_RENDER_WEB_READINESS_PROBE;

    if (probe) {
        const schema = PROBE_DEFAULTS[kind];

        return {
            periodSeconds: isPositiveNumber(probe.periodSeconds)
                ? probe.periodSeconds
                : schema.periodSeconds,
            failureThreshold: isPositiveNumber(probe.failureThreshold)
                ? probe.failureThreshold
                : schema.failureThreshold,
        };
    }

    // §4.5:516 — the web defaults; a worker declares no probe by default (§10's readiness default is
    // "`{ tcp: true }` for `web` only"), so it contributes §5.3's `+ 120` alone.
    return role === 'web'
        ? { periodSeconds: web.periodSeconds, failureThreshold: web.failureThreshold }
        : { periodSeconds: 0, failureThreshold: 0 };
}

/** The dependency kinds an App spec declares, in the spec's own vocabulary (§4.12:653-656). */
export function declaredDependencyKinds(spec: AppSpec | null | undefined): string[] {
    const dependencies = spec?.dependencies;
    if (!dependencies) return [];

    return (['postgres', 'redis', 'objectStorage', 'smtp'] as const).filter(
        (kind) => dependencies[kind] !== undefined && dependencies[kind] !== null,
    );
}

/** §4.11:621-626's fallback: `http` only when the owner chose no TLS at all, else `https`. */
export function urlForHost(host: string | null, tls: string | null): string | null {
    const value = text(host);
    if (!value) return null;

    return `http${text(tls) === 'none' ? '' : 's'}://${value}`;
}

/** §3:231's four TLS modes; anything else means the selector's default (§10.2:633). */
function normaliseTls(tls: string | null | undefined): AppRenderInput['ingress']['tls'] {
    const value = text(tls);

    return value === 'external' || value === 'none' || value === 'edge' || value === 'cert-manager'
        ? value
        : 'cert-manager';
}

/** §6.3's `ingressClasses`: the class the cluster itself marked default. */
function defaultIngressClass(clusterCheck: AppRenderClusterCheckView | null): string | null {
    const found = (clusterCheck?.ingressClasses ?? []).find((entry) => entry?.isDefault === true);

    return text(found?.name) || null;
}

/** §5.8:883 — `<repository>@<digest>`; a reference already pinned is left exactly as it is. */
export function pinnedReference(reference: string, digest: string | null): string {
    const base = text(reference);
    if (!base || /@sha256:[0-9a-f]{64}$/i.test(base)) return base;

    const value = text(digest);
    if (!value) return base;

    return `${repositoryOf(base)}@${value.startsWith('sha256:') ? value : `sha256:${value}`}`;
}

/** `<repository>` from a reference — a colon is only a tag when it follows the last `/`. */
function repositoryOf(reference: string): string {
    const at = reference.indexOf('@');
    if (at >= 0) return reference.slice(0, at);

    const colon = reference.lastIndexOf(':');
    const slash = reference.lastIndexOf('/');

    return colon > slash ? reference.slice(0, colon) : reference;
}

/** APW-03 schema §10's relative default `memoryLimit = 2 × memory`, as a quantity (`512Mi` → `1024Mi`). */
function doubleQuantity(quantity: string): string {
    const match = /^(\d+(?:\.\d+)?)(.*)$/.exec(text(quantity));

    return match ? `${Number(match[1]) * 2}${match[2]}` : quantity;
}

/** `e5f6::1` → `e5f6::1/128`, `192.0.2.7` → `192.0.2.7/32`; anything else is not an address and yields `null`. */
function cidrFor(address: string): string | null {
    const value = text(address);
    const family = isIP(value);

    if (family === 4) return `${value}/32`;
    if (family === 6) return `${value}/128`;

    return null;
}

/** §4.12's namespace rule, reversed — the same derivation `workSlugFromNamespace` makes in the plugin. */
export function workSlugFromNamespace(namespace: string): string {
    const match = /^ew-(.+)-[0-9a-f]{8}$/.exec(text(namespace));

    return match ? match[1] : '';
}

/** The §5.1 codes the env answer already names, reported (never refused) for the race §5.6 step 1 covers. */
function reportEnvGaps(
    answer: { unsetRequired?: string[]; notReadyDependencies?: string[] } | null | undefined,
    warnings: AppRenderInputWarning[],
): void {
    const unset = (answer?.unsetRequired ?? []).filter((name) => text(name));

    if (unset.length > 0) {
        warnings.push({
            code: 'env_required_unset',
            message: `Required env values are still unset: ${unset.join(', ')}.`,
        });
    }

    const notReady = (answer?.notReadyDependencies ?? []).filter((kind) => text(kind));

    if (notReady.length > 0) {
        warnings.push({
            code: 'dependency_not_ready',
            message: `Dependencies are not ready: ${notReady.join(', ')}.`,
        });
    }
}

/** The ref, normalised: a missing namespace is not a ref this file can render into (§9.9's answer). */
function normaliseRef(ref: AppTargetRef | null | undefined, workId: string): AppTargetRef | null {
    if (!ref || !text(ref.namespace)) return null;

    return {
        workId: text(ref.workId) || workId,
        namespace: text(ref.namespace),
        target: ref.target,
        ...(ref.kubeContext === undefined ? {} : { kubeContext: ref.kubeContext }),
        ...(text(ref.clusterFingerprint)
            ? { clusterFingerprint: text(ref.clusterFingerprint) }
            : {}),
    };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A message for a log line or a warning. Never a value: only an error's own message. */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
