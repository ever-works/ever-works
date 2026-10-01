/**
 * APW-06 T60 — **verification targets** (`purpose: 'verification'`): Resolution R-10.
 *
 * Spec: `APW-06-app-runtime/spec.md` FR-38 (the isolated worker dials the cluster, never the API),
 * ACC-06-48. Plan: **§4.12** (the contract — `plan.md:635-666`), §9.2 (`plan.md:1247`, `:1272-1285`
 * — the three op payloads and "`verification-deploy` runs `checkAppCluster` first (10 s)"), §9.6
 * (`plan.md:1446-1465` — `AppVerificationUpdate` / `AppVerificationSink`), §9.10
 * (`plan.md:1570-1573` — the router that will route these ops); APW06-G08 (the order) and APW06-G09
 * (the result channel).
 *
 * ## What a verification is, and why it is not a Deployment
 *
 * APW-04 verifies a candidate Build on **your** cluster by deploying it into a throwaway namespace,
 * reading it back, and destroying it. Nothing about that is a Deployment: there is no
 * `work_deployments` row, `work_app_runtime_states.namespace` is never written, no host is
 * published, and the attempt lives on APW-04's own row (§4.12:647-648, `:656-661`).
 *
 * | The verification                                                     | Where the plan fixes it                |
 * | -------------------------------------------------------------------- | -------------------------------------- |
 * | Namespace `<ns>-v<first 6 hex of provisioningId>-<attempt ≤ 9>`        | §4.12:640-646, {@link verificationNamespaceName} |
 * | No Ingress, TLS, CronJob, DNS or PVC; volumes become `emptyDir`        | §4.12:649-652 (the k8s renderer)       |
 * | Smoke is in-cluster only — no public smoke, no hairpin                 | §4.12:657-658 (the k8s deployer)       |
 * | Destroy deletes the namespace (`Foreground`, ≤ 300 s)                  | §4.12:659-660 (the k8s lifecycle)      |
 * | `getAppStatus` returns components, jobs and smoke only                 | §4.12:660 (the k8s status reader)      |
 * | Results go through `AppVerificationSink`                               | §4.12:661-666                          |
 *
 * **The name is EPIC-OWNED** (§4.12:640-646). `verification-deploy` derives it and **returns** it;
 * `verification-destroy` takes it back as a handle. APW-04 never derives one of its own — an earlier
 * draft used `ewv-<work short id>-<attempt>`, which would have had APW-04 destroying a namespace
 * APW-06 never created.
 *
 * ## The order is APW06-G08, and it is asserted rather than assumed
 *
 * `verification-deploy` does exactly this, in this order (§4.12:649-656):
 *
 * 1. `checkAppCluster` — **first**, 10 s budget (§9.2:1283). A failure reports `state:
 *    'unavailable'` through the sink and APW-04 falls back to its runner lane.
 * 2. the namespace **and its policies** — `prepareAppNamespace` draws the Namespace, the
 *    ServiceAccount, the LimitRange and the three baseline NetworkPolicies. It draws **no**
 *    `ew-allow-ingress` / `ew-allow-deps` and no `dep-*` policy — those belong to a Deployment, or
 *    to APW-07's provider (`plan.md:416-433`).
 * 3. `AppDependenciesService.provisionEphemeral(workId, <verification namespace>, kinds)` — APW-07
 *    §4.9 in its `ephemeral: true` mode: no PVC, outputs returned **in memory**, never stored.
 * 4. only then the workloads — `deployApp`, whose own prepare phase re-applies the namespace
 *    idempotently.
 *
 * Everything that can only be *asked* is asked **before the first write**, so a verification that
 * cannot succeed never leaves a namespace behind: the sink, the facade, the target, the spec, the
 * ephemeral env and every required capability are resolved first.
 *
 * ## Fail-closed, never fail-silent-but-wrong
 *
 * Every collaborator is `@Optional()` (the house pattern of `app-runtime-deletion.service.ts`), so
 * the class is constructible with nothing bound and a lean module graph still compiles. Each absent
 * seam has a defined answer, and **none of them is "pretend it worked"**:
 *
 * | Absent seam                                        | The answer                                                                                                       |
 * | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
 * | `APP_VERIFICATION_SINK` (APW-04)                   | the op throws `verification_sink_unavailable` **before** anything is resolved — §4.12:664-666                      |
 * | `APP_RUNTIME_VERIFICATION_FACADE` (T20)            | the op throws `facade_unavailable`; with no cluster access there is not even a namespace name to report against     |
 * | `APP_VERIFICATION_SPEC_SOURCE` (T22)               | report `state: 'unavailable'` + `spec_unavailable`, before any write                                               |
 * | `APP_RUNTIME_ENV_SOURCE` (APW-07)                  | report `state: 'unavailable'` + `env_source_unavailable`; never a Deployment with guessed values                    |
 * | `resolveEphemeral` answering non-empty `unsetRequired` | report `state: 'blocked'` + `env_required_unset`; the app cannot run, and nothing is created                    |
 * | `APP_DEPENDENCIES_SERVICE` (APW-07 T16)            | declared kinds and no provider ⇒ report `state: 'unavailable'` + `dependencies_unavailable` before any write; no declared kinds ⇒ nothing to provision |
 * | `prepareAppNamespace` / `deployApp`                | report `state: 'unavailable'` + `deploy_unavailable`, before any write                                             |
 * | `getAppStatus`                                     | the observation is empty rather than invented; the deploy or destroy still runs                                    |
 * | `readNamespaceExpiry`                              | `expiresAt: ''` — APW-04 already holds `verificationExpiresAt` from the deploy and never overwrites it from a status read |
 *
 * An exception the **cluster** throws is `state: 'infra'` (§4.12's own state), not `red`: `red` means
 * the candidate Build failed, and blaming the Build for an unreachable API server would send APW-04
 * down the wrong lane.
 *
 * ## What this file deliberately does not do
 *
 * - **No `WorkDeployment` row, no runtime-state write** (ACC-06-48). This service does not inject a
 *   `WorkDeployment` writer or a runtime-state store at all — its only output collaborator is the
 *   sink. `AppRuntimeEnvSource.resolve()`, the *stored* env path, is likewise never called; only
 *   `resolveEphemeral`.
 * - **No events.** §9.4's family is per-Deployment and ACCEPTANCE E2E-05 asserts one ordered block
 *   per Deployment; a verification has none, and emitting `app.deploy.*` for it would corrupt that
 *   assertion. APW-04 renders the attempt from what the sink stores.
 * - **No router.** T70 owns `app-cluster-op.router.ts` (`plan.md:1570-1573`); the three ops are
 *   exposed as methods here, and the router routes to them.
 * - **No `pendingOnCapacitySince`.** Capacity back-off is APW-10's managed tier, and a verification
 *   runs on `your-cluster` only (§4.12:638).
 *
 * ## The one name in two packages (reported, R-26)
 *
 * The §4.12 namespace rule is now implemented twice: {@link verificationNamespaceName} here, for the
 * op, and `verificationNamespaceName` in the k8s plugin's `app-names.ts`, for the renderer's caps
 * (`APP_VERIFICATION_NAMESPACE_MAX_LENGTH`). They are the same algorithm because they are the same
 * rule, and they are not *load-bearing* duplicates: the renderer takes `ref.namespace` verbatim and
 * never re-derives it, so the only two things that must agree on the name are this op and
 * `verification-destroy`, which receives it back. `packages/agent` does not depend on
 * `@ever-works/k8s-plugin` (and must not — R-5), and `@ever-works/contracts` carries no namespace
 * helper today, so the right long-term home is a shared helper there, owned by whoever owns T1.
 */

