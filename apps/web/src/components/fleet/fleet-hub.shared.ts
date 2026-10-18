import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01) — the pure rules behind the hub's lists: which state
 * word a computer gets, the order computers are listed in, how virtual
 * computers nest under their host, and which health numbers may be shown.
 * No React, no i18n: the components turn these keys into words.
 */

// ─── State in words ─────────────────────────────────────────────────────────

/**
 * The one word a computer's state is shown as (spec §5.8). The dot colour is
 * never the only signal: every key has a word (`fleet.states.<key>`).
 */
export const FLEET_COMPUTER_STATE_KEYS = [
    'online',
    'busy',
    'offline',
    'enrolling',
    'paused',
    'disabled',
    'draining',
    'quarantined',
    'throttled',
    'upgradeRequired',
    'unknown',
] as const;

export type FleetComputerStateKey = (typeof FLEET_COMPUTER_STATE_KEYS)[number];

export type FleetStateTone = 'success' | 'info' | 'muted' | 'warning' | 'danger';

const TONES: Readonly<Record<FleetComputerStateKey, FleetStateTone>> = {
    online: 'success',
    busy: 'info',
    offline: 'muted',
    enrolling: 'warning',
    paused: 'muted',
    disabled: 'danger',
    draining: 'warning',
    quarantined: 'danger',
    throttled: 'warning',
    upgradeRequired: 'warning',
    unknown: 'muted',
};

/** The dot class for a tone (design tokens the settings table already uses). */
export const FLEET_TONE_DOT_CLASS: Readonly<Record<FleetStateTone, string>> = {
    success: 'bg-success',
    info: 'bg-info',
    muted: 'bg-text-muted dark:bg-text-muted-dark',
    warning: 'bg-warning',
    danger: 'bg-danger',
};

/**
 * A computer's state, most decisive fact first:
 *
 *   enrolling → disabled (draining while it still holds work) → paused →
 *   offline → quarantined → throttled (worker, or a model CLI out of
 *   quota) → upgrade required → busy (holding work) → online.
 *
 * A status this build does not know is `unknown`, never a guess.
 */
export function computerStateKey(
    node: Pick<FleetNodeView, 'status'> &
        Partial<Pick<FleetNodeView, 'workerState' | 'load' | 'upgradeRequired' | 'modelThrottles'>>,
): FleetComputerStateKey {
    const activeJobs = node.load?.activeJobCount ?? 0;
    switch (node.status) {
        case 'enrolling':
            return 'enrolling';
        case 'disabled':
            return activeJobs > 0 ? 'draining' : 'disabled';
        case 'paused':
            return 'paused';
        case 'offline':
            return 'offline';
        case 'online':
            break;
        default:
            return 'unknown';
    }
    if (node.workerState === 'quarantined') return 'quarantined';
    if (node.workerState === 'throttled' || (node.modelThrottles?.length ?? 0) > 0)
        return 'throttled';
    if (node.upgradeRequired) return 'upgradeRequired';
    if (activeJobs > 0 || node.workerState === 'working') return 'busy';
    return 'online';
}

export function computerStateTone(key: FleetComputerStateKey): FleetStateTone {
    return TONES[key];
}

/** Is this computer reachable right now (counts toward "N online")? */
export function isComputerOnline(node: Pick<FleetNodeView, 'status'>): boolean {
    return node.status === 'online';
}

// ─── Order and nesting ──────────────────────────────────────────────────────

function heartbeatMs(node: Pick<FleetNodeView, 'lastHeartbeatAt'>): number {
    const at = node.lastHeartbeatAt ? new Date(node.lastHeartbeatAt).getTime() : NaN;
    return Number.isFinite(at) ? at : -Infinity;
}

/**
 * The list order (FR-7, FR-24): favourites first; then online computers by
 * most recent check; then the rest by most recent check; ties by name, so
 * two renders of the same facts never reorder. Returns a new array.
 */
export function orderComputers<T extends FleetNodeView>(nodes: readonly T[]): T[] {
    return [...nodes].sort((a, b) => {
        const favourite = Number(Boolean(b.isFavorite)) - Number(Boolean(a.isFavorite));
        if (favourite !== 0) return favourite;
        const online = Number(isComputerOnline(b)) - Number(isComputerOnline(a));
        if (online !== 0) return online;
        // Most recent check first; a computer that never checked in sorts last.
        const checkA = heartbeatMs(a);
        const checkB = heartbeatMs(b);
        if (checkA !== checkB) return checkB > checkA ? 1 : -1;
        return a.name.localeCompare(b.name);
    });
}

/** One row of the computer list: a computer and the virtual computers that run on it. */
export interface FleetComputerGroup<T extends FleetNodeView = FleetNodeView> {
    node: T;
    /** VMs and Containers on this computer, by name (FR-9). */
    children: T[];
    /** The host, when this computer is a child whose host the viewer cannot see. */
    hostName?: string | null;
}

