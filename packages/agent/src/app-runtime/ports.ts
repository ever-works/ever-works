/**
 * App runtime ports — APW-06 `plan.md` §9.6 (_normative_).
 *
 * APW-06 owns these three small interfaces plus the two runtime ports; APW-05, APW-07 and APW-10
 * implement them, and the platform binds a fail-closed default (`./default-ports`) until an
 * implementation is bound, so nothing silently deploys half-configured (`plan.md` §2.1:141–144).
 *
 * Two rules shape this file and must survive every later edit:
 *
 * 1. **R-5 (`CONTRACTS.md` §0:48).** `AppsTierPolicy.isOpen()` is the *only* way App Works code
 *    learns whether the managed tier is open. The environment variable behind the tier's ceiling is
 *    read by APW-10's implementation alone and is deliberately **not** named anywhere in this
 *    folder — `__tests__/default-ports.spec.ts` reads this directory at test time and fails if any
 *    file under it so much as mentions that name.
 * 2. **R-26 (`CONTRACTS.md` §0:69).** Additive only: a closed union gains members, a method gains an
 *    optional argument, and an existing name keeps working. Nothing here is ever narrowed.
 *
 * The runtime-side shapes are **imported, never redeclared** — R-1 (`CONTRACTS.md` §0:44). They come
 * from the two places the program already put them:
 *
 * - `AppDeployTarget` and `AppDeployPhase` from `@ever-works/contracts`, which is R-1's shared folder
 *   (`packages/contracts/src/apps/app-runtime.ts:53,94` — APW-06 T1). `AppDeployPhase` is the same
 *   eleven phases as `plan.md` §3:188–199. `AppDeployTarget` there is the **three**-value deploy
 *   target (`none` · `your-cluster` · `ever-works-apps`, R-12) — a superset of the two-value runtime
 *   target `plan.md` §3:187 declares for the plugin, so every caller that passes a plugin
 *   `AppTargetRef['target']` still typechecks. T2 landed the plugin's own union as the same three
 *   values (`packages/plugin/src/contracts/capabilities/app-deployment.types.ts:51`, reconciling §3
 *   with R-12/R-27), so the two spellings agree on every value — see the note below.
 * - `AppTargetRef`, `AppQuotaInput`, `AppLimitRangeInput`, `AppComponentStatus`, `AppJobResult` and
 *   `AppSmokeResult` from `@ever-works/plugin` — APW-06's plugin contract additions (`plan.md`
 *   §3:182–207 and the normative §3.1:322–376), owned by T2 and re-exported from the capabilities
 *   barrel. They are the shapes `IDeploymentPlugin`'s App members are written against, so a second
 *   declaration anywhere else would be exactly the drift R-1 exists to prevent.
 *
 * **The one name in two packages (reported, R-26).** `AppDeployTarget` is declared twice in the
 * program: `plan.md` §3:187 gives the plugin's a two-value runtime union while
 * `packages/contracts/src/apps/app-runtime.ts:53` derives the shared one from the three-value
 * `APP_DEPLOY_TARGETS` of R-12. Both landed as the three-value superset, so nothing is narrowed and
 * no caller is torn — but a reader should know the two declarations exist and must not drift apart.
 */

import type { AppDeployPhase, AppDeployTarget } from '@ever-works/contracts';
import type {
    AppComponentStatus,
    AppJobResult,
    AppLimitRangeInput,
    AppQuotaInput,
    AppSmokeResult,
    AppTargetRef,
} from '@ever-works/plugin';

/* -------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------- */

/**
 * The machine-readable codes the fail-closed defaults refuse with (`plan.md` §5.1:690, §4.12:659,
 * APW-05 `plan.md`:1136).
 *
 * The union is deliberately **open** (`string & {}` keeps autocomplete over the known codes while
 * still accepting a code this file has not heard of yet): a later epic may add one without editing
 * this list, which is what the additive rule requires. The three codes named by the spec today are
 * `pull_credential_unavailable`, `env_source_unavailable` and `verification_sink_unavailable`.
 */