import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
    AppClusterCheck,
    AppClusterCheckRequest,
    AppComponentStatus,
    AppDeployHooks,
    AppDeployPhase,
    AppDeployResult,
    AppDestroyResult,
    AppJobResult,
    AppRenderInput,
    AppSmokeResult,
    AppStatusSnapshot,
    AppStatusSpec,
    AppTargetRef,
} from '@ever-works/plugin';

import { APP_DEPENDENCIES_SERVICE } from './app-runtime-deletion.service.js';
import {
    APP_RUNTIME_ENV_SOURCE,
    APP_VERIFICATION_SINK,
    AppPortUnavailableError,
    type AppRuntimeEnvSource,
    type AppVerificationSink,
    type AppVerificationUpdate,
} from './ports.js';

/* -------------------------------------------------------------------------- *
 * Constants (plan §4.12, §9.2)
 * -------------------------------------------------------------------------- */

/** §9.2:1247 — the three ops T70's router routes here. */
export const APP_VERIFICATION_DEPLOY_OP = 'verification-deploy' as const;
export const APP_VERIFICATION_STATUS_OP = 'verification-status' as const;
export const APP_VERIFICATION_DESTROY_OP = 'verification-destroy' as const;

/** §9.2:1283 — "`verification-deploy` runs `checkAppCluster` first (10 s)". */
export const APP_VERIFICATION_CLUSTER_CHECK_TIMEOUT_MS = 10_000;

/** §4.12:646 — "expiry annotation `now + ttlMinutes` (1–240)". */
export const APP_VERIFICATION_TTL_MIN_MINUTES = 1;
export const APP_VERIFICATION_TTL_MAX_MINUTES = 240;

/** §4.12:640-646 — `<ns>` is §4.1's namespace (≤ 42 by construction), so the whole name is ≤ 52. */
export const APP_VERIFICATION_ID_LENGTH = 6;
export const APP_VERIFICATION_MAX_ATTEMPT = 9;
export const APP_NAME_MAX_LENGTH = 63;
export const APP_SLUG_MAX_LENGTH = 30;

/** The `lastError`-style ceiling the Deployment row uses; a failure message never exceeds it. */
export const APP_VERIFICATION_MESSAGE_MAX_LENGTH = 500;

/* -------------------------------------------------------------------------- *
 * The derivation §4.12:640-646 owns
 * -------------------------------------------------------------------------- */

/**
 * `<ns>-v<first 6 hex of provisioningId>-<attempt ≤ 9>` (plan §4.12:640-646).
 *
 * The provisioning part is what stops a re-provision's attempt 1 from colliding with a leftover — or
 * a still-`Terminating` — namespace from an earlier run (APW06-G09). Deterministic and pure, so the
 * name `verification-deploy` returns is the name `verification-destroy` takes back.
 *
 * The suffix that carries the identity is never the part that is cut: only the base is truncated, and
 * the result always fits {@link APP_NAME_MAX_LENGTH} (63, the DNS-1123 cap) while staying inside the
 * 52 characters §4.12 promises for a §4.1 namespace.
 */
export function verificationNamespaceName(
    namespace: string,
    provisioningId: string,
    attempt: number,
): string {
    const bounded = Number.isFinite(attempt)
        ? Math.min(APP_VERIFICATION_MAX_ATTEMPT, Math.max(1, Math.floor(attempt)))
        : 1;
    const suffix = `-v${hexSuffix(provisioningId, APP_VERIFICATION_ID_LENGTH)}-${bounded}`;
    const room = Math.max(1, APP_NAME_MAX_LENGTH - suffix.length);
    const base = sanitiseName(namespace, room) || 'ew-app';

    return `${base}${suffix}`;
}

/**
 * The first `length` hex characters of an identifier — the same rule §4.1's short ids use.
 *
 * An identifier with fewer than `length` hex characters (a non-uuid id, an id with letters outside
 * the hex alphabet) falls back to the first `length` hex of its SHA-256 digest: still a pure,
 * deterministic function of the input, so a namespace is never re-derived into a different name and
 * two such ids still differ.
 */
export function hexSuffix(value: string, length: number): string {
    const size = Math.max(1, Math.floor(length));
    const raw = String(value ?? '');
    const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length >= size) {
        return hex.slice(0, size);
    }

    return createHash('sha256').update(raw).digest('hex').slice(0, size);
}

/* -------------------------------------------------------------------------- *
 * Op payloads (plan §9.2:1272-1281, APW06-G09)
 * -------------------------------------------------------------------------- */

/**
 * The verification part of §9.2's typed op union.
 *
 * `packages/agent/src/tasks/app-cluster-op.types.ts` does not exist in this tree yet (APW06-G09,
 * `plan.md:1272-1281`); the three members below are that plan's, verbatim, so the swap when it lands
 * is an import. See the provisional block below.
 */
export interface AppVerificationDeployOp {
    readonly op: typeof APP_VERIFICATION_DEPLOY_OP;
    readonly workId: string;
    readonly provisioningId: string;
    readonly attempt: number;
    /** Null under `build.strategy: image` (§5.8) — then `imageDigest` and `specCommitSha` are the handles. */
    readonly buildId: string | null;
    /** `sha256:<64 hex>`. */
    readonly imageDigest: string;
    readonly specCommitSha: string;
    /** 1–240; APW-04 sends 90. */
    readonly ttlMinutes: number;
}

export interface AppVerificationStatusOp {
    readonly op: typeof APP_VERIFICATION_STATUS_OP;
    readonly workId: string;
    readonly provisioningId: string;
    readonly attempt: number;
    /** The handle `verification-deploy` returned (§4.12:641-642). */
    readonly namespace: string;
}

export interface AppVerificationDestroyOp {
    readonly op: typeof APP_VERIFICATION_DESTROY_OP;
    readonly workId: string;
    /** Null when APW-04's sweep has no provisioning to attribute the leftover to. */
    readonly provisioningId: string | null;
    readonly attempt: number | null;
    /** The handle `verification-deploy` returned. */
    readonly namespace: string;
    readonly reason: 'attempt-ended' | 'cancelled' | 'expired';
}

export type AppVerificationOp =
    | AppVerificationDeployOp
    | AppVerificationStatusOp
    | AppVerificationDestroyOp;

/* -------------------------------------------------------------------------- *
 * Result shapes
 * -------------------------------------------------------------------------- */

