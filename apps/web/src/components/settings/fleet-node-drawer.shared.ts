import {
    isFleetJobActive,
    type FleetJobView,
    type FleetNodeJobHistoryEntry,
    type FleetNodeView,
} from '@ever-works/contracts';

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
export function filterFleetJobs<T extends FleetJobView>(
    jobs: readonly T[],
    filter: FleetJobFilter,
): T[] {
    switch (filter) {
        case 'failed':
            // Judged on the RECONCILED outcome (EW-776), the same rule the
            // badge on each row uses. Filtering on `job.status` alone
            // reproduced the original defect one layer up: a row showing a
            // red "Failed" badge in All, and missing from Failed.
            // `fleetJobOutcomeKey` falls back to the job status for a row
            // that carries no reconciled outcome, so a plain
            // `FleetJobView` behaves exactly as it did before.
            return jobs.filter((job) => fleetJobOutcomeKey(job) === 'failed');
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
 * `startedAt` is THIS ATTEMPT's start (EW-776). The lease CAS clears it
 * and the attempt's first job heartbeat re-stamps it, so a job on its
 * third attempt reports how long the CURRENT attempt has been running.
 * It used to be preserved across re-leases, which meant a job that had
 * lapsed twice showed "running for 4h 12m" — the age of an attempt that
 * had ended hours earlier, on a machine that might not even be the one
 * holding it now. That read as a stuck job and was not one.
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

/**
 * Fleet health signals (EW-776) — what the drawer says about the node's
 * WORKER, as opposed to its registry status.
 *
 * The two answer different questions and the drawer shows both: `status`
 * is what the platform can infer from heartbeats, `workerState` is what
 * the machine says about itself. A self-quarantined node is `online` and
 * `quarantined` at the same time, and that pair is the whole point — it
 * is precisely the combination that used to be invisible.
 */
export type FleetWorkerStateKey =
    | 'idle'
    | 'working'
    | 'paused'
    | 'quarantined'
    | 'throttled'
    | 'unknown';

/**
 * The i18n key for a node's worker state.
 *
 * `unknown` for a node that has never reported one — an older daemon, a
 * visibility-only node, or a value this build did not recognise. NEVER
 * defaulted to `idle`: a fabricated readiness for a machine we know
 * nothing about is the exact lie this feature exists to end.
 */
export function fleetWorkerStateKey(node: Pick<FleetNodeView, 'workerState'>): FleetWorkerStateKey {
    switch (node.workerState) {
        case 'idle':
        case 'working':
        case 'paused':
        case 'quarantined':
        case 'throttled':
            return node.workerState;
        default:
            return 'unknown';
    }
}

/**
 * Badge classes for a worker state.
 *
 * `quarantined` is the one that must stand out — it is a machine that
 * looks healthy and is refusing every job. `throttled` and `paused` are
 * warnings (not taking work, but by design), `working` is informational,
 * and `idle`/`unknown` stay neutral: an idle machine is not an event.
 */
export function fleetWorkerStateBadgeClass(key: FleetWorkerStateKey): string {
    switch (key) {
        case 'quarantined':
            return 'bg-danger/10 text-danger';
        case 'throttled':
        case 'paused':
            return 'bg-warning/10 text-warning';
        case 'working':
            return 'bg-info/10 text-info';
        default:
            return 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark';
    }
}

/** Outcome vocabulary for one history row — the reconciled verdict, not the job's. */
export type FleetJobOutcomeKey =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';

/**
 * What actually HAPPENED to the work this job carried.
 *
 * The reconciled run outcome wins outright when there is one, because a
 * fleet job and the Agent run it carried settle SEPARATELY: the node
 * reports a verdict on the job, then the api-side reconciler decides what
 * that meant for the run. The drawer used to show only the first, which
 * is how a job whose run had failed rendered a calm green "done".
 *
 * It wins even when it is `running` while the job says `done` — that
 * combination is a run the reconciler has not settled yet, and "still
 * running" is the true answer for the WORK. Saying "completed" there
 * would repeat the original mistake with fresher data.
 *
 * Without a reconciled outcome the job's own status is the honest answer,
 * mapped onto the same vocabulary so one badge renders both cases.
 */
export function fleetJobOutcomeKey(job: FleetNodeJobHistoryEntry): FleetJobOutcomeKey {
    switch (job.reconciled?.status) {
        case 'completed':
            return 'completed';
        case 'failed':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        case 'running':
            return 'running';
        case 'queued':
            return 'queued';
        default:
            break;
    }
    switch (job.status) {
        case 'done':
            return 'completed';
        case 'failed':
            return 'failed';
        case 'running':
        case 'leased':
            return 'running';
        case 'queued':
            return 'queued';
        default:
            return 'unknown';
    }
}

/**
 * The one sentence that explains a row, or null when there is nothing to
 * say.
 *
 * Order is deliberate: an error beats a summary (a failure's reason is
 * the thing the operator came for), the RUN's error beats the JOB's (the
 * run is the reconciled truth), and a summary is shown only when nothing
 * went wrong. Capped so a pasted stack trace cannot take over the drawer
 * — the full text lives on the run.
 */
export function fleetJobOutcomeText(job: FleetNodeJobHistoryEntry, maxLength = 240): string | null {
    const candidate = job.reconciled?.error ?? job.error ?? job.reconciled?.summary ?? null;
    if (typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