export type AppPortUnavailableCode =
    | 'pull_credential_unavailable'
    | 'env_source_unavailable'
    | 'verification_sink_unavailable'
    | 'cluster_credential_unavailable'
    | 'tier_pod_policy_unavailable'
    | 'tier_ingress_unavailable'
    // Keeps the union open for codes this port file does not define (additive, R-26).
    | (string & {});

/**
 * Thrown by an unbound or disabled App runtime port so a caller can report a named precondition
 * (`plan.md` §2.1:141–144, §5.1:690) instead of crashing on an unconfigured deployment.
 *
 * Shape follows the package's existing typed errors — `DeploymentContextResolutionError`
 * (`packages/agent/src/facades/deployment-context.resolver.ts:22`) and `GitFacadeError`
 * (`packages/agent/src/facades/git.facade.ts:99`): a real `Error` subclass that carries the typed
 * `code` as a readonly property and sets its own `name`.
 */
export class AppPortUnavailableError extends Error {
    constructor(
        readonly code: AppPortUnavailableCode,
        message?: string,
        readonly reason?: string,
    ) {
        super(message ?? `App runtime port unavailable: ${code}`);
        this.name = 'AppPortUnavailableError';
    }
}

/* -------------------------------------------------------------------------- *
 * AppsTierPolicy — semantics owned and bound by APW-10 (`plan.md` §9.6:1356–1368)
 * -------------------------------------------------------------------------- */

/**
 * Whether the Ever Works Apps (managed) tier is open, and everything the renderer needs about it.
 *
 * The default is **closed** (`./default-ports` → `DisabledAppsTierPolicy`). Implemented by APW-10;
 * APW-03, APW-05, APW-06 and APW-07 ask this port and never read the ceiling environment variable
 * directly (R-5). The older name `isManagedEnabled` survives only as an alias of `isOpen()` on
 * APW-10's implementation — no consumer calls it (`plan.md` §9.6:1358, APW-10 `plan.md` §5.5:713).
 */
export interface AppsTierPolicy {
    isOpen(): boolean;
    managedScope(): 'verified-blueprints' | 'any';
    /** Control-namespace-only credential, handed only to the `apps-tier` deployment plugin — never to `k8s`. */
    resolveClusterCredential(workId: string): Promise<string>;
    /** runtimeClassName null ⇒ precondition `managed_sandbox_unavailable` from Wave 2 (R-24). */
    podPolicy(): {
        runtimeClassName: string | null;
        quota: AppQuotaInput;
        limitRange: AppLimitRangeInput;
    };
    ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' };
    /** Added (requested by APW-10 `plan.md` §5.5): owner eligibility for the tier; reasons are APW-10's codes. */
    eligibility(userId: string): Promise<{ eligible: boolean; reasons: string[] }>;
}

/** DI token for {@link AppsTierPolicy} — a single definition, bound once (`plan.md` §9.8:1519–1521). */
export const APPS_TIER_POLICY = Symbol('APPS_TIER_POLICY');

/* -------------------------------------------------------------------------- *
 * AppImagePullCredentialSource — implemented by APW-05 (`plan.md` §9.6:1370–1373)
 * -------------------------------------------------------------------------- */

/** The read-only registry credential an App Work's image is pulled with. Implemented by APW-05. */
export interface AppImagePullCredentialSource {
    resolve(
        workId: string,
        buildId: string,
    ): Promise<{ server: string; username: string; password: string } | null>;
}

/** DI token for {@link AppImagePullCredentialSource}. */
export const APP_IMAGE_PULL_CREDENTIAL_SOURCE = Symbol('APP_IMAGE_PULL_CREDENTIAL_SOURCE');

/* -------------------------------------------------------------------------- *
 * AppRuntimeEnvSource — implemented by APW-07 (`plan.md` §9.6:1374–1420)
 * -------------------------------------------------------------------------- */