/** The states §4.12 (`plan.md:1452`) gives a verification. */
export type AppVerificationState = AppVerificationUpdate['state'];

/**
 * What `verification-deploy` and `verification-status` answer. `namespace` is the epic-owned handle
 * (§4.12:640-646) and `expiresAt` the instant the namespace's own annotation carries.
 *
 * `components`, `jobs` and `smoke` are the **only** observation fields a verification has
 * (§4.12:660): no `cron`, no `ingressAddress` — a verification renders neither.
 */
export interface AppVerificationResult {
    state: AppVerificationState;
    namespace: string;
    expiresAt: string;
    components: AppComponentStatus[];
    jobs: AppJobResult[];
    smoke: AppSmokeResult | null;
}

export interface AppVerificationDestroyResult {
    state: 'destroyed';
    namespace: string;
    /** The plugin's own answer. `false` on a second destroy of the same handle — the op is idempotent. */
    namespaceDeleted: boolean;
}

/** The reasons this service refuses an op. Never a value, a host, a token or a log line. */
export type AppVerificationRefusalCode =
    | 'facade_unavailable'
    | 'target_not_your_cluster'
    | 'namespace_missing'
    | 'spec_unavailable'
    | 'env_source_unavailable'
    | 'env_required_unset'
    | 'dependencies_unavailable'
    | 'deploy_unavailable'
    | 'cluster_unavailable';

/**
 * Thrown when **no namespace can exist yet** — there is nothing to report *about*, so there is no
 * update for the sink to carry.
 *
 * Every refusal that happens after the namespace name is known is reported through the sink instead
 * (§4.12:661-666), because APW-04 renders the attempt from what the sink stores.
 */
export class AppVerificationUnavailableError extends Error {
    constructor(
        readonly code: AppVerificationRefusalCode,
        message?: string,
        readonly reason?: string,
    ) {
        super(message ?? `App verification is not possible right now: ${code}`);
        this.name = 'AppVerificationUnavailableError';
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — the state machine, the expiry and the observation shapes
 * -------------------------------------------------------------------------- */

/**
 * §4.12's outcome → state. A rolled-back verification is `red`: the candidate Build is what failed,
 * whatever the unwinding cost. A cancelled one is `blocked` — nothing was concluded.
 */
export function verificationStateForOutcome(
    outcome: AppDeployResult['outcome'],
): AppVerificationState {
    switch (outcome) {
        case 'succeeded':
        case 'succeeded-with-warnings':
            return 'green';
        case 'cancelled':
            return 'blocked';
        default:
            return 'red';
    }
}

/**
 * The state an observation supports: `green` only when every declared component is fully ready and
 * there is at least one replica to be ready, `unavailable` when the namespace holds nothing, and
 * `running` in between. It never guesses `red` from a status read — a status read cannot tell "the
 * Build is broken" from "the rollout is still going" (§4.12:660).
 */
export function verificationStateForSnapshot(
    snapshot: AppStatusSnapshot | null | undefined,
): AppVerificationState {
    const components = snapshot?.components ?? [];
    if (
        components.length === 0 ||
        components.every((component) => (component?.desired ?? 0) === 0)
    ) {
        return 'unavailable';
    }

    return components.every((component) => (component?.ready ?? 0) >= (component?.desired ?? 0))
        ? 'green'
        : 'running';
}

/**
 * §4.12:646's instant, from the caller's clock — never from a clock inside a renderer (R-5).
 *
 * The value is bounded into §4.12's 1–240 range on the way in, because the renderer is pure and
 * writes exactly what it is given: a typo of `ttlMinutes: 10080` would otherwise leave a namespace
 * alive for a week, and the sweep that destroys leftovers keys off this very annotation.
 */
export function verificationExpiresAt(ttlMinutes: number, nowMs: number): string {
    const ttl = boundedTtlMinutes(ttlMinutes);
    return new Date(nowMs + ttl * 60_000).toISOString();
}

/** §4.12:646's range, applied. */
export function boundedTtlMinutes(value: unknown): number {
    const raw = Number(value);
    const whole = Number.isFinite(raw) ? Math.floor(raw) : NaN;
    if (!Number.isFinite(whole)) {
        return APP_VERIFICATION_TTL_MAX_MINUTES;
    }
    return Math.min(
        APP_VERIFICATION_TTL_MAX_MINUTES,
        Math.max(APP_VERIFICATION_TTL_MIN_MINUTES, whole),
    );
}

/** `{ <component>: <internalUrl> }` — APW-07's ephemeral `internalUrls` (`plan.md:1436`). */
export function internalUrlsOf(spec: AppVerificationSpec): Record<string, string> {
    const namespace = String(spec?.input?.ref?.namespace ?? '');
    const urls: Record<string, string> = {};
    for (const component of spec?.input?.components ?? []) {
        const name = String(component?.name ?? '');
        if (name) {
            urls[name] = String(
                component?.internalUrl ?? `http://${name}.${namespace}.svc.cluster.local`,
            );
        }
    }
    return urls;
}

/**
 * The `AppStatusSpec` an observation asks for, from the same spec the Deployment was rendered from.
 *
 * `cron` is **empty by construction**: §4.12:651 renders no CronJob for a verification, so asking
 * the cluster for one would be asking a question whose answer is fixed.
 */
export function statusSpecForSpec(spec: AppVerificationSpec): AppStatusSpec {
    return {
        components: (spec?.input?.components ?? []).map((component) => ({
            name: String(component?.name ?? ''),
            role: component?.role === 'worker' ? 'worker' : 'web',
            replicas: Number(component?.replicas ?? 0),
            primary: component?.primary === true,
        })),
        jobs: (spec?.input?.jobs ?? []).map((job) => String(job?.name ?? '')),
        cron: [],
    };
}

/** The one-line failure a report carries — scrubbed of whitespace, bounded, never a value. */
function failureOf(
    phase: string,
    code: string,
    message: string,
): NonNullable<AppVerificationUpdate['failure']> {
    return { phase, code, message: messageOf(message) };
}

/** A one-line, bounded message. The plugin has already scrubbed what it threw; this bounds it. */
function messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return String(message || 'unknown error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, APP_VERIFICATION_MESSAGE_MAX_LENGTH);
}

/**
 * Run `work` with a budget. Resolves `'timeout'` when the budget is spent — it never rejects for the
 * budget itself, so a caller reports a named failure instead of an unhandled rejection.
 */
async function withDeadline<T>(work: Promise<T>, millis: number): Promise<T | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), millis);
                // A budget still counting down must never be the reason a process cannot exit: the
                // `await` below is what keeps this call alive, not the timer.
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/** DNS-1123 label charset, capped, with no trailing hyphen — the same shape §4.1's names use. */
function sanitiseName(value: unknown, maxLength: number): string {
    const limit = Math.max(1, Math.floor(maxLength));
    return String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, limit)
        .replace(/-+$/, '');
}

/* -------------------------------------------------------------------------- *
 * Provisional seams — every one of them is another owner's, named as its owner fixes it
 * -------------------------------------------------------------------------- */

