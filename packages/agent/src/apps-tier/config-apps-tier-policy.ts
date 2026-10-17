/**
 * APW-10's minimal `AppsTierPolicy` (APW-06 T44, lane aw-managed-deps, 2026-10-17) — the class
 * `APPS_TIER_POLICY` is bound to in the API (`AppDeployRequestModule`,
 * `apps/api/src/app-works/apps-tier-policy-binding.module.ts`) and in the isolated App runtime
 * worker (`TriggerAppRuntimeModule`).
 *
 * ## Why it lives here and not under `app-runtime/`
 *
 * Resolution R-5 (`CONTRACTS.md` §0): APW-06 declares the `AppsTierPolicy` port and its disabled
 * default, APW-10 **owns** what the port means, and every consumer asks `isOpen()` — nothing under
 * `packages/agent/src/app-runtime` reads the managed-tier ceiling environment variable itself
 * (`app-runtime/__tests__/default-ports.spec.ts` › "R-5: nothing under packages/agent/src/app-runtime
 * reads the tier ceiling" enforces that). This file reads the ceiling, so it is APW-10's: it sits in
 * `packages/agent/src/apps-tier/`, the folder APW-10 plan §5.3 assigns the policy implementation,
 * and `app-runtime/index.ts` re-exports it so `@ever-works/agent/app-runtime` importers are
 * unchanged. It was first written in `app-runtime/app-runtime-worker.adapters.ts` (#2681,
 * extended by lane aw-managed-deps) and moved here, body unchanged, when that R-5 guard went red
 * on `develop`.
 */

import type { AppLimitRangeInput, AppQuotaInput } from '@ever-works/plugin';

import { DisabledAppsTierPolicy } from '../app-runtime/default-ports';
import { AppPortUnavailableError, type AppsTierPolicy } from '../app-runtime/ports';
import { isAppClusterWorkerContext } from '../app-runtime/worker-context';

/** The env switch that opens the managed **Ever Works Apps** target (default off). */
export const APPS_MANAGED_ENABLED_ENV = 'EVER_WORKS_APPS_MANAGED_ENABLED';

// APW-10 lite (2026-10-17, lane aw-managed-deps): sized for the App AND its in-namespace
// dependencies — Postgres (10Gi), Redis (1Gi) and object storage (20Gi) by default, each with
// the LimitRange's 1-CPU default limit when it declares none — so a typical App with all three
// fits. Every number is an operator override (`managedQuotaFromEnv`).
const MANAGED_QUOTA: AppQuotaInput = {
    'requests.cpu': '2',
    'limits.cpu': '8',
    'requests.memory': '4Gi',
    'limits.memory': '10Gi',
    pods: 20,
    persistentvolumeclaims: 8,
    'requests.storage': '50Gi',
    'services.loadbalancers': 0,
    'services.nodeports': 0,
    'count/jobs.batch': 20,
    'count/cronjobs.batch': 20,
    secrets: 30,
    configmaps: 30,
};

const MANAGED_LIMIT_RANGE: AppLimitRangeInput = {
    defaultRequest: { cpu: '100m', memory: '128Mi' },
    defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
    max: { cpu: '2', memory: '4Gi' },
};