/** The target a stored deployment resolves env values for (APW06-G08: the target, not the stored row). */
export interface AppRuntimeEnvContext {
    /** Added (APW06-G08): APW-07 decides `ew-dep://` placeholders from the target, not the stored row. */
    target: AppDeployTarget;
    primaryUrl: string | null;
    primaryHost: string | null;
    /** Null under `build.strategy: image` (§5.8) — there is no Build commit. */
    buildCommitSha: string | null;
    /** `components.<name>.internalUrl` references (CONTRACTS §1). */
    internalUrls: Record<string, string>;
    preview?: { prNumber: number };
}

/**
 * Ephemeral mode context (R-10, CONTRACTS §3): nothing is read from or written to stored generated
 * values; prompted values are used only when already set. `target: 'cluster'` ⇒ in-memory `values`
 * for a verification namespace (§4.12); `target: 'runner'` ⇒ a value-free `recipe` for APW-05's
 * runner verification.
 */
export interface AppRuntimeEnvEphemeralContext {
    target: 'cluster' | 'runner';
    primaryUrl: string | null;
    primaryHost: string | null;
    /** Null under `build.strategy: image` (§5.8). */
    buildCommitSha: string | null;
    internalUrls: Record<string, string>;
    /**
     * The dependency outputs APW-06 passes after
     * `AppDependenciesService.provisionEphemeral(workId, …)` — APW-07 plan
     * §4.6.1:446 ("read from **`ctx.dependencyOutputs`**").
     *
     * Optional and additive: without it a derived reference in the `cluster`
     * target has no output to resolve against, which is why APW07-G04 added the
     * field rather than letting the resolver re-read rows it is forbidden to
     * write (R-10). A caller that has no ephemeral dependencies simply omits it.
     */
    dependencyOutputs?: Record<string, Record<string, string>>;
}

/** One entry of the value-free recipe an ephemeral `runner` resolution returns. */
export interface AppRuntimeEnvRecipeEntry {
    name: string;
    secret: boolean;
    /**
     * `derived` is part of `AppEnvRecipeEntry` in
     * `packages/contracts/src/apps/app-env.ts` (§4.6.1:447) and was missing
     * here, so a derived entry had to be smuggled through as a one-token
     * template. Additive: every existing producer still type-checks.
     */
    source: 'generate' | 'literal' | 'template' | 'prompted' | 'derived';
    spec: unknown;
}

/** Resolves the sealed env of an App Work. Implemented by APW-07. */
export interface AppRuntimeEnvSource {
    resolve(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEnvContext,
    ): Promise<{
        values: Record<string, string>;
        /**
         * The per-name change fingerprints of APW-07 plan §2.2, with the same
         * keys as `values` (§4.6.1:429).
         *
         * Optional here so that an APW-06-side fake or an earlier implementation
         * keeps compiling — but APW-07's implementation always fills it, and
         * `app-env-runtime.source.spec.ts` asserts a key for every value.
         */
        fingerprints?: Record<string, string>;
        secretNames: string[];
        unsetRequired: string[];
        notReadyDependencies: string[];
        egress: Array<{ host: string; ports: number[] }>;
        /**
         * The `AppDependenciesService.ensureReadyForDeploy(workId)` answer this resolution
         * already obtained — APW-07's one call per `resolve` (GAP-05) — or `null` when it has
         * none (its readiness seam unbound or throwing).
         *
         * Optional and additive, like `fingerprints`. §5.1 step 9 reuses it instead of asking
         * again: each call runs `reconcile`, which re-dispatches every `pending` kind, so a
         * preflight that asked in step 8 (inside this `resolve`) AND in step 9 dispatched every
         * pending provision twice.
         */
        dependencyReadiness?: AppRuntimeEnvDependencyReadiness | null;
    }>;
    /** Ephemeral mode (R-10, CONTRACTS §3) — see {@link AppRuntimeEnvEphemeralContext}. */
    resolveEphemeral(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEnvEphemeralContext,
    ): Promise<{
        values?: Record<string, string>;
        recipe?: AppRuntimeEnvRecipeEntry[];
        secretNames: string[];
        unsetRequired: string[];
    }>;
}