// ── provisional — APW-06 T20, the facade that assembles cluster access ───────
//
// `AppRuntimeFacadeService` (`packages/agent/src/facades/app-runtime.facade.ts`) does not exist yet
// (`plan.md:123-137`, `:943-949`). It is the only place a plugin and a credential are assembled
// (R-5) and the only place that may be dialled (`APP_CLUSTER_IO_IN_API`, `plan.md:1261-1266`). This
// is a narrow, verification-shaped reading of it: the five App members a verification calls, already
// bound to the resolved plugin, plus the one read it needs to report an expiry it did not write.
//
// The swap is T20's own method, and the fail-closed answer is a refusal, never a `deployApp` on a
// guessed plugin.

/** Everything a verification needs to reach **your** cluster for one App Work. */
export interface AppVerificationAccess {
    target: 'your-cluster' | 'ever-works-apps';
    /** The **live** namespace ref of §4.1 — the verification namespace is derived from its `namespace`. */
    ref: AppTargetRef;
    /** The Work-scoped credential the plugin is dialled with (§6.1). */
    credential: string;
    checkAppCluster?: (credential: string, req: AppClusterCheckRequest) => Promise<AppClusterCheck>;
    prepareAppNamespace?: (
        ref: AppTargetRef,
        credential: string,
        opts: { isolation: boolean; limitRange: AppRenderInput['policy']['limitRange'] },
    ) => Promise<{ warnings: Array<{ code: string; message: string }> }>;
    deployApp?: (
        input: AppRenderInput,
        credential: string,
        hooks: AppDeployHooks,
    ) => Promise<AppDeployResult>;
    getAppStatus?: (
        ref: AppTargetRef,
        credential: string,
        spec: AppStatusSpec,
    ) => Promise<AppStatusSnapshot>;
    destroyApp?: (
        ref: AppTargetRef,
        credential: string,
        opts: { deleteVolumes: boolean },
    ) => Promise<AppDestroyResult>;
    /**
     * The instant the namespace's `ever-works.io/expires-at` annotation carries (§4.12:646).
     *
     * `verification-status` and `verification-destroy` are handed a namespace name and no TTL, and
     * the annotation is the only authority for the expiry — APW-04's sweep reads it too. `null` means
     * "could not be read", which this service reports as an empty string rather than as a
     * plausible-looking instant it computed itself.
     */
    readNamespaceExpiry?: (namespace: string) => Promise<string | null>;
}

/** APW-06 T20's `AppRuntimeFacadeService`, as this task consumes it. */
export interface AppRuntimeVerificationFacade {
    resolveVerificationTarget(
        workId: string,
    ): Promise<AppVerificationAccess | { unavailable: AppVerificationRefusalCode }>;
}

/** DI token for {@link AppRuntimeVerificationFacade} — bound to APW-06 T20's facade. */
export const APP_RUNTIME_VERIFICATION_FACADE = Symbol('APP_RUNTIME_VERIFICATION_FACADE');

// ── provisional — APW-06 T22, the render input builder ───────────────────────
//
// `packages/agent/src/app-runtime/app-render-input.builder.ts` does not exist yet
// (`tasks.md:392-408`, `plan.md:805-822`). This is the *spec side* of §3.1's `AppRenderInput` for a
// verification namespace: the App spec at the attempt's commit, the components' `internalUrl`s, and
// the dependency kinds §4.12:653-656 hands to APW-07.
//
// 🛑 The `env` block is deliberately **not** part of it. §4.12:650 says a verification's env Secret
// comes from APW-07's **ephemeral** mode with "values in memory only", so this service resolves it
// (`AppRuntimeEnvSource.resolveEphemeral`) and completes the input with {@link withEphemeralEnv}.
// T22's builder keeps owning the non-verification path; the swap here is its own verification method
// returning the same two fields.

/** What a verification's spec is read with (plan §5.6 step 2, §5.8, §9.2:1276-1277). */
export interface AppVerificationSpecRequest {
    workId: string;
    /** The **verification** namespace the input is rendered for — already the §4.12 name. */
    namespace: string;
    provisioningId: string;
    attempt: number;
    /** The Build's commit; the spec is read at it. `null` for a status read, which only needs names. */
    specCommitSha: string | null;
    /** Null under `build.strategy: image` (§5.8). */
    buildId: string | null;
    /** `sha256:<64 hex>`, the digest-pinned image the attempt runs. `null` for a status read. */
    imageDigest: string | null;
    /** 1–240, already bounded by {@link boundedTtlMinutes}. `null` for a status read. */
    ttlMinutes: number | null;
}

/** The spec side of §3.1's input, plus the one fact §4.12 needs from the same read. */
export interface AppVerificationSpec {
    /** §3.1's input, complete except for `env` — which is the ephemeral resolution (R-10). */
    input: Omit<AppRenderInput, 'env'>;
    /** The App spec's declared dependency kinds — exactly what `provisionEphemeral` is asked for. */
    dependencyKinds: readonly string[];
}

/** APW-06 T22's builder, as this task consumes it. */
export interface AppVerificationSpecSource {
    /** `undefined` when the spec cannot be read — never a half-built input. */
    readVerificationSpec(req: AppVerificationSpecRequest): Promise<AppVerificationSpec | undefined>;
}

/** DI token for {@link AppVerificationSpecSource} — owned by APW-06 T22. */
export const APP_VERIFICATION_SPEC_SOURCE = Symbol('APP_VERIFICATION_SPEC_SOURCE');

/**
 * Complete §3.1's input with the ephemeral resolution. Pure.
 *
 * `checksum` is left empty on purpose: the renderer's `effectiveEnvChecksum` then derives §4.7's
 * checksum from the values in hand, so the env Secret, the platform ConfigMap and the pod template's
 * annotation all agree — and it is *derived*, never stored (R-10).
 */
export function withEphemeralEnv(
    spec: AppVerificationSpec,
    env: { values?: Record<string, string>; secretNames?: readonly string[] },
): AppRenderInput {
    return {
        ...spec.input,
        env: {
            values: { ...(env?.values ?? {}) },
            checksum: '',
            secretNames: [...(env?.secretNames ?? [])],
        },
    } as AppRenderInput;
}

// ── provisional — APW-07 T16, ephemeral dependency provisioning ──────────────
//
// `AppDependenciesService` does not exist yet (`APW-07/plan.md:541-562`, §4.9; APW06-G08). The
// token is **not** declared here: `app-runtime-deletion.service.ts` already declares
// `APP_DEPENDENCIES_SERVICE` provisionally for APW-07 T16, and it is imported above. A second
// `Symbol('APP_DEPENDENCIES_SERVICE')` would be a *different* token, and APW-07's single binding
// would then reach only one of the two consumers — exactly the drift that file warns about. This
// file therefore declares the *view* it needs of the same provider and reuses that one token.
//
// 🛑 APW-07's return shape is not fixed by its plan, so it is not read here at all; and the method
// named is `provisionEphemeral` — the `ephemeral: true` mode of APW-07 §4.9, which draws **no PVC**
// and returns its outputs **in memory**, never storing them.

