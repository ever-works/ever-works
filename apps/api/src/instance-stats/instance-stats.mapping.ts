import { WORK_KINDS } from '@ever-works/contracts';
import {
    WORKS_STATS_DEPLOYMENT_PROVIDER_KEYS,
    WORKS_STATS_WORK_KIND_KEYS,
    type EverStatsChannel,
    type WorksStatsDeploymentProviderKey,
    type WorksStatsWorkKindKey,
} from '@ever-works/contracts';

/**
 * The closed-list mapping of an anonymous usage statistics report: every
 * stored value is folded onto a key the published schema lists, and anything
 * else is counted under `other` — a plugin id, a provider name or a new kind
 * is NEVER turned into a key of its own.
 */

/** The version of this module, sent as `module_version` (major.minor.patch, no suffix). */
export const INSTANCE_STATS_MODULE_VERSION = '1.0.0';

/** A stored Work kind → its `works_by_kind` key (`landing-page` → `landing_page`, unknown → `other`). */
export function workKindKey(stored: string): WorksStatsWorkKindKey {
    const normalised = stored.trim().toLowerCase();
    const canonical = normalised === 'landing' ? 'landing-page' : normalised;
    const key = canonical.replace(/-/g, '_') as WorksStatsWorkKindKey;
    return (WORKS_STATS_WORK_KIND_KEYS as readonly string[]).includes(key) && key !== 'other'
        ? key
        : 'other';
}

/** Every Work kind the product knows, as schema keys — the guard test checks none is `other`. */
export function knownWorkKindKeys(): Array<{ kind: string; key: WorksStatsWorkKindKey }> {
    return WORK_KINDS.map((kind) => ({ kind, key: workKindKey(kind) }));
}

/** `works_by_kind` with every schema key present (zero when nothing is stored). */
export function foldWorksByKind(
    stored: Record<string, number>,
): Record<WorksStatsWorkKindKey, number> {
    const out = Object.fromEntries(WORKS_STATS_WORK_KIND_KEYS.map((key) => [key, 0])) as Record<
        WorksStatsWorkKindKey,
        number
    >;
    for (const [kind, count] of Object.entries(stored)) {
        out[workKindKey(kind)] += count;
    }
    return out;
}

const PROVIDER_KEYS: Readonly<Record<string, WorksStatsDeploymentProviderKey>> = {
    'ever-works': 'ever_works',
    vercel: 'vercel',
    k8s: 'k8s',
    'your-cluster': 'your_cluster',
    'ever-works-apps': 'ever_works_apps',
};

/** A stored deployment provider id → its schema key; any other provider (a custom plugin) → `other`. */
export function deploymentProviderKey(stored: string): WorksStatsDeploymentProviderKey {
    const id = stored.trim().toLowerCase();
    // Own keys only: `constructor`, `toString` or `__proto__` must fold to `other`.
    return Object.prototype.hasOwnProperty.call(PROVIDER_KEYS, id) ? PROVIDER_KEYS[id] : 'other';
}

/** `deployments_by_provider` with every schema key present. */
export function foldDeploymentsByProvider(
    stored: Record<string, number>,
): Record<WorksStatsDeploymentProviderKey, number> {
    const out = Object.fromEntries(
        WORKS_STATS_DEPLOYMENT_PROVIDER_KEYS.map((key) => [key, 0]),
    ) as Record<WorksStatsDeploymentProviderKey, number>;
    for (const [provider, count] of Object.entries(stored)) {
        out[deploymentProviderKey(provider)] += count;
    }
    return out;
}

/**
 * The product version as the schema allows it: `major.minor.patch` and nothing
 * else, because a fork's build string (`1.2.3-acme-corp`) could name a
 * company. A suffix only chooses the release `channel`; an unparsable version
 * is sent as `0.0.0` on the `custom` channel.
 */
export function versionAndChannel(raw: string): { version: string; channel: EverStatsChannel } {
    const match = raw.trim().match(/^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:([-+])(.*))?$/);
    if (!match) return { version: '0.0.0', channel: 'custom' };
    const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
    const suffix = match[5];
    if (match[4] === undefined || match[4] === '+') return { version, channel: 'stable' };
    const tag = (suffix ?? '').toLowerCase();
    if (/^rc(\b|[.\d-]|$)/.test(tag)) return { version, channel: 'rc' };
    if (/^(beta|alpha)(\b|[.\d-]|$)/.test(tag)) return { version, channel: 'beta' };
    if (/^(dev|develop|snapshot|nightly|canary)(\b|[.\d-]|$)/.test(tag))
        return { version, channel: 'dev' };
    return { version, channel: 'custom' };
}

/** The UTC month `YYYY-MM` of `at`. */
export function periodOf(at: Date): string {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The UTC month before the one of `at`, as `YYYY-MM`. */
export function previousPeriodOf(at: Date): string {
    return periodOf(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)));
}

/** `[start, end)` of a `YYYY-MM` period, in UTC. */
export function periodRange(period: string): { start: Date; end: Date } {
    const [year, month] = period.split('-').map(Number);
    return {
        start: new Date(Date.UTC(year, month - 1, 1)),
        end: new Date(Date.UTC(year, month, 1)),
    };
}

/** The UTC date `YYYY-MM-DD` of `at` — no time of day ever leaves the instance. */
export function utcDateOf(at: Date): string {
    return `${periodOf(at)}-${String(at.getUTCDate()).padStart(2, '0')}`;
}
