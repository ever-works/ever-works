import type { FleetCheckoutView, FleetNodeView } from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14, spec §5) — the pure rules of the Checkouts
 * tabs: grouping by repository, row order, which action a row offers and why
 * not, and the small formatters. No React, no I/O — every rule is a table in
 * `checkouts.shared.unit.spec.ts`.
 */

/** One repository heading on Fleet → Checkouts (spec §5.1). */
export interface CheckoutGroup {
    /** Stable key: the Work, else `host/owner/repo`, else `unlinked`. */
    key: string;
    /** `work` — linked to a Work (label = its name); `repository` — `owner/repo`; `unlinked`. */
    kind: 'work' | 'repository' | 'unlinked';
    /** The Work's name, or `owner/repo`; null for the unlinked group. */
    label: string | null;
    /** `owner/repo`, shown beside a Work's name. */
    repository: string | null;
    rows: FleetCheckoutView[];
    /** Distinct computers the group's checkouts are on. */
    computers: number;
}

/** Group rows by repository — Work name when linked, else `owner/repo`, else "unlinked" (last). */
export function groupCheckoutsByRepository(rows: readonly FleetCheckoutView[]): CheckoutGroup[] {
    const groups = new Map<string, CheckoutGroup>();
    for (const row of rows) {
        let key: string;
        let kind: CheckoutGroup['kind'];
        let label: string | null;
        if (row.workId) {
            key = `work:${row.workId}`;
            kind = 'work';
            label = row.workName ?? row.repository;
        } else if (row.repository) {
            key = `repo:${row.repositoryHost ?? ''}/${row.repository.toLowerCase()}`;
            kind = 'repository';
            label = row.repository;
        } else {
            key = 'unlinked';
            kind = 'unlinked';
            label = null;
        }
        const group = groups.get(key) ?? {
            key,
            kind,
            label,
            repository: row.repository,
            rows: [],
            computers: 0,
        };
        group.rows.push(row);
        groups.set(key, group);
    }
    const out = [...groups.values()];
    for (const group of out) {
        group.rows.sort(compareCheckoutRows);
        group.computers = new Set(group.rows.map((row) => row.nodeId)).size;
    }
    return out.sort((a, b) => {
        if (a.kind === 'unlinked' && b.kind !== 'unlinked') return 1;
        if (b.kind === 'unlinked' && a.kind !== 'unlinked') return -1;
        return (a.label ?? '').localeCompare(b.label ?? '');
    });
}

const STATE_ORDER: Record<FleetCheckoutView['state'], number> = {
    creating: 0,
    ready: 1,
    missing: 2,
    archived: 3,
};

/** Rows: working ones first (creating, ready), then missing; within a state by computer, then path. */
export function compareCheckoutRows(a: FleetCheckoutView, b: FleetCheckoutView): number {
    return (
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.nodeId.localeCompare(b.nodeId) ||
        a.path.localeCompare(b.path)
    );
}

/** The actions a P1 row offers. */
export type CheckoutRowAction = 'refresh' | 'fetch' | 'archive' | 'restore';

/** Why an action is disabled — an `fleet.checkouts.disabled.*` key. */
export type CheckoutDisabledReason =
    | 'offline'
    | 'consentMissing'
    | 'notAllowed'
    | 'killSwitch'
    | 'missing'
    | 'archived'
    | 'creating'
    | 'busy'
    | 'folderRemoved'
    | 'taskWorktree';

export interface CheckoutRowContext {
    /** The computer the row is on (absent: the hub could not read it — treated as offline). */
    node?: Pick<FleetNodeView, 'status' | 'consents' | 'viewerRole'> | null;
    /** The fleet kill switch is on. */
    stopped?: boolean;
}

/** True when the computer is reachable as far as the page can tell (a paused computer still answers). */
export function isComputerOnline(node: CheckoutRowContext['node']): boolean {
    return node?.status === 'online' || node?.status === 'paused';
}

/** True when the viewer may act on checkouts on this computer (the server checks again). */
export function mayManageCheckouts(node: CheckoutRowContext['node']): boolean {
    return node?.viewerRole === undefined || node?.viewerRole === 'owner';
}