/** APW-07 T16's `AppDependenciesService`, as a verification consumes it (§4.12:653-656). */
export interface AppEphemeralDependencyProvisioner {
    provisionEphemeral(
        workId: string,
        namespace: string,
        kinds: readonly string[],
    ): Promise<unknown>;
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * Verification targets: the `verification-deploy`, `verification-status` and `verification-destroy`
 * op handlers of §9.2 — on the isolated worker, `your-cluster` only (plan §4.12).
 */
@Injectable()
export class AppVerificationTargetService {
    private readonly logger = new Logger(AppVerificationTargetService.name);

    constructor(
        // The two the order depends on come first; every collaborator is `@Optional()`, so a
        // hand-rolled construction (this file's own spec, a lean worker context) passes a prefix of
        // them and the module graph compiles with nothing bound at all.
        @Optional()
        @Inject(APP_RUNTIME_VERIFICATION_FACADE)
        private readonly facade?: AppRuntimeVerificationFacade,
        @Optional()
        @Inject(APP_VERIFICATION_SPEC_SOURCE)
        private readonly specs?: AppVerificationSpecSource,
        @Optional()
        @Inject(APP_RUNTIME_ENV_SOURCE)
        private readonly env?: AppRuntimeEnvSource,
        @Optional()
        @Inject(APP_DEPENDENCIES_SERVICE)
        private readonly dependencies?: AppEphemeralDependencyProvisioner,
        @Optional()
        @Inject(APP_VERIFICATION_SINK)
        private readonly verifications?: AppVerificationSink,
    ) {}

    /**
     * The clock, as a method, so a spec can pin an expiry without touching a global — the same seam
     * `AppRuntimeDeletionService.nowMs` uses.
     */
    protected nowMs(): number {
        return Date.now();
    }

    /* ---------------------------------------------------------------------- *
     * §9.2 — `verification-deploy`
     * ---------------------------------------------------------------------- */

    /**
     * Deploy one verification attempt into its own namespace and report every phase.
     *
     * Returns the **handle**: the namespace name and the expiry instant, which `verification-status`
     * and `verification-destroy` take back (§4.12:641-642).
     */
    async handleVerificationDeploy(op: AppVerificationDeployOp): Promise<AppVerificationResult> {
        const sink = this.requireSink();

        const access = await this.requireAccess(op?.workId);
        this.requireYourCluster(access);

        const workId = String(op?.workId ?? '');
        const provisioningId = String(op?.provisioningId ?? '');
        const attempt = Number(op?.attempt ?? 1);
        const namespace = verificationNamespaceName(
            String(access.ref?.namespace ?? ''),
            provisioningId,
            attempt,
        );

        const ttlMinutes = this.boundedTtl('verification-deploy', op?.ttlMinutes);
        const expiresAt = verificationExpiresAt(ttlMinutes, this.nowMs());

        // ---- 1 · §9.2:1283 — checkAppCluster first, 10 s --------------------
        const check = await this.clusterCheck(access, namespace);
        if (check !== true) {
            return this.refusal(sink, {
                provisioningId,
                attempt,
                namespace,
                expiresAt,
                code: 'cluster_unavailable',
                // The check's own code travels with the failure, so APW-04 can tell a `forbidden`
                // credential from an unreachable API server without parsing a message.
                failureCode: check.code,
                phase: 'cluster-check',
                message: check.message,
            });
        }

        // ---- everything that can be asked, asked before the first write -----
        const spec = await this.readSpec(sink, {
            workId,
            namespace,
            provisioningId,
            attempt,
            expiresAt,
            specCommitSha: op?.specCommitSha ?? null,
            buildId: op?.buildId ?? null,
            imageDigest: op?.imageDigest ?? null,
            ttlMinutes,
        });
        if ('refusal' in spec) {
            return spec.refusal;
        }

        const env = await this.resolveEphemeral(sink, {
            workId,
            spec: spec.spec,
            namespace,
            provisioningId,
            attempt,
            expiresAt,
            buildId: op?.buildId ?? null,
            specCommitSha: op?.specCommitSha ?? null,
        });
        if ('refusal' in env) {
            return env.refusal;
        }

        if (!access.prepareAppNamespace || !access.deployApp) {
            return this.refusal(sink, {
                provisioningId,
                attempt,
                namespace,
                expiresAt,
                code: 'deploy_unavailable',
                message:
                    'The deployment plugin for this Work serves no App Deployment, so no verification can run.',
            });
        }

        const kinds = [...(spec.spec.dependencyKinds ?? [])];
        if (kinds.length > 0 && !this.dependencies) {
            // Fail-closed before any write: a verification whose dependencies are never provisioned
            // would deploy an app that cannot reach them and report `red` for the wrong reason.
            return this.refusal(sink, {
                provisioningId,
                attempt,
                namespace,
                expiresAt,
                code: 'dependencies_unavailable',
                message: `The App declares ${kinds.length} dependenc${
                    kinds.length === 1 ? 'y' : 'ies'
                } and no App dependencies service is bound, so none of them can be provisioned (plan §4.12:653-656).`,
            });
        }

        const input = withEphemeralEnv(spec.spec, env.env);
        const run = this.newRun(access, provisioningId, attempt, namespace, expiresAt);
        // The ref every call of this attempt is made with: the **verification** namespace, never the
        // live one. `access.ref` names the live namespace and is only ever the base of this copy —
        // getting it wrong would prepare the running app's namespace and deploy a throwaway attempt
        // into production.
        const verificationRef: AppTargetRef = { ...access.ref, namespace };

        // ---- 2 · the namespace and its policies, FIRST (APW06-G08) ----------
        await this.reportRunning(run, sink, 'prepare');

        try {
            await access.prepareAppNamespace(verificationRef, access.credential, {
                isolation: input?.network?.isolation !== false,
                limitRange: input?.policy?.limitRange,
            });
        } catch (error) {
            return this.reportInfra(run, sink, 'prepare', error);
        }

        // ---- 3 · dependencies, AFTER the policies, BEFORE the workloads -----
        if (this.dependencies) {
            try {
                await this.dependencies.provisionEphemeral(workId, namespace, kinds);
            } catch (error) {
                return this.reportInfra(run, sink, 'prepare', error);
            }
        }

        // ---- 4 · the workloads ---------------------------------------------
        let result: AppDeployResult;
        try {
            result = await access.deployApp(
                input,
                access.credential,
                this.hooks(run, sink, statusSpecForSpec(spec.spec)),
            );
        } catch (error) {
            return this.reportInfra(run, sink, 'rollout', error);
        }

        run.components = [...(result?.components ?? [])];
        run.jobs = [...(result?.jobs ?? [])];
        run.smoke = result?.smoke ?? null;

        return this.report(sink, {
            provisioningId,
            attempt,
            namespace,
            expiresAt,
            state: verificationStateForOutcome(result?.outcome),
            phase: 'done',
            ...(result?.failure
                ? {
                      failure: failureOf(
                          result.failure.phase,
                          result.failure.code,
                          result.failure.message,
                      ),
                  }
                : {}),
            components: run.components,
            jobs: run.jobs,
            smoke: run.smoke,
        });
    }