/**
 * The minimal APW-10 policy: the managed target is **closed** unless
 * `EVER_WORKS_APPS_MANAGED_ENABLED=true`, and closed it behaves exactly like
 * `DisabledAppsTierPolicy` (so every consumer answers the existing `managed_disabled` /
 * `tier_closed` codes). Open, it reads the rest of its policy from the environment of the process
 * that hosts it — the operator's own managed cluster:
 *
 * - `EVER_WORKS_APPS_MANAGED_KUBECONFIG` (**secret**) — the control-namespace credential;
 * - `EVER_WORKS_APPS_MANAGED_RUNTIME_CLASS` — the sandbox runtime class (unset ⇒ R-24's
 *   `managed_sandbox_unavailable`);
 * - `EVER_WORKS_APPS_MANAGED_INGRESS_CLASS` / `…_INGRESS_NAMESPACE` (default `nginx` / `ingress-nginx`);
 * - `EVER_WORKS_APPS_MANAGED_SCOPE` — `verified-blueprints`, or the default `any` (APW-10 lite,
 *   2026-10-17: the licence rule — green only, amber/red/unknown refused even when attested — is
 *   what admits an app; `verified-blueprints` is the operator's opt-in narrowing);
 * - `EVER_WORKS_APPS_MANAGED_QUOTA_*` / `EVER_WORKS_APPS_MANAGED_LIMIT_*` — override the
 *   per-namespace ResourceQuota / LimitRange defaults below (see `managedQuotaFromEnv`).
 *
 * **The kubeconfig is read only inside the isolated App runtime worker** (APW-10 lite): in any
 * other process {@link resolveClusterCredential} refuses `cluster_credential_unavailable` before
 * the variable is touched, so the API never holds it. It may be the YAML itself or its base64
 * (`EVER_WORKS_APPS_MANAGED_KUBECONFIG` is documented as base64, the form a Secret carries), and
 * it is never logged or echoed.
 *
 * Read at call time, never cached, so flipping the switch needs no redeploy of the code.
 */
export class ConfigAppsTierPolicy implements AppsTierPolicy {
    private readonly closed = new DisabledAppsTierPolicy();

    constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

    isOpen(): boolean {
        return this.env[APPS_MANAGED_ENABLED_ENV] === 'true';
    }

    managedScope(): 'verified-blueprints' | 'any' {
        if (!this.isOpen()) return 'verified-blueprints';
        return this.env.EVER_WORKS_APPS_MANAGED_SCOPE === 'verified-blueprints'
            ? 'verified-blueprints'
            : 'any';
    }

    async resolveClusterCredential(workId: string): Promise<string> {
        if (!this.isOpen()) return this.closed.resolveClusterCredential(workId);

        if (!this.workerOnly()) {
            throw new AppPortUnavailableError(
                'cluster_credential_unavailable',
                'The Ever Works Apps cluster credential is read only inside the isolated App runtime worker.',
                workId,
            );
        }

        const credential = decodeKubeconfig(this.env.EVER_WORKS_APPS_MANAGED_KUBECONFIG ?? '');
        if (!credential) {
            throw new AppPortUnavailableError(
                'cluster_credential_unavailable',
                'Ever Works Apps is open but EVER_WORKS_APPS_MANAGED_KUBECONFIG is not set or not a kubeconfig.',
                workId,
            );
        }
        return credential;
    }

    /** Overridable for specs; production answers whether this process is the isolated worker. */
    protected workerOnly(): boolean {
        return isAppClusterWorkerContext();
    }

    podPolicy(): {
        runtimeClassName: string | null;
        quota: AppQuotaInput;
        limitRange: AppLimitRangeInput;
    } {
        if (!this.isOpen()) return this.closed.podPolicy();

        const runtimeClassName = (this.env.EVER_WORKS_APPS_MANAGED_RUNTIME_CLASS ?? '').trim();
        return {
            runtimeClassName: runtimeClassName || null,
            quota: managedQuotaFromEnv(this.env),
            limitRange: managedLimitRangeFromEnv(this.env),
        };
    }

    ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' } {
        if (!this.isOpen()) return this.closed.ingress();

        return {
            className: (this.env.EVER_WORKS_APPS_MANAGED_INGRESS_CLASS ?? '').trim() || 'nginx',
            controllerNamespace:
                (this.env.EVER_WORKS_APPS_MANAGED_INGRESS_NAMESPACE ?? '').trim() ||
                'ingress-nginx',
            edgeTlsMode: 'edge',
        };
    }

    async eligibility(userId: string): Promise<{ eligible: boolean; reasons: string[] }> {
        if (!this.isOpen()) return this.closed.eligibility(userId);
        return { eligible: true, reasons: [] };
    }
}

/** Does this text look like a kubeconfig document? */
const KUBECONFIG_KEY = /^\s*(apiVersion|kind|clusters|contexts|current-context|users)\s*:/m;

/**
 * The managed kubeconfig as YAML: the value itself when it already is YAML, else its base64
 * decoding. Empty or undecodable answers `''`. Never logged.
 */
