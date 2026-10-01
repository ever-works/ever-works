import { APP_BUILD_CHECK_NAME_PREFIX } from '@ever-works/contracts';
import type { BuildRunStatus, BuildSnapshot } from '@ever-works/plugin';
import type { ActionsJob, ActionsRun } from './actions-runs.port.js';

/**
 * APW-05 T12 — one run plus its jobs, as a {@link BuildSnapshot}.
 *
 * Plan §4.8 is the normative description; this file implements it rule for rule,
 * and the three rules that are easy to get wrong each have their own case in
 * `run-observer.spec.ts`.
 *
 * ## Only the `build` job decides the Build (R-9, FR-69)
 *
 * A generated workflow runs the `build` job **and** a matrix of
 * `Ever Works check: <name>` jobs. A failing check is a signal for APW-08, not a
 * failed Build: it never flips `status` or `conclusion`, and its failure is
 * never the Build's failure. Its MINUTES are still the member's minutes, so they
 * are counted in `billableMinutes` and reported again, separately, in
 * `checksBillableMinutes` — a subset, never an addition.
 *
 * Getting this backwards would fail Builds for lint, which is the single
 * behaviour R-9 exists to prevent.
 *
 * ## Minutes are per job, rounded up, then summed
 *
 * `ceil((completed − started) / 60 s)` **per job**, summed — not
 * `ceil(total / 60 s)`. That is how GitHub bills, and the two differ whenever
 * more than one job runs: two jobs of 61 s and 30 s are 2 + 1 = **3** minutes,
 * not `ceil(91/60) = 2`. ACC-05-20 pins exactly that arithmetic.
 *
 * ## A pull-request run reports the HEAD sha
 *
 * `run.head_sha` on a `pull_request` run is the head of the PR branch, which is
 * the commit the member pushed and the one the image is built from. Reporting a
 * merge sha would name a commit that exists in no branch.
 */

/** The job whose result IS the Build's result. */
export const BUILD_JOB_NAME = 'build';

/** Is this one of the `Ever Works check: …` matrix jobs (R-9)? */
export function isCheckJob(job: ActionsJob): boolean {
	return (job.name ?? '').startsWith(APP_BUILD_CHECK_NAME_PREFIX);
}

/** Billable minutes for one job: `ceil((completed − started) / 60 s)`, 0 when it has not finished. */
export function jobBillableMinutes(job: ActionsJob): number {
	if (!job.started_at || !job.completed_at) return 0;
	const started = Date.parse(job.started_at);
	const completed = Date.parse(job.completed_at);
	if (Number.isNaN(started) || Number.isNaN(completed) || completed <= started) return 0;
	return Math.ceil((completed - started) / 60_000);
}

/**
 * GitHub's `status` + `conclusion` as the contract's five-value
 * {@link BuildRunStatus}.
 *
 * `completed` with no conclusion answers `running`, not `succeeded`: GitHub
 * reports that combination briefly while a run settles, and calling it a success
 * would publish an image nobody built.
 */
export function toBuildRunStatus(status: string | null, conclusion: string | null): BuildRunStatus {
	if (status !== 'completed') {
		return status === 'in_progress' ? 'running' : 'queued';
	}
	switch (conclusion) {
		case 'success':
			return 'succeeded';
		case 'cancelled':
			return 'cancelled';
		case null:
		case undefined:
			return 'running';
		default:
			// `failure`, `timed_out`, `action_required`, `neutral`, `skipped`,
			// `stale` — every terminal conclusion that is not a success and not a
			// cancel is a failed Build. Listing them would mean a new GitHub
			// conclusion silently read as a success.
			return 'failed';
	}
}

/** The event that started the run, as the contract's four-value trigger. */
export function toTrigger(run: ActionsRun, mode: 'build' | 'verify'): BuildSnapshot['trigger'] {
	if (run.event === 'push') return 'push';
	if (run.event === 'pull_request') return 'pull_request';
	return mode === 'verify' ? 'verification' : 'manual';
}

/** The failing step of a job, for the snapshot's failure detail. */
export function failingStep(job: ActionsJob | undefined): { name: string; number: number } | null {
	const step = (job?.steps ?? []).find(
		(candidate) => candidate.conclusion === 'failure' || candidate.conclusion === 'timed_out'
	);
	if (!step) return null;
	return { name: (step.name ?? '').trim(), number: Number(step.number ?? 0) };
}

/** What {@link observeRun} needs beyond the run and its jobs. */
export interface ObserveRunInput {
	readonly run: ActionsRun;
	readonly jobs: readonly ActionsJob[];
	/** The Build's mode, which decides `manual` vs `verification` for a dispatched run. */
	readonly mode: 'build' | 'verify';
}

/**
 * Turn one observation of a run into a {@link BuildSnapshot}.
 *
 * Pure: no I/O, no clock, no redaction. The log tail, the failure class and the
 * result artifact are separate reads the plugin composes on top — keeping them
 * out means every rule above is provable from two recorded JSON payloads.
 */
export function observeRun({ run, jobs, mode }: ObserveRunInput): BuildSnapshot {
	const buildJob = jobs.find((job) => job.name === BUILD_JOB_NAME);
	const checkJobs = jobs.filter(isCheckJob);

	// Only the `build` job decides the Build. When the run carries no `build`
	// job at all — a checks-only workflow (§7.5) — the run's own status is used,
	// and the caller is the one that refuses to record it as a Build.
	const status = buildJob
		? toBuildRunStatus(buildJob.status ?? null, buildJob.conclusion ?? null)
		: toBuildRunStatus(run.status ?? null, run.conclusion ?? null);

	const billableMinutes = jobs.reduce((total, job) => total + jobBillableMinutes(job), 0);
	const checksBillableMinutes = checkJobs.reduce((total, job) => total + jobBillableMinutes(job), 0);

	const pullRequestNumber = (run.pull_requests ?? []).find((pr) => typeof pr?.number === 'number')?.number;

	const snapshot: Record<string, unknown> = {
		providerRunId: String(run.id),
		runAttempt: Number(run.run_attempt ?? 1),
		status,
		trigger: toTrigger(run, mode),
		branch: run.head_branch ?? '',
		// A pull-request run's `head_sha` IS the PR head — the commit the member
		// pushed, and the one the image is built from.
		commitSha: run.head_sha ?? ''
	};

	const conclusion = buildJob ? buildJob.conclusion : run.conclusion;
	if (conclusion) snapshot.conclusion = conclusion;
	if (typeof pullRequestNumber === 'number') snapshot.pullRequestNumber = pullRequestNumber;
	if (run.run_started_at) snapshot.startedAt = run.run_started_at;
	if (run.status === 'completed' && run.updated_at) snapshot.completedAt = run.updated_at;
	if (billableMinutes > 0) snapshot.billableMinutes = billableMinutes;
	// Reported even when zero IF there are check jobs: "the checks cost nothing"
	// and "there were no checks" are different facts, and the receipt shows both.
	if (checkJobs.length > 0) snapshot.checksBillableMinutes = checksBillableMinutes;
	const runnerLabel = (buildJob?.labels ?? []).find((label) => label.trim().length > 0);
	if (runnerLabel) snapshot.runnerLabel = runnerLabel;
	if (run.html_url) snapshot.logsUrl = run.html_url;

	return snapshot as unknown as BuildSnapshot;
}