/**
 * Whether one row offers one action, and why not (spec U1–U4, U9, FR-13,
 * FR-26). Order matters: the first reason that applies is the one shown.
 * The server re-checks every one of these; this only keeps the page honest.
 */
export function checkoutActionState(
    action: CheckoutRowAction,
    row: Pick<FleetCheckoutView, 'state' | 'busy' | 'folderRemoved' | 'createdBy'>,
    context: CheckoutRowContext,
): { enabled: true } | { enabled: false; reason: CheckoutDisabledReason } {
    if (!mayManageCheckouts(context.node)) return { enabled: false, reason: 'notAllowed' };
    if (context.stopped) return { enabled: false, reason: 'killSwitch' };
    if (action === 'archive') {
        if (row.state === 'archived') return { enabled: false, reason: 'archived' };
        if (row.state === 'creating') return { enabled: false, reason: 'creating' };
        if (row.busy === 'session') return { enabled: false, reason: 'busy' };
        return { enabled: true };
    }
    if (action === 'restore') {
        if (row.state !== 'archived') return { enabled: false, reason: 'archived' };
        if (row.folderRemoved) return { enabled: false, reason: 'folderRemoved' };
        if (!isComputerOnline(context.node)) return { enabled: false, reason: 'offline' };
        return { enabled: true };
    }
    // refresh, fetch — they run on the machine.
    if (!isComputerOnline(context.node)) return { enabled: false, reason: 'offline' };
    if (row.state === 'archived') return { enabled: false, reason: 'archived' };
    if (row.state === 'missing') return { enabled: false, reason: 'missing' };
    if (row.state === 'creating') return { enabled: false, reason: 'creating' };
    if (action === 'fetch') {
        if (row.createdBy === 'task') return { enabled: false, reason: 'taskWorktree' };
        if (context.node?.consents && context.node.consents.manage === false)
            return { enabled: false, reason: 'consentMissing' };
        if (row.busy === 'operation') return { enabled: false, reason: 'busy' };
    }
    return { enabled: true };
}

/** `1.2 GB`, `420 MB`, `12 KB` — sizes on disk (spec FR-14). Null for unknown. */
export function formatCheckoutSize(bytes: number | null | undefined): string | null {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[unit]}`;
}

/** `~/code/api` for a path under a home folder (POSIX `/home/<u>`, macOS `/Users/<u>`, Windows `C:\Users\<u>`). */
export function homeRelativePath(path: string): string {
    const posix = /^\/(?:home|Users)\/[^/]+(\/.*)?$/.exec(path);
    if (posix) return `~${posix[1] ?? ''}`;
    const windows = /^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/.exec(path);
    if (windows) return `~${windows[1] ?? ''}`;
    return path;
}

/** Sum of row sizes (the computer's total, spec FR-14), skipping the bin. */
export function totalCheckoutBytes(rows: readonly Pick<FleetCheckoutView, 'state' | 'sizeBytes'>[]): number {
    let total = 0;
    for (const row of rows) if (row.state !== 'archived') total += row.sizeBytes ?? 0;
    return total;
}

/** Minutes/hours/days since an ISO time, for "found 2 h ago" / "idle 3 d". Null for unknown. */
export function ageParts(iso: string | null | undefined, now: number): { value: number; unit: 'm' | 'h' | 'd' } | null {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    const minutes = Math.max(0, Math.round((now - at) / 60_000));
    if (minutes < 60) return { value: minutes, unit: 'm' };
    const hours = Math.round(minutes / 60);
    if (hours < 48) return { value: hours, unit: 'h' };
    return { value: Math.round(hours / 24), unit: 'd' };
}

/** How often the tab re-reads: every 10 s while anything is being created or fetched, else every 60 s. */
export function checkoutsPollMs(rows: readonly Pick<FleetCheckoutView, 'state' | 'lastCommand'>[]): number {
    const working = rows.some(
        (row) => row.state === 'creating' || (row.lastCommand !== null && row.lastCommand.exitCode === null),
    );
    return working ? 10_000 : 60_000;
}
