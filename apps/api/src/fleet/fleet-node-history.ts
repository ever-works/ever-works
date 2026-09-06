import { FLEET_JOB_MAX_ERROR_LENGTH } from '@ever-works/contracts';
import type { FleetJobReconciledOutcome, FleetNodeJobHistoryEntry } from '@ever-works/contracts';
import { correlateAgentTaskJob } from './fleet-agent-task.correlation';

/**
 * Node-drawer job history — the composition rule, as a pure function.
 *
 * Three truths that slices B and E left open, and one thing the endpoint
 * must stop doing:
 *
 *  1. **The reconciled outcome.** The job row and the Agent run row settle
 *     separately: the node reports a verdict on the JOB, then the api-side
 *     reconciler decides what that meant for the RUN. The drawer showed
 *     only the first, so a job whose run had failed rendered a calm green
 *     "done" — the exact question an operator opens the drawer to answer.
 *  2. **The error text.** `fleet_jobs.error` was on the server all along
 *     and never left it: a red badge with no way to find out why, whose
 *     honest next step was "open a database".
 *  3. **A payload-free summary.** `FleetJobView.payload` is executor input
 *     — instructions, mount grants, repo coordinates, composed from user
 *     content and bounded only by `FLEET_JOB_MAX_PAYLOAD_BYTES`. It has no
 *     business being rendered in a settings drawer, so this function
 *     replaces it with `null` and hands the UI the IDENTITIES instead
 *     (task, run, agent), which is what an operator actually follows.
 *
 * Pure and separate from the controller so all three are testable without
 * a Nest module — and so the payload stripping is one line that a spec can
 * pin, rather than a habit each renderer has to remember.
 */

/** The subset of an `agent_runs` row this composer reads. */
export interface ReconcilableRun {
    id: string;
    status: string;
    summary?: string | null;
    errorMessage?: string | null;
}

/** A job as it comes off `FleetJobService.historyForNode`. */
export type NodeHistorySourceJob = FleetNodeJobHistoryEntry;

/** Run statuses the wire contract admits; anything else reads as unknown. */
const RUN_STATUSES: readonly FleetJobReconciledOutcome['status'][] = [
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
];

/**
 * The run ids a page of history correlates to — what the caller needs to
 * fetch before it can call {@link buildNodeJobHistory}.
 *
 * Deduplicated, because a retried Task can appear as several jobs carrying
 * the same run: one bulk read, not one per row.
 */
export function nodeHistoryRunIds(jobs: readonly NodeHistorySourceJob[]): string[] {
    const ids = new Set<string>();
    for (const job of jobs) {
        const correlation = correlateAgentTaskJob(job);
        if (correlation) ids.add(correlation.runId);
    }
    return [...ids];
}

/**
 * Compose the drawer's history rows.
 *
 * `runs` may be empty or partial — the run read is best-effort at the
 * edge, and a job whose run could not be read reports `reconciled: null`
 * ("not known") rather than inventing an outcome.
 */
export function buildNodeJobHistory(
    jobs: readonly NodeHistorySourceJob[],
    runs: ReadonlyMap<string, ReconcilableRun> = new Map(),
): FleetNodeJobHistoryEntry[] {
    return jobs.map((job) => {
        const correlation = correlateAgentTaskJob(job);
        const run = correlation ? runs.get(correlation.runId) : undefined;
        return {
            ...job,
            // Never rendered, never shipped. See the header.
            payload: null,
            error: truncate(job.error),
            summary: {
                kind: job.kind,
                taskId: correlation?.taskId ?? null,
                runId: correlation?.runId ?? null,
                agentId: correlation?.agentId ?? null,
            },
            reconciled: run ? toReconciledOutcome(run) : null,
        };
    });
}

/**
 * Did the work this row carried FAIL?
 *
 * The reconciled outcome wins outright, exactly as it does in the badge
 * the drawer renders (`fleetJobOutcomeKey`). Keeping `failures` on the
 * job status alone would have shipped the original defect in a new
 * place: a row rendering a red "Failed" badge in the full list while
 * being absent from the failed subset that sits right beside it.
 */
export function isFailedNodeHistoryEntry(entry: FleetNodeJobHistoryEntry): boolean {
    if (entry.reconciled) return entry.reconciled.status === 'failed';
    return entry.status === 'failed';
}

function toReconciledOutcome(run: ReconcilableRun): FleetJobReconciledOutcome {
    return {
        runId: run.id,
        // A status the contract does not know is reported as `queued`
        // rather than passed through: the field is a union on the wire, and
        // the drawer's own fallback ("unknown") covers the display side.
        status: RUN_STATUSES.includes(run.status as FleetJobReconciledOutcome['status'])
            ? (run.status as FleetJobReconciledOutcome['status'])
            : 'queued',
        summary: truncate(run.summary),
        // Capped like the job's own error, which is what
        // `FLEET_JOB_MAX_ERROR_LENGTH` exists for: an unbounded model
        // failure pasted into a settings drawer is a rendering hazard, not
        // an explanation.
        error: truncate(run.errorMessage),
    };
}

function truncate(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, FLEET_JOB_MAX_ERROR_LENGTH);
}
