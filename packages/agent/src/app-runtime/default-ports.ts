/**
 * The fail-closed defaults for every App runtime port (`plan.md` §9.8:1524 — "the
 * disabled/unavailable implementations (§9.6) are the initial bindings").
 *
 * These are what the platform binds until APW-05, APW-07 and APW-10 replace the binding with their
 * own implementation. Every one of them refuses rather than pretending: an unbound port must never
 * let an App Work deploy half-configured (`plan.md` §2.1:141–144).
 *
 * **The one deliberate asymmetry.** `UnavailableRuntimeTarget.prepareDependencyTarget` **resolves**
 * `{ unavailable: 'target_none' }` instead of throwing, because the port's own contract returns an
 * `unavailable` discriminant so a caller can report a named precondition (`plan.md` §9.6:1429–1436,
 * §9.9:1559–1562). Every other member of this file throws {@link AppPortUnavailableError}.
 *
 * Nothing in this folder reads the managed tier's ceiling environment variable: whether the tier is
 * open is asked of {@link AppsTierPolicy} and nowhere else (R-5, `CONTRACTS.md` §0:48). The folder
 * carries a test that reads its own files and fails if that name ever appears under it.
 */

import type { AppLimitRangeInput, AppQuotaInput, AppTargetRef } from '@ever-works/plugin';
import {
    AppPortUnavailableError,
    type AppImagePullCredentialSource,
    type AppsTierPolicy,
    type AppRuntimeEnvContext,
    type AppRuntimeEnvEphemeralContext,
    type AppRuntimeEnvSource,
    type AppRuntimeTargetPort,
    type AppRuntimeTargetUnavailable,
    type AppVerificationSink,
    type AppVerificationUpdate,
} from './ports';

/**
 * The managed tier's documented `ResourceQuota` defaults — `plan.md` §4.2:437–440, the thirteen
 * keys of `AppQuotaInput`. A closed tier publishes the same defaults the platform documents for
 * `ever-works-apps`; the zone overwrites them with the Work's own profile when the tier is open
 * (`APW-10/plan.md`:717).
 */
const DISABLED_TIER_QUOTA: AppQuotaInput = {
    'requests.cpu': '2',
    'limits.cpu': '4',
    'requests.memory': '4Gi',
    'limits.memory': '6Gi',
    pods: 20,
    persistentvolumeclaims: 5,
    'requests.storage': '20Gi',
    'services.loadbalancers': 0,
    'services.nodeports': 0,
    'count/jobs.batch': 20,
    'count/cronjobs.batch': 20,
    secrets: 30,
    configmaps: 30,
};

/**
 * The managed tier's documented `LimitRange` defaults — `plan.md` §4.2:435–436 — with the
 * `ever-works-apps` column of the per-container `max` (2 CPU / 4Gi; `your-cluster` allows 8 / 64Gi).
 */
const DISABLED_TIER_LIMIT_RANGE: AppLimitRangeInput = {
    defaultRequest: { cpu: '100m', memory: '128Mi' },
    defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
    max: { cpu: '2', memory: '4Gi' },
};

/**
 * The tier is closed. APW-10 replaces this binding; until then nothing may reach the managed tier.
 *
 * `isOpen()` is `false` and stays `false` for the lifetime of the instance — there is no call order,
 * no user and no scope that can make it report open. `eligibility` answers the same thing for every
 * owner.
 */
export class DisabledAppsTierPolicy implements AppsTierPolicy {
    /** Always closed (`APW-10/plan.md` §5.5:704–721, R-5). */
    isOpen(): boolean {
        return false;
    }

    /**
     * The narrowest scope, matching APW-03's reading of an unbound port
     * (`APW-03/plan.md`:216 — "Port unbound ⇒ `{ open: false, scope: 'verified-blueprints' }`").
     * A closed tier never widens to `any`.
     */
    managedScope(): 'verified-blueprints' | 'any' {
        return 'verified-blueprints';
    }

    /** No control-namespace credential exists while the tier is closed. */
    async resolveClusterCredential(workId: string): Promise<string> {
        throw new AppPortUnavailableError(
            'cluster_credential_unavailable',
            'The Ever Works Apps tier is disabled, so there is no control-namespace credential to hand out.',
            workId,
        );
    }

    /**
     * A closed tier still **answers** this one, because `podPolicy()` reports a state rather than
     * performing work, and the state it reports is the fail-closed one:
     *
     * - `runtimeClassName: null` is exactly the signal `plan.md` §9.6:1364 and §5.1:684 name — the
     *   named precondition `managed_sandbox_unavailable` (R-24: a sandboxed runtime for tenant
     *   workloads arrives with Wave 2), so nothing renders a workload while no sandbox exists.
     * - the quota and the limit range are the **documented platform defaults** of `plan.md`
     *   §4.2:435–440 ("`ResourceQuota` (`ever-works-apps`, from `AppsTierPolicy`, defaults)" and the
     *   `LimitRange` defaults), i.e. the 13 `AppQuotaInput` keys and the `ever-works-apps` column of
     *   the per-container `max`.
     *
     * Throwing here would crash a caller that must not throw — §5.1's precondition service "returns
     * `AppPrecondition[]`, never throws for an unmet one" and reads
     * `podPolicy().runtimeClassName` to build `managed_sandbox_unavailable`. The refusal itself is
     * `isOpen() === false` (`managed_disabled`, §5.1:683).
     */
    podPolicy(): {
        runtimeClassName: string | null;
        quota: AppQuotaInput;
        limitRange: AppLimitRangeInput;
    } {
        return {
            runtimeClassName: null,
            quota: { ...DISABLED_TIER_QUOTA },
            limitRange: { ...DISABLED_TIER_LIMIT_RANGE },
        };
    }

