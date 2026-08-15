import type { FleetRunnerNodeView, FleetRunnerStatusView } from '@ever-works/contracts';
import { summarizeRunnerStatus, type FleetRunnerSummaryState } from '@ever-works/contracts';

/**
 * Pure presentation helpers for the runner status pill.
 *
 * A `.shared.ts` file (the house convention) so these can be unit-tested
 * and imported from both a server and a client component without
 * dragging React or a `server-only` module across the boundary.
 */

export type { FleetRunnerNodeView, FleetRunnerStatusView, FleetRunnerSummaryState };
export { summarizeRunnerStatus };

/**
 * Effective per-node state for the popover row.
 *
 * `busy` is promoted ahead of the registry status because it is the more
 * specific true statement: a busy node IS online, and "Busy" answers the
 * question the operator is actually asking ("can it take my work?")
 * while "Online" leaves them to work it out from a job count.
 */
export type RunnerRowState = 'busy' | 'online' | 'offline' | 'paused' | 'disabled' | 'enrolling';

export function runnerRowState(node: FleetRunnerNodeView): RunnerRowState {
    if (node.status === 'online') {
        return node.busy ? 'busy' : 'online';
    }
    return node.status;
}

/** Tailwind class for the status dot of a given row state. */
export function runnerDotClass(state: RunnerRowState): string {
    switch (state) {
        case 'online':
            return 'bg-success';
        case 'busy':
            return 'bg-info';
        case 'enrolling':
            return 'bg-warning';
        case 'disabled':
            return 'bg-danger';
        default:
            return 'bg-text-muted dark:bg-text-muted-dark';
    }
}

/**
 * Compact human byte count: `12.4 GB`.
 *
 * Base-1000 with SI units, matching what desktop OSes report as "free
 * space" — a node's owner compares this against what Finder / Explorer
 * shows them, so agreeing with those matters more than binary purity.
 * Returns null for unknown so the caller renders a dash rather than
 * "0 B", which would read as a full disk.
 */
export function formatBytes(bytes: number | null | undefined): string | null {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    // One decimal below TB-scale, none for raw bytes: "1.5 GB" is useful,
    // "1.5 B" is noise.
    const decimals = unit === 0 ? 0 : value < 10 ? 1 : 0;
    return `${value.toFixed(decimals)} ${units[unit]}`;
}

/**
 * Coarse relative time in whole units, e.g. `{ unit: 'minute', value: 4 }`.
 *
 * Returns the SHAPE rather than a string so the caller can render it
 * through `next-intl` in the viewer's locale — building "4m ago" here
 * would hard-code English into a component that ships in 21 languages.
 * Null when the timestamp is missing or unparseable.
 */
export interface RelativeTimeParts {
    unit: 'second' | 'minute' | 'hour' | 'day';
    value: number;
}

export function relativeTimeParts(
    iso: string | null | undefined,
    now: number = Date.now(),
): RelativeTimeParts | null {
    if (typeof iso !== 'string' || !iso) return null;
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return null;
    // Clamp at 0: a node whose clock runs ahead of the server must not
    // render "in 3 seconds", which reads as a bug rather than as skew.
    const deltaSec = Math.max(0, Math.floor((now - then) / 1000));
    if (deltaSec < 60) return { unit: 'second', value: deltaSec };
    if (deltaSec < 3600) return { unit: 'minute', value: Math.floor(deltaSec / 60) };
    if (deltaSec < 86_400) return { unit: 'hour', value: Math.floor(deltaSec / 3600) };
    return { unit: 'day', value: Math.floor(deltaSec / 86_400) };
}
