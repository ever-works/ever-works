import {
    fleetGitLineFreshness,
    type FleetSessionActionAvailability,
    type FleetSessionActionId,
    type FleetSessionActionLedgerEntry,
    type FleetCheckoutChangedFile,
    type FleetGitLine,
    type FleetGitLinePullRequest,
    type FleetSessionGitRef,
} from '@ever-works/contracts';

/**
 * Session git & actions (FL-06) — the pure rules the session git surfaces
 * share (spec §5.1, §5.5): the pull-request pill's tone and glyph, how old a
 * git line reads, the Changes footer's counts, the error-title key. No React,
 * no fetching — every rule here is one table a unit spec can pin.
 */

/** Pill tones (spec §5.1): open green, draft muted, merged violet, closed grey. */
export const PR_PILL_TONE: Record<FleetGitLinePullRequest['state'], string> = {
    open: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
    draft: 'bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300',
    merged: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300',
    closed: 'bg-slate-200 dark:bg-slate-700/40 text-slate-500 dark:text-slate-400',
};

/** The checks glyph (spec §5.1): ✓ passing, ⏳ pending, ✗ failing, nothing when no checks reported. */
export function prChecksGlyph(checks: FleetGitLinePullRequest['checks']): string {
    switch (checks) {
        case 'passing':
            return '✓';
        case 'failing':
            return '✗';
        case 'pending':
            return '⏳';
        default:
            return '';
    }
}

/** A pull request URL safe to make clickable: plain `https:` with no credentials, else null. */
export function safeHttpsUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        return url.toString();
    } catch {
        return null;
    }
}

/** How the age beside a git line reads: amber past five minutes, dimmed when the computer is offline. */
export function gitLineAgeTone(line: Pick<FleetGitLine, 'at'> | null, now: number, offline: boolean): 'normal' | 'stale' | 'offline' {
    if (offline) return 'offline';
    return fleetGitLineFreshness(line, now) === 'stale' ? 'stale' : 'normal';
}

/** The git line without its pull request (the card shows the pill in its own slot). */
export function withoutPullRequest(line: FleetGitLine | null): FleetGitLine | null {
    return line ? { ...line, pr: null } : null;
}

/** Whether a session has a git line to show, or the "Not in a checkout" state (spec §5.1). */
export function sessionGitState(git: FleetSessionGitRef | null | undefined): 'none' | 'missing' | 'line' {
    if (!git) return 'none';
    if (git.state === 'missing' || git.state === 'archived') return 'missing';
    return 'line';
}

/** The last folder of a path (`~/code/api` → `api`), for the worktree tooltip. */
export function folderOf(path: string): string {
    const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
    return parts[parts.length - 1] ?? path;
}

/** Bytes as `1.4 MiB` / `12 KiB` / `300 B` (the Changes footer). */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The tone of one diff line (text only — never markup): additions green, deletions red, hunks muted. */
export function diffLineTone(line: string): string {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
        return 'text-text-muted dark:text-text-muted-dark';
    }
    if (line.startsWith('@@')) return 'text-sky-600 dark:text-sky-400';
    if (line.startsWith('+')) return 'text-emerald-700 dark:text-emerald-300 bg-emerald-50/60 dark:bg-emerald-900/20';
    if (line.startsWith('-')) return 'text-red-700 dark:text-red-300 bg-red-50/60 dark:bg-red-900/20';
    return 'text-text dark:text-text-dark';
}

/** `+12 −3`, or the status word for a file without counts (binary, untracked without a patch). */
export function changedFileCounts(file: Pick<FleetCheckoutChangedFile, 'added' | 'removed'>): string | null {
    if (file.added === null && file.removed === null) return null;
    return `+${file.added ?? 0} −${file.removed ?? 0}`;
}

/** A changed file's status → its `fleet.sessionGit.changes.status.*` key (leaf keys are camelCase, CONTRACTS §11.4). */
export function changedFileStatusKey(status: FleetCheckoutChangedFile['status']): string {
    return status === 'type-changed' ? 'typeChanged' : status;
}

/** The CONTRACTS §8 code → the `fleet.sessionGit.errorTitles.*` key. */
export type SessionGitErrorTitleKey =
    | 'notFound'
    | 'invalid'
    | 'unreachable'
    | 'consentMissing'
    | 'permissionDenied'
    | 'killSwitch'
    | 'limitExceeded'
    | 'busy'
    | 'operationFailed'
    | 'internal';

export function sessionGitErrorTitleKey(code: string | null | undefined): SessionGitErrorTitleKey {
    switch (code) {
        case 'not_found':
            return 'notFound';
        case 'invalid':
            return 'invalid';
        case 'unreachable':
            return 'unreachable';
        case 'consent_missing':
            return 'consentMissing';
        case 'permission_denied':
            return 'permissionDenied';
        case 'kill_switch':
            return 'killSwitch';
        case 'limit_exceeded':
            return 'limitExceeded';
        case 'busy':
            return 'busy';
        case 'operation_failed':
            return 'operationFailed';
        default:
            return 'internal';
    }
}

/** Minutes since an ISO time, at least 1 (the "GitHub unreachable 3 min" note). */
export function minutesSince(iso: string | null | undefined, now: number): number | null {
    if (!iso) return null;
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    return Math.max(1, Math.round((now - at) / 60_000));
}

/** An action's `fleet.sessionGit.actions.labels.*` key (the ids are camelCase already). */
export function actionLabelKey(id: FleetSessionActionId, _update?: { number: number } | null): string {
    return id;
}

/** The actions the menu lists: the offered ones, in the platform's order (spec FR-15 — hidden ones never show). */
export function menuActions(actions: readonly FleetSessionActionAvailability[]): FleetSessionActionAvailability[] {
    return actions.filter((action) => action.available);
}

/** How a ledger row's cost reads (spec FR-21): unknown until the usage scan, "session total only" for owner sessions. */
export function ledgerCostText(
    entry: Pick<FleetSessionActionLedgerEntry, 'tokens' | 'costCents' | 'costScope'>,
): { kind: 'unknown' } | { kind: 'sessionTotal' } | { kind: 'known'; tokens: string; cost: string } {
    if (entry.costScope === 'session-total') return { kind: 'sessionTotal' };
    if (entry.tokens === null || entry.costCents === null) return { kind: 'unknown' };
    const tokens = entry.tokens >= 1000 ? `${(entry.tokens / 1000).toFixed(1)}k` : String(entry.tokens);
    return { kind: 'known', tokens, cost: `$${(entry.costCents / 100).toFixed(2)}` };
}

/** A hidden reason → its `fleet.sessionGit.actions.reasons.*` key (`not-in-checkout` → `notInCheckout`). */
export function hiddenReasonKey(reason: string): string {
    return reason.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/**
 * May a worktree be cleaned up (spec FR-25)? A worktree that is there, whose
 * pull request is merged or closed, and that no live session uses. The
 * platform checks it again (`?cleanUp=1`); this only decides whether the
 * button shows.
 */
export function canCleanUp(input: {
    kind: string;
    state: string;
    pr: Pick<FleetGitLinePullRequest, 'state'> | null | undefined;
    sessionLive: boolean;
}): boolean {
    if (input.kind !== 'worktree' || input.state !== 'ready' || input.sessionLive) return false;
    return input.pr?.state === 'merged' || input.pr?.state === 'closed';
}