    /**
     * No zone exists while the tier is closed, so there is no edge ingress to name. Unlike
     * `podPolicy()`, `plan.md` fixes **no** default for the edge class or its controller namespace —
     * they are the zone's own values (`APW-10/plan.md`:718) — and naming one here would invent a
     * cluster object. A caller refuses with the precondition instead.
     */
    ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' } {
        throw new AppPortUnavailableError(
            'tier_ingress_unavailable',
            'The Ever Works Apps tier is disabled, so it publishes no ingress.',
        );
    }

    /**
     * Nobody is eligible while the tier is closed. The reason is APW-03's closed managed-hosting
     * reason `managedTierDisabled` (`APW-03/plan.md`:467, ACC-03-48), which is the code the target
     * card already renders for a closed tier.
     *
     * ── Unreconciled with APW-10 ────────────────────────────────────────────────────────────────
     * APW-10's own plan asks for a *different* code here: "the disabled default returns `false` and
     * `['tierClosed']`" (`APW-10/plan.md`:721), and its closed reason union
     * (`packages/contracts/src/apps/apps-tier.ts:428–440`) contains `tierClosed` and not
     * `managedTierDisabled`. APW-06's task text names `managedTierDisabled` (`APW-06/tasks.md`:81)
     * while `plan.md` §9.6:1368 says the reasons "are APW-10's codes". Both codes mean "the tier is
     * closed"; whichever one is chosen, the other is an additive change to this array.
     */
    async eligibility(userId: string): Promise<{ eligible: boolean; reasons: string[] }> {
        return { eligible: false, reasons: ['managedTierDisabled'] };
    }
}

/**
 * No read-only registry credential is available: APW-05 binds the real one. A missing credential is
 * a named precondition, never a silent anonymous pull (`plan.md` §5.1:690, APW-05 `plan.md`:1136).
 */
export class UnavailablePullCredentialSource implements AppImagePullCredentialSource {
    async resolve(
        workId: string,
        buildId: string,
    ): Promise<{ server: string; username: string; password: string } | null> {
        throw new AppPortUnavailableError(
            'pull_credential_unavailable',
            'No App image pull credential source is bound.',
            `${workId}:${buildId}`,
        );
    }
}

/** No env source is bound: APW-07 supplies it. Both the stored and the ephemeral paths refuse. */
export class UnavailableRuntimeEnvSource implements AppRuntimeEnvSource {
    async resolve(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEnvContext,
    ): Promise<{
        values: Record<string, string>;
        secretNames: string[];
        unsetRequired: string[];
        notReadyDependencies: string[];
        egress: Array<{ host: string; ports: number[] }>;
    }> {
        throw new AppPortUnavailableError(
            'env_source_unavailable',
            'No App runtime env source is bound.',
            `${workId}@${specCommitSha}:${ctx?.target}`,
        );
    }

    async resolveEphemeral(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEnvEphemeralContext,
    ): Promise<{
        values?: Record<string, string>;
        recipe?: Array<{
            name: string;
            secret: boolean;
            source: 'generate' | 'literal' | 'template' | 'prompted';
            spec: unknown;
        }>;
        secretNames: string[];
        unsetRequired: string[];
    }> {
        throw new AppPortUnavailableError(
            'env_source_unavailable',
            'No App runtime env source is bound.',
            `${workId}@${specCommitSha}:${ctx?.target}`,
        );
    }
}

/**
 * No runtime target resolver is bound. `prepareDependencyTarget` **resolves** an `unavailable`
 * discriminant — it does not throw — so APW-07's provider reports a precondition instead of
 * crashing (`plan.md` §9.6:1429–1436). `target_none` is the default answer: with nothing bound there
 * is no chosen target to prepare a namespace for.
 *
 * The reason is a constructor argument so a caller that knows better (for example a resolver whose
 * cluster dial failed) can report `cluster_unreachable` without a second class. Omitting it keeps
 * the documented default.
 */
export class UnavailableRuntimeTarget implements AppRuntimeTargetPort {
    constructor(private readonly unavailable: AppRuntimeTargetUnavailable = 'target_none') {}

    async prepareDependencyTarget(
        workId: string,
    ): Promise<
        | { ref: AppTargetRef; podLabels: Record<string, string> }
        | { unavailable: AppRuntimeTargetUnavailable }
    > {
        void workId;
        return { unavailable: this.unavailable };
    }
}

/**
 * No verification result channel is bound: APW-04 implements it and stores the attempt on its own
 * row (`plan.md` §4.12:656–661).
 *
 * It refuses **before any namespace exists** — the refusal is the method's whole body, so a
 * verification can never create a namespace it would then have nowhere to report to.
 */
export class UnavailableVerificationSink implements AppVerificationSink {
    async report(update: AppVerificationUpdate): Promise<void> {
        throw new AppPortUnavailableError(
            'verification_sink_unavailable',
            'No App verification sink is bound, so no verification can report a result.',
            update?.provisioningId,
        );
    }
}
