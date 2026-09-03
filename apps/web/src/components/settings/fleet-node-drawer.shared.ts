import { isFleetJobActive, type FleetJobView } from '@ever-works/contracts';

/**
 * Node drawer — job-history presentation rules, as pure functions.
 *
 * The drawer used to list only the failed subset and only by kind and
 * attempt count. Everything an operator needs to answer "what happened
 * to my run on this machine" — when it started, how long it took, why it
 * is still queued — was on the wire and dropped on the floor. These
 * helpers turn the raw `FleetJobView` fields into the derived facts the
 * rows render, so each derivation is testable without a DOM.
 */

/** The drawer's job filter. `running` means "a node holds a claim". */
export type FleetJobFilter = 'all' | 'failed' | 'running';

/** Canonical filter order — the chips render from this list. */
export const FLEET_JOB_FILTERS: readonly FleetJobFilter[] = ['all', 'failed', 'running'];

/**
 * Apply the drawer filter.
 *
 * `running` includes `leased` on purpose: a leased job is one a node has
 * claimed and not yet acknowledged, which from the outside is "in
 * flight" — hiding it would make a node that just picked up work look
 * idle for the seconds between lease and first heartbeat. The contract's
 * own `isFleetJobActive` draws that line, so this cannot drift from what
 * "busy" means in the node table.
 */
export function filterFleetJobs(
    jobs: readonly FleetJobView[],
    filter: FleetJobFilter,
): FleetJobView[] {
    switch (filter) {
        case 'failed':
            return jobs.filter((job) => job.status === 'failed');
        case 'running':
            return jobs.filter((job) => isFleetJobActive(job.status));
        default:
            return [...jobs];
    }
}

/**
 * Wall-clock duration of one job in milliseconds, or null when it has
 * not started.
 *
 * A job that started and has not completed is measured against `now`
 * (injected, so the value is deterministic in tests): a running job's
 * duration IS its elapsed time, and rendering nothing for it would hide
 * exactly the number that tells an operator a job is stuck. Negative
 * spans (clock skew between the two stamps) clamp to zero rather than
 * rendering as a bug.
 *
 * `startedAt` is the FIRST attempt's start: the API keeps it across
 * re-leases (`FleetJobService.lease` reuses `job.startedAt`; reclaim
 * never resets it), so a job on its second attempt reports the
 * wall-clock age since it first ran, not since this node picked it up.
 * That is the number an operator asking "how long has this been going
 * on" wants; per-attempt timing would need the API to reset the stamp.
 */
export function fleetJobDurationMs(job: FleetJobView, now: number = Date.now()): number | null {
    if (!job.startedAt) return null;
    const started = new Date(job.startedAt).getTime();
    if (!Number.isFinite(started)) return null;
    const ended = job.completedAt ? new Date(job.completedAt).getTime() : now;
    if (!Number.isFinite(ended)) return null;
    return Math.max(0, ended - started);
}

/**
 * Compact duration: `820ms`, `12s`, `4m 12s`, `1h 3m`.
 *
 * Same shape as the run-history formatters elsewhere in the dashboard;
 * the hour tier is added because a fleet job (a full build, a long
 * acceptance suite) can legitimately run that long and "94m 12s" reads
 * worse than "1h 34m". Null for an unknown span so the caller renders a
 * dash rather than "0ms", which would read as "finished instantly".
 */
export function formatFleetJobDuration(ms: number | null | undefined): string | null {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
    const hours = Math.floor(totalMinutes / 60);
    return `${hours}h ${totalMinutes % 60}m`;
}