/** DI token for {@link AppRuntimeEnvSource}. */
export const APP_RUNTIME_ENV_SOURCE = Symbol('APP_RUNTIME_ENV_SOURCE');

/* -------------------------------------------------------------------------- *
 * Runtime target, event sink and verification sink (`plan.md` §9.6:1425–1461)
 * -------------------------------------------------------------------------- */

/** Why a dependency target could not be prepared — the closed set of `plan.md` §9.6:1434 / §9.9:1559–1562. */
export type AppRuntimeTargetUnavailable =
    | 'target_none'
    | 'target_not_checked'
    | 'namespace_owned_elsewhere'
    | 'cluster_unreachable';

/**
 * Runtime target resolver (added, GAP-06 / APW06-G08). Worker-only, and the **only** place cluster
 * access is assembled. APW-07 consumes it; APW-06 implements it (§9.9).
 *
 * `prepareDependencyTarget` **resolves** an `unavailable` discriminant rather than throwing, so a
 * caller reports a precondition: it is what breaks the namespace↔dependency cycle, because APW-07's
 * provider is handed a namespace whose baseline policies already exist (§4.2:416–433, §9.9:1556–1562).
 */
export interface AppRuntimeTargetPort {
    prepareDependencyTarget(
        workId: string,
    ): Promise<
        | { ref: AppTargetRef; podLabels: Record<string, string> }
        | { unavailable: AppRuntimeTargetUnavailable }
    >;
}

/** DI token for {@link AppRuntimeTargetPort}. */
export const APP_RUNTIME_TARGET = Symbol('APP_RUNTIME_TARGET');

/**
 * Event sink (added, APW06-G02). Bound to EventEmitter2 in the API and to the relay proxy in the
 * worker. The event names are the `app.` Activity names of CONTRACTS §6.
 */
export interface AppRuntimeEventSink {
    emit(event: { name: string; payload: Record<string, unknown> }): Promise<void>;
}

/** DI token for {@link AppRuntimeEventSink}. */
export const APP_RUNTIME_EVENT_SINK = Symbol('APP_RUNTIME_EVENT_SINK');

/** Verification result channel (added, APW06-G09). Implemented by APW-04; see §4.12. */
export interface AppVerificationUpdate {
    provisioningId: string;
    attempt: number;
    namespace: string;
    expiresAt: string;
    state: 'unavailable' | 'running' | 'green' | 'red' | 'infra' | 'blocked' | 'destroyed';
    phase: AppDeployPhase | 'cluster-check' | 'destroy';
    failure?: { phase: string; code: string; message: string };
    components: AppComponentStatus[];
    jobs: AppJobResult[];
    smoke: AppSmokeResult | null;
    pendingOnCapacitySince?: string;
}

/**
 * Where a verification reports, since a verification has no `WorkDeployment` row (§4.12:656–661).
 * Implemented by APW-04's `AppProvisioningService`.
 */
export interface AppVerificationSink {
    report(update: AppVerificationUpdate): Promise<void>;
}

/** DI token for {@link AppVerificationSink}. */
export const APP_VERIFICATION_SINK = Symbol('APP_VERIFICATION_SINK');

/**
 * `AppDependenciesService.ensureReadyForDeploy`'s answer as an env resolution hands it on
 * ({@link AppRuntimeEnvSource.resolve}'s `dependencyReadiness`). `reason` is set only when the
 * question could not be answered (`specUnavailable`). Declared last in this file so that no
 * `ports.ts:<line>` citation elsewhere moves.
 */
export interface AppRuntimeEnvDependencyReadiness {
    ready: boolean;
    notReady: ReadonlyArray<{ kind: string; status?: string | null; reason?: string | null }>;
    optional?: readonly string[] | null;
    reason?: string | null;
}