/**
 * Nest virtual computers under their host (FR-9). A child whose host is in
 * the list is listed under it — whatever the child's own state, so a host
 * whose children are all offline still shows them; a child whose host is
 * not in the list (not visible to this viewer) is listed on its own.
 * Top-level order is {@link orderComputers}'.
 *
 * One level of nesting is drawn. A computer whose host is itself nested (a
 * Container on a VM on a host), or that sits in a host cycle, is never
 * dropped: it is listed on its own, with its host's name.
 */
export function groupComputersByHost<T extends FleetNodeView>(
    nodes: readonly T[],
): FleetComputerGroup<T>[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const children = new Map<string, T[]>();
    const top: T[] = [];
    for (const node of nodes) {
        const host = node.hostNodeId ? byId.get(node.hostNodeId) : undefined;
        if (host && host.id !== node.id) {
            const list = children.get(host.id) ?? [];
            list.push(node);
            children.set(host.id, list);
        } else {
            top.push(node);
        }
    }
    const topIds = new Set(top.map((node) => node.id));
    const drawn = new Set(topIds);
    for (const id of topIds) {
        for (const child of children.get(id) ?? []) drawn.add(child.id);
    }
    const unreachable = nodes.filter((node) => !drawn.has(node.id));
    return orderComputers([...top, ...unreachable]).map((node) =>
        topIds.has(node.id)
            ? {
                  node,
                  children: (children.get(node.id) ?? []).sort((a, b) =>
                      a.name.localeCompare(b.name),
                  ),
              }
            : {
                  node,
                  children: [],
                  hostName: node.hostNodeId ? (byId.get(node.hostNodeId)?.name ?? null) : null,
              },
    );
}

/** The host a nested computer runs on, for its "VM on build-01" subtitle. */
export function hostNameOf(
    node: Pick<FleetNodeView, 'hostNodeId'>,
    nodes: readonly Pick<FleetNodeView, 'id' | 'name'>[],
): string | null {
    if (!node.hostNodeId) return null;
    return nodes.find((candidate) => candidate.id === node.hostNodeId)?.name ?? null;
}

// ─── Health cells ───────────────────────────────────────────────────────────

/** The three numbers a card shows, when there is a snapshot to show them from (FR-8). */
export interface FleetHealthCells {
    cpuPercent: number | null;
    memPercent: number | null;
    diskPercent: number | null;
    /** When the snapshot was taken. */
    at: string | null;
    /** The snapshot is older than the computer's last check (FR-38): show it marked. */
    stale: boolean;
}

/** A snapshot older than the last check by more than this is stale (two heartbeats). */
export const FLEET_HEALTH_STALE_AFTER_MS = 2 * 60_000;

function percent(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(100, Math.round(value)))
        : null;
}

/**
 * The health cells of a card, or null when the computer has never reported a
 * snapshot — the card then shows "—" and no number (FR-8, FR-38).
 *
 * The snapshot (`health`) arrives with FL-03 (CONTRACTS §4.5); this reads it
 * defensively so the hub renders the same before and after that lands, and
 * never invents a number from anything else.
 */
export function readHealthCells(
    node: Pick<FleetNodeView, 'lastHeartbeatAt'> & { health?: unknown },
): FleetHealthCells | null {
    const health = node.health;
    if (!health || typeof health !== 'object' || Array.isArray(health)) return null;
    const value = health as Record<string, unknown>;
    const cells = {
        cpuPercent: percent(value.cpuPercent),
        memPercent: percent(value.memPercent),
        diskPercent: percent(value.diskPercent),
    };
    if (cells.cpuPercent === null && cells.memPercent === null && cells.diskPercent === null) {
        return null;
    }
    const at =
        typeof value.at === 'string' && Number.isFinite(new Date(value.at).getTime())
            ? value.at
            : null;
    const atMs = at ? new Date(at).getTime() : NaN;
    const checkMs = heartbeatMs(node);
    const stale =
        !Number.isFinite(atMs) ||
        (Number.isFinite(checkMs) && checkMs - atMs > FLEET_HEALTH_STALE_AFTER_MS);
    return { ...cells, at, stale };
}

// ─── Time ───────────────────────────────────────────────────────────────────

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
];

/**
 * "2 hours ago" / "just now" in the viewer's locale, or null for no instant.
 * The absolute time belongs in a tooltip beside it (FR-8).
 */
export function relativeTime(
    iso: string | null | undefined,
    now: Date,
    locale?: string,
): string | null {
    if (!iso) return null;
    const at = new Date(iso).getTime();
    if (!Number.isFinite(at)) return null;
    const delta = at - now.getTime();
    const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, ms] of RELATIVE_UNITS) {
        if (Math.abs(delta) >= ms) return format.format(Math.round(delta / ms), unit);
    }
    return format.format(0, 'minute');
}

/** The absolute instant for a tooltip, or null. */
export function absoluteTime(iso: string | null | undefined, locale?: string): string | null {
    if (!iso) return null;
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return null;
    return at.toLocaleString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}