    /* ---------------------------------------------------------------------- *
     * §9.2 — `verification-status`
     * ---------------------------------------------------------------------- */

    /**
     * Observe a verification namespace and report what it holds: **components, jobs and smoke only**
     * (§4.12:660). No cron (none is rendered), no ingress address (there is no Ingress).
     */
    async handleVerificationStatus(op: AppVerificationStatusOp): Promise<AppVerificationResult> {
        const sink = this.requireSink();
        const access = await this.requireAccess(op?.workId);
        this.requireYourCluster(access);

        const namespace = this.requireHandle(op?.namespace, 'verification-status');
        const ref: AppTargetRef = { ...access.ref, namespace };
        const expiresAt = await this.readExpiry(access, namespace);

        const statusSpec = await this.readStatusSpec(op?.workId, namespace, op);
        const observation = await this.observe(access, ref, statusSpec);

        return this.report(sink, {
            provisioningId: String(op?.provisioningId ?? ''),
            attempt: Number(op?.attempt ?? 1),
            namespace,
            expiresAt,
            state: verificationStateForSnapshot(observation.snapshot),
            // §9.6's phase union has no member for a pure observation and this file will not widen
            // another owner's contract; `done` is the phase whose meaning is "the run this update
            // describes is over", which is the truthful reading of an observation.
            phase: 'done',
            components: observation.components,
            jobs: observation.jobs,
            smoke: observation.smoke,
        });
    }

    /* ---------------------------------------------------------------------- *
     * §9.2 — `verification-destroy`
     * ---------------------------------------------------------------------- */

    /**
     * Destroy a verification namespace whole, and report it. **Idempotent**: a namespace that is
     * already gone is still `destroyed`, because that is the state the caller asked for
     * (§4.12:659-660, `plan.md:1665`).
     *
     * `deleteVolumes: false` is passed and the plugin ignores it for a verification: §4.12 deletes
     * the whole namespace whatever the flag says, which is the only reading under which a
     * verification's leftovers cannot accumulate.
     */
    async handleVerificationDestroy(
        op: AppVerificationDestroyOp,
    ): Promise<AppVerificationDestroyResult> {
        const sink = this.requireSink();
        const access = await this.requireAccess(op?.workId);
        this.requireYourCluster(access);

        const namespace = this.requireHandle(op?.namespace, 'verification-destroy');
        if (!access.destroyApp) {
            throw new AppVerificationUnavailableError(
                'deploy_unavailable',
                'The deployment plugin for this Work serves no destroyApp.',
                namespace,
            );
        }

        const ref: AppTargetRef = { ...access.ref, namespace };
        const expiresAt = await this.readExpiry(access, namespace);

        let destroyed: AppDestroyResult;
        try {
            destroyed = await access.destroyApp(ref, access.credential, { deleteVolumes: false });
        } catch (error) {
            // A namespace that will not go is infrastructure, and APW-04's sweep retries the op.
            this.logger.warn(
                `verification-destroy failed for ${namespace} (${String(op?.reason ?? '')}): ${messageOf(error)}`,
            );
            throw new AppVerificationUnavailableError(
                'cluster_unavailable',
                messageOf(error),
                namespace,
            );
        }

        await sink.report({
            provisioningId: String(op?.provisioningId ?? ''),
            attempt: Number(op?.attempt ?? 1),
            namespace,
            expiresAt,
            state: 'destroyed',
            phase: 'destroy',
            components: [],
            jobs: [],
            smoke: null,
        });

        return {
            state: 'destroyed',
            namespace,
            namespaceDeleted: destroyed?.namespaceDeleted === true,
        };
    }

    /* ---------------------------------------------------------------------- *
     * Guards
     * ---------------------------------------------------------------------- */

    /**
     * §4.12:664-666 — "the default binding throws `verification_sink_unavailable` **before any
     * namespace is created**, so a verification can never run with nowhere to report."
     *
     * Both halves matter: an **unbound** sink is refused here, and a sink bound to
     * `UnavailableVerificationSink` throws on this service's first `report` — which always happens
     * before `prepareAppNamespace`, so the plan's sentence holds either way.
     */
    private requireSink(): AppVerificationSink {
        if (!this.verifications) {
            throw new AppPortUnavailableError(
                'verification_sink_unavailable',
                'No App verification sink is bound, so no verification can report a result.',
            );
        }
        return this.verifications;
    }

    /** With no cluster access there is not even a namespace to report against — so this throws. */
    private async requireAccess(workId: unknown): Promise<AppVerificationAccess> {
        if (!this.facade) {
            throw new AppVerificationUnavailableError(
                'facade_unavailable',
                'No App runtime facade is bound, so no verification can reach a cluster.',
                String(workId ?? ''),
            );
        }

        const resolved = await this.facade.resolveVerificationTarget(String(workId ?? ''));
        if (!resolved || 'unavailable' in resolved) {
            throw new AppVerificationUnavailableError(
                (resolved as { unavailable?: AppVerificationRefusalCode })?.unavailable ??
                    'facade_unavailable',
                'The App Work has no cluster this verification could run against.',
                String(workId ?? ''),
            );
        }
        return resolved;
    }

    /** §4.12:638 — "on the isolated worker, `your-cluster` only". */
    private requireYourCluster(access: AppVerificationAccess): void {
        if (access?.target !== 'your-cluster') {
            throw new AppVerificationUnavailableError(
                'target_not_your_cluster',
                `A verification runs on your own cluster only; this Work's target is '${String(
                    access?.target ?? 'none',
                )}'.`,
            );
        }
    }

    /** The handle `verification-deploy` returned (§4.12:641-642). Never derived here. */
    private requireHandle(namespace: unknown, op: string): string {
        const name = String(namespace ?? '');
        if (!name) {
            throw new AppVerificationUnavailableError(
                'namespace_missing',
                `${op} needs the namespace handle verification-deploy returned.`,
            );
        }
        return name;
    }

    /* ---------------------------------------------------------------------- *
     * §9.2:1283 — the cluster check
     * ---------------------------------------------------------------------- */

    /**
     * `checkAppCluster` with §9.2's 10 s budget. `true`, or the refusal to report.
     *
     * A cluster check that cannot be made at all answers exactly as a failed one does, because from
     * APW-04's side both mean "fall back to the runner lane".
     */
    private async clusterCheck(
        access: AppVerificationAccess,
        namespace: string,
    ): Promise<true | { code: string; message: string }> {
        if (!access.checkAppCluster) {
            return {
                code: 'cluster_unavailable',
                message: 'The deployment plugin for this Work serves no checkAppCluster.',
            };
        }

        let check: AppClusterCheck | 'timeout';
        try {
            check = await withDeadline(
                access.checkAppCluster(access.credential, {
                    namespace,
                    needsCreateNamespace: true,
                }),
                APP_VERIFICATION_CLUSTER_CHECK_TIMEOUT_MS,
            );
        } catch (error) {
            return { code: 'cluster_unreachable', message: messageOf(error) };
        }

        if (check === 'timeout') {
            return {
                code: 'cluster_unreachable',
                message: `The cluster check did not answer within §9.2's ${
                    APP_VERIFICATION_CLUSTER_CHECK_TIMEOUT_MS / 1_000
                } s budget.`,
            };
        }

        if (check?.ok !== true) {
            return {
                code: check?.error?.code ?? 'cluster_unreachable',
                message:
                    check?.error?.message ??
                    'The cluster check reported that this credential cannot deploy an App.',
            };
        }

        return true;
    }

