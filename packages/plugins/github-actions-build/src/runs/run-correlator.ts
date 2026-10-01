import type { ActionsRun, ActionsRunsPort, ActionsRepositoryRef } from './actions-runs.port.js';

/**
 * APW-05 T12 — correlating a dispatch to the run it started.
 *
 * ## The problem this solves
 *
 * `POST .../dispatches` answers **204 with no body**. GitHub tells you nothing
 * about the run it just created, so a dispatched Build has no `providerRunId`
 * until something finds it. Everything downstream — observing the run,
 * cancelling it, reading its minutes, reading its result artifact — is addressed
 * by that id, so this is the first thing that has to work.
 *
 * ## How the run is identified, and why it is not "the newest one"
 *
 * The generated workflow carries
 * `run-name: Ever Works build ${{ inputs.ew_build_id || ... }}`
 * (`workflow/generator.ts:374`), and GitHub surfaces that rendered value as the
 * run's `display_title`. So the Build id is IN the run, put there by the file
 * this plugin wrote, and a match on it is exact.
 *
 * "The newest run of this workflow" would be wrong in a way that is hard to see
 * and expensive when it happens: two Builds of the same App Work dispatched
 * seconds apart would each adopt the other's run, and the platform would then
 * cancel, bill and report against the wrong one.
 *
 * ## The two windows
 *
 * - **{@link DISPATCH_CLOCK_SKEW_MS} before the dispatch.** A run whose
 *   `created_at` is fractionally EARLIER than the moment we recorded the
 *   dispatch is still ours: the two clocks are GitHub's and ours, and they are
 *   not the same clock. Five seconds is the plan's number (§2.3, "dispatch-time
 *   window −5 s").
 * - **{@link ADOPTION_WINDOW_MS} after it.** A `display_title` match outside
 *   five minutes is not adopted, because a Build id is not guaranteed unique
 *   across a re-dispatch of the same Build, and adopting a run from an older
 *   attempt would report a stale result as the current one.
 *
 * Both bounds are inclusive: a run created exactly at the edge is inside.
 */

/** Plan §2.3 — a run created up to 5 s before the recorded dispatch is still this dispatch's. */
export const DISPATCH_CLOCK_SKEW_MS = 5_000;

/** Plan §2.3 — a `display_title` match more than 5 minutes after the dispatch is not adopted. */
export const ADOPTION_WINDOW_MS = 300_000;

/** How many of the workflow's newest runs are searched for the match. */
export const CORRELATION_PAGE_SIZE = 20;

/** What {@link correlateDispatchedRun} answers. */
export interface CorrelationResult {
	/** The adopted run's id, or `null` when no run matched inside the windows. */
	readonly providerRunId: string | null;
	/** Why, when nothing matched — for the caller's log, never for a user. */
	readonly reason?: 'noMatch' | 'outsideWindow';
}

/**
 * Does this run's `display_title` name that Build?
 *
 * A `contains` and not an equality: the rendered title is
 * `Ever Works build <id>`, and pinning the whole string here would couple this
 * file to the generator's prose. The Build id is a uuid, so a substring match on
 * it is not loose.
 */
export function titleNamesBuild(run: ActionsRun, buildId: string): boolean {
	const title = (run.display_title ?? '').trim();
	return title.length > 0 && buildId.length > 0 && title.includes(buildId);
}

/** The instant a run was created, in epoch ms; `null` when GitHub reported none. */
function createdAtMs(run: ActionsRun): number | null {
	const raw = run.created_at ?? run.run_started_at ?? null;
	if (!raw) return null;
	const at = Date.parse(raw);
	return Number.isNaN(at) ? null : at;
}

/**
 * Find the run a dispatch started.
 *
 * Searches the workflow's newest {@link CORRELATION_PAGE_SIZE} runs for one
 * whose `display_title` names `buildId` and whose creation time falls inside the
 * two windows above. The newest such run wins, which matters for a re-dispatched
 * Build: runs come back newest-first, so the first match is the current attempt.
 *
 * `null` is a legitimate answer and NOT an error: a dispatch that has not
 * produced a run yet is the normal state for the first second or two, and the
 * caller polls. A caller that treats `null` as a failure would fail every Build.
 */
export async function correlateDispatchedRun(
	port: ActionsRunsPort,
	input: {
		readonly repository: ActionsRepositoryRef;
		readonly workflowFile: string;
		readonly buildId: string;
		/** When the dispatch was recorded, in epoch ms. */
		readonly dispatchedAtMs: number;
	}
): Promise<CorrelationResult> {
	const runs = await port.listWorkflowRuns({
		repository: input.repository,
		workflowFile: input.workflowFile,
		perPage: CORRELATION_PAGE_SIZE
	});

	const named = runs.filter((run) => titleNamesBuild(run, input.buildId));
	if (named.length === 0) {
		return { providerRunId: null, reason: 'noMatch' };
	}

	const earliest = input.dispatchedAtMs - DISPATCH_CLOCK_SKEW_MS;
	const latest = input.dispatchedAtMs + ADOPTION_WINDOW_MS;

	for (const run of named) {
		const created = createdAtMs(run);
		// A run whose creation time GitHub did not report cannot be placed in the
		// window. It is NOT adopted: adopting it would be guessing, and the next
		// poll will see the same run with a timestamp.
		if (created === null) continue;
		if (created >= earliest && created <= latest) {
			return { providerRunId: String(run.id) };
		}
	}

	// The title matched but every match is outside the window — a run from an
	// earlier attempt of the same Build id. Reported separately from `noMatch`
	// because it means something different to whoever reads the log: the Build
	// HAS run before, and this dispatch has not produced its run yet.
	return { providerRunId: null, reason: 'outsideWindow' };
}