export function decodeKubeconfig(raw: string): string {
    const value = (raw ?? '').trim();
    if (!value) return '';
    if (KUBECONFIG_KEY.test(value)) return value;
    try {
        const decoded = Buffer.from(value.replace(/\s+/g, ''), 'base64').toString('utf-8').trim();
        return KUBECONFIG_KEY.test(decoded) ? decoded : '';
    } catch {
        return '';
    }
}

/** A Kubernetes quantity (`2`, `500m`, `4Gi`) — what an override must look like to be used. */
const QUANTITY = /^[0-9]+(\.[0-9]+)?(m|k|Ki|M|Mi|G|Gi|T|Ti)?$/;

function quantity(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
    const value = (env[name] ?? '').trim();
    return QUANTITY.test(value) ? value : fallback;
}

function count(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = (env[name] ?? '').trim();
    const value = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isInteger(value) ? value : fallback;
}

/**
 * The per-namespace ResourceQuota, with operator overrides —
 * `EVER_WORKS_APPS_MANAGED_QUOTA_{CPU_REQUESTS,CPU_LIMITS,MEMORY_REQUESTS,MEMORY_LIMITS,STORAGE,PODS,PVCS}`.
 * A malformed value is ignored (the default stands) rather than rendered.
 */
export function managedQuotaFromEnv(env: NodeJS.ProcessEnv = process.env): AppQuotaInput {
    const base = MANAGED_QUOTA as unknown as Record<string, string | number>;
    return {
        ...MANAGED_QUOTA,
        'requests.cpu': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_CPU_REQUESTS',
            String(base['requests.cpu']),
        ),
        'limits.cpu': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_CPU_LIMITS',
            String(base['limits.cpu']),
        ),
        'requests.memory': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_MEMORY_REQUESTS',
            String(base['requests.memory']),
        ),
        'limits.memory': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_MEMORY_LIMITS',
            String(base['limits.memory']),
        ),
        'requests.storage': quantity(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_STORAGE',
            String(base['requests.storage']),
        ),
        pods: count(env, 'EVER_WORKS_APPS_MANAGED_QUOTA_PODS', Number(base.pods)),
        persistentvolumeclaims: count(
            env,
            'EVER_WORKS_APPS_MANAGED_QUOTA_PVCS',
            Number(base.persistentvolumeclaims),
        ),
    } as AppQuotaInput;
}

/**
 * The per-namespace LimitRange, with operator overrides —
 * `EVER_WORKS_APPS_MANAGED_LIMIT_{REQUEST_CPU,REQUEST_MEMORY,DEFAULT_CPU,DEFAULT_MEMORY,MAX_CPU,MAX_MEMORY}`.
 */
export function managedLimitRangeFromEnv(env: NodeJS.ProcessEnv = process.env): AppLimitRangeInput {
    const base = MANAGED_LIMIT_RANGE as {
        defaultRequest: Record<string, string>;
        defaultLimit: Record<string, string>;
        max: Record<string, string>;
    };
    return {
        defaultRequest: {
            ...base.defaultRequest,
            cpu: quantity(
                env,
                'EVER_WORKS_APPS_MANAGED_LIMIT_REQUEST_CPU',
                base.defaultRequest.cpu,
            ),
            memory: quantity(
                env,
                'EVER_WORKS_APPS_MANAGED_LIMIT_REQUEST_MEMORY',
                base.defaultRequest.memory,
            ),
        },
        defaultLimit: {
            ...base.defaultLimit,
            cpu: quantity(env, 'EVER_WORKS_APPS_MANAGED_LIMIT_DEFAULT_CPU', base.defaultLimit.cpu),
            memory: quantity(
                env,
                'EVER_WORKS_APPS_MANAGED_LIMIT_DEFAULT_MEMORY',
                base.defaultLimit.memory,
            ),
        },
        max: {
            ...base.max,
            cpu: quantity(env, 'EVER_WORKS_APPS_MANAGED_LIMIT_MAX_CPU', base.max.cpu),
            memory: quantity(env, 'EVER_WORKS_APPS_MANAGED_LIMIT_MAX_MEMORY', base.max.memory),
        },
    } as AppLimitRangeInput;
}