    /* ---------------------------------------------------------------------- *
     * The ephemeral env (R-10, §4.12:650)
     * ---------------------------------------------------------------------- */

    /**
     * APW-07's **ephemeral** resolution: `target: 'cluster'`, values in memory only.
     *
     * `resolve()` — the stored path — is deliberately **never** called (ACC-06-48): a verification
     * that read or wrote stored generated values would let a throwaway attempt change what the live
     * App Work deploys next.
     *
     * `primaryUrl` / `primaryHost` are `null` and stay `null`: a verification publishes no host
     * (§4.12:651), so `ew-dep://` placeholders resolve against the in-namespace URLs alone.
     */
    private async resolveEphemeral(
        sink: AppVerificationSink,
        input: {
            workId: string;
            spec: AppVerificationSpec;
            namespace: string;
            provisioningId: string;
            attempt: number;
            expiresAt: string;
            buildId: string | null;
            specCommitSha: string | null;
        },
    ): Promise<
        | { env: { values?: Record<string, string>; secretNames: readonly string[] } }
        | { refusal: AppVerificationResult }
    > {
        if (!this.env) {
            return {
                refusal: await this.refusal(sink, {
                    provisioningId: input.provisioningId,
                    attempt: input.attempt,
                    namespace: input.namespace,
                    expiresAt: input.expiresAt,
                    code: 'env_source_unavailable',
                    message:
                        'No App runtime env source is bound, so the verification would run with guessed values.',
                }),
            };
        }

        const specCommitSha = String(input.specCommitSha ?? '');
        let resolved: Awaited<ReturnType<AppRuntimeEnvSource['resolveEphemeral']>>;
        try {
            resolved = await this.env.resolveEphemeral(input.workId, specCommitSha, {
                target: 'cluster',
                primaryUrl: null,
                primaryHost: null,
                // §5.8: under `build.strategy: image` there is no Build commit — `buildId` is null.
                buildCommitSha: input.buildId ? specCommitSha : null,
                internalUrls: internalUrlsOf(input.spec),
            });
        } catch (error) {
            return {
                refusal: await this.refusal(sink, {
                    provisioningId: input.provisioningId,
                    attempt: input.attempt,
                    namespace: input.namespace,
                    expiresAt: input.expiresAt,
                    code: 'env_source_unavailable',
                    message: messageOf(error),
                }),
            };
        }

        const unset = [...(resolved?.unsetRequired ?? [])];
        if (unset.length > 0) {
            // Nothing is created: this is what resolving before the first write buys. `blocked` is
            // §4.12's state for "waiting on something the member must supply", not `red`.
            return {
                refusal: await this.refusal(sink, {
                    provisioningId: input.provisioningId,
                    attempt: input.attempt,
                    namespace: input.namespace,
                    expiresAt: input.expiresAt,
                    code: 'env_required_unset',
                    state: 'blocked',
                    message: `${unset.length} required environment value(s) are unset, so this verification attempt cannot run.`,
                }),
            };
        }

        return { env: { values: resolved?.values, secretNames: resolved?.secretNames ?? [] } };
    }

    /* ---------------------------------------------------------------------- *
     * The spec (APW-06 T22)
     * ---------------------------------------------------------------------- */

    private async readSpec(
        sink: AppVerificationSink,
        req: AppVerificationSpecRequest & { expiresAt: string },
    ): Promise<{ spec: AppVerificationSpec } | { refusal: AppVerificationResult }> {
        if (!this.specs) {
            return {
                refusal: await this.refusal(sink, {
                    provisioningId: req.provisioningId,
                    attempt: req.attempt,
                    namespace: req.namespace,
                    expiresAt: req.expiresAt,
                    code: 'spec_unavailable',
                    message:
                        'No App verification spec source is bound, so there is nothing to render.',
                }),
            };
        }

        const spec = await this.specs.readVerificationSpec(req);
        if (!spec?.input) {
            return {
                refusal: await this.refusal(sink, {
                    provisioningId: req.provisioningId,
                    attempt: req.attempt,
                    namespace: req.namespace,
                    expiresAt: req.expiresAt,
                    code: 'spec_unavailable',
                    message: `The App spec at ${String(req.specCommitSha ?? 'HEAD')} could not be read.`,
                }),
            };
        }

        return { spec };
    }

    /** The observation's `AppStatusSpec`, from the same read — `undefined` when it cannot be read. */
    private async readStatusSpec(
        workId: unknown,
        namespace: string,
        op: { provisioningId?: string; attempt?: number; specCommitSha?: string | null },
    ): Promise<AppStatusSpec | undefined> {
        if (!this.specs) {
            return undefined;
        }
        try {
            const spec = await this.specs.readVerificationSpec({
                workId: String(workId ?? ''),
                namespace,
                provisioningId: String(op?.provisioningId ?? ''),
                attempt: Number(op?.attempt ?? 1),
                specCommitSha: op?.specCommitSha ?? null,
                buildId: null,
                imageDigest: null,
                ttlMinutes: null,
            });
            return spec?.input ? statusSpecForSpec(spec) : undefined;
        } catch (error) {
            this.logger.warn(
                `The App spec for ${namespace} could not be read: ${messageOf(error)}`,
            );
            return undefined;
        }
    }

    /* ---------------------------------------------------------------------- *
     * Observation (§4.12:660)
     * ---------------------------------------------------------------------- */

    /** The empty observation a run starts from — never `null` fields, always the three of §4.12. */
    private newRun(
        access: AppVerificationAccess,
        provisioningId: string,
        attempt: number,
        namespace: string,
        expiresAt: string,
    ): VerificationRun {
        return {
            access,
            provisioningId,
            attempt,
            namespace,
            expiresAt,
            components: [],
            jobs: [],
            smoke: null,
        };
    }

    /**
     * One read of the namespace, reduced to what a verification reports: components, jobs and smoke.
     *
     * An observation that cannot be made is **empty**, never invented, and never fatal: a status read
     * is not a reason for a verification to fail.
     */
    private async observe(
        access: AppVerificationAccess,
        ref: AppTargetRef,
        statusSpec: AppStatusSpec | undefined,
    ): Promise<{
        snapshot: AppStatusSnapshot | null;
        components: AppComponentStatus[];
        jobs: AppJobResult[];
        smoke: AppSmokeResult | null;
    }> {
        if (!access.getAppStatus || !statusSpec) {
            return { snapshot: null, components: [], jobs: [], smoke: null };
        }

        let snapshot: AppStatusSnapshot | null = null;
        try {
            snapshot = await access.getAppStatus(ref, access.credential, statusSpec);
        } catch (error) {
            this.logger.warn(
                `verification observation failed for ${ref.namespace}: ${messageOf(error)}`,
            );
            snapshot = null;
        }

        return {
            snapshot,
            components: [...(snapshot?.components ?? [])],
            jobs: [...(snapshot?.jobs ?? [])]
                .map((entry) => entry?.last)
                .filter(Boolean) as AppJobResult[],
            smoke: snapshot?.smoke ?? null,
        };
    }

    /**
     * The expiry the namespace's own annotation carries (§4.12:646). An unreadable one is the empty
     * string: APW-04 already holds `verificationExpiresAt` from the deploy that created the namespace
     * and never overwrites it from a later read.
     */
    private async readExpiry(access: AppVerificationAccess, namespace: string): Promise<string> {
        if (!access.readNamespaceExpiry) {
            return '';
        }
        try {
            return String((await access.readNamespaceExpiry(namespace)) ?? '');
        } catch (error) {
            this.logger.warn(
                `The expiry annotation of ${namespace} could not be read: ${messageOf(error)}`,
            );
            return '';
        }
    }

    /* ---------------------------------------------------------------------- *
     * Hooks and reporting (§4.12:661-666, APW06-G09)
     * ---------------------------------------------------------------------- */

    /**
     * The hooks `deployApp` reports through. Every `onPhase` becomes one `AppVerificationSink.report`
     * (§4.12:661-662) carrying components, jobs and smoke **only**.
     *
     * `verifyPublic` answers an empty **failing** run: §4.12:657 skips the public half entirely, so
     * the hook is never called — and if a future renderer ever called it, `passed: true` over zero
     * checks would be the one answer that could turn a verification green without evidence.
     *
     * `isCancelled` answers `false`: a verification has no cancel channel of its own — APW-04 ends an
     * attempt by dispatching `verification-destroy`, which is a separate op.
     */
    private hooks(
        run: VerificationRun,
        sink: AppVerificationSink,
        statusSpec: AppStatusSpec,
    ): AppDeployHooks {
        return {
            onPhase: async (phase: AppDeployPhase) => {
                const observation = await this.observe(
                    run.access,
                    { ...run.access.ref, namespace: run.namespace },
                    statusSpec,
                );
                run.components = observation.components;
                run.jobs = observation.jobs;
                run.smoke = observation.smoke;

                await sink.report({
                    provisioningId: run.provisioningId,
                    attempt: run.attempt,
                    namespace: run.namespace,
                    expiresAt: run.expiresAt,
                    state: 'running',
                    phase,
                    components: run.components,
                    jobs: run.jobs,
                    smoke: run.smoke,
                });
            },
            verifyPublic: async () => {
                this.logger.warn(
                    `A verification of ${run.namespace} was asked for a public smoke run, which §4.12:657 does not allow.`,
                );
                return { checks: [], passed: false };
            },
            isCancelled: async () => false,
        };
    }

    /** One report, and the same update returned to the caller of the op. */
    private async report(
        sink: AppVerificationSink,
        update: AppVerificationUpdate,
    ): Promise<AppVerificationResult> {
        await sink.report(update);
        return {
            state: update.state,
            namespace: update.namespace,
            expiresAt: update.expiresAt,
            components: [...(update.components ?? [])],
            jobs: [...(update.jobs ?? [])],
            smoke: update.smoke ?? null,
        };
    }

    /** A `running` report for a phase, outside `deployApp`'s own hook stream. */
    private async reportRunning(
        run: VerificationRun,
        sink: AppVerificationSink,
        phase: AppDeployPhase,
    ): Promise<AppVerificationResult> {
        return this.report(sink, {
            provisioningId: run.provisioningId,
            attempt: run.attempt,
            namespace: run.namespace,
            expiresAt: run.expiresAt,
            state: 'running',
            phase,
            components: run.components,
            jobs: run.jobs,
            smoke: run.smoke,
        });
    }

    /**
     * A refusal the namespace name already exists for: reported through the sink, and returned.
     * `state` defaults to `unavailable`; `blocked` is the only other one used here.
     */
    private async refusal(
        sink: AppVerificationSink,
        input: {
            provisioningId: string;
            attempt: number;
            namespace: string;
            expiresAt: string;
            code: AppVerificationRefusalCode;
            message: string;
            /** The failure's own code when it is more specific than {@link code} — a check's answer. */
            failureCode?: string;
            state?: AppVerificationState;
            phase?: AppVerificationUpdate['phase'];
        },
    ): Promise<AppVerificationResult> {
        const phase = input.phase ?? 'prepare';
        this.logger.warn(
            `verification ${input.namespace} refused (${input.code}): ${input.message}`,
        );
        return this.report(sink, {
            provisioningId: input.provisioningId,
            attempt: input.attempt,
            namespace: input.namespace,
            expiresAt: input.expiresAt,
            state: input.state ?? 'unavailable',
            phase,
            failure: failureOf(phase, input.failureCode ?? input.code, input.message),
            components: [],
            jobs: [],
            smoke: null,
        });
    }

    /** An exception the cluster threw: §4.12's `infra`, never `red` — the Build is not what failed. */
    private async reportInfra(
        run: VerificationRun,
        sink: AppVerificationSink,
        phase: AppDeployPhase,
        error: unknown,
    ): Promise<AppVerificationResult> {
        const message = messageOf(error);
        this.logger.warn(`verification ${run.namespace} failed in ${phase}: ${message}`);
        return this.report(sink, {
            provisioningId: run.provisioningId,
            attempt: run.attempt,
            namespace: run.namespace,
            expiresAt: run.expiresAt,
            state: 'infra',
            phase,
            failure: failureOf(phase, 'cluster_unreachable', message),
            components: run.components,
            jobs: run.jobs,
            smoke: run.smoke,
        });
    }

    /* ---------------------------------------------------------------------- *
     * Small private helpers
     * ---------------------------------------------------------------------- */

    /** §4.12:646's 1–240, bounded on the way in so the annotation can never outlive a typo. */
    private boundedTtl(op: string, value: unknown): number {
        const bounded = boundedTtlMinutes(value);
        const raw = Number(value);
        if (!Number.isFinite(raw) || Math.floor(raw) !== bounded) {
            this.logger.warn(
                `${op} asked for ttlMinutes=${String(value)}; bounded to ${bounded} (plan §4.12:646 allows 1–240).`,
            );
        }
        return bounded;
    }
}

/** The mutable per-run observation — components, jobs and smoke, and nothing else (§4.12:660). */
interface VerificationRun {
    access: AppVerificationAccess;
    provisioningId: string;
    attempt: number;
    namespace: string;
    expiresAt: string;
    components: AppComponentStatus[];
    jobs: AppJobResult[];
    smoke: AppSmokeResult | null;
}
