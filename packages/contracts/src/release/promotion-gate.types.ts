/**
 * The promotion gate verdict (self-build slice AI, EW-808).
 *
 * `.github/workflows/promotion-gate.yml` is the workflow a promotion
 * waits on. This file is how its answer is read, and it exists because
 * the platform's EXISTING CI roll-up cannot answer this question.
 *
 * ## Why not `GitCiState` / `deriveCiState`
 *
 * `deriveCiState` (packages/plugin) answers "should the board's dot be
 * green?" over the whole check set for a commit, and it deliberately
 * treats `neutral`, `skipped`, `stale` and `cancelled` as NON-BLOCKING —
 * a human stopped it, so it neither reds nor holds the roll-up. That is
 * the right rule for a dot and the wrong rule for a promotion:
 *
 *   - `promotion-gate.yml`'s `e2e-result` job SKIPS itself whenever the
 *     head branch is not `stage`, and a skipped job reports as SUCCESS in
 *     branch protection. The workflow file says so itself.
 *   - A gate that never ran at all contributes NOTHING to the roll-up, so
 *     a commit with other green checks rolls up `passing` while the gate
 *     is absent.
 *   - `cancelled` means somebody stopped the gate. That is an absence of
 *     a verdict, not a verdict.
 *
 * So the promotion lane reads ONE named workflow run and applies ONE
 * rule: {@link isPromotionGatePass} is true for `'success'` and for
 * nothing else. Every other reading — including "we could not tell" — is
 * not a pass. This is strictly NARROWER than the CI roll-up the merge
 * gate already applies; it never widens it.
 */

/**
 * The workflow whose verdict a promotion waits on, by FILE NAME.
 *
 * A file name rather than the workflow's display name (`Promotion Gate`)
 * or one of its job names: the display name is editable prose, the job
 * names are two separate strings that would each have to be tracked, and
 * a check-run name is what a caller would have to match against the
 * capped, unordered `checks[]` sample the PR-status read returns — which
 * cannot prove a named check is ABSENT. The file path is the workflow's
 * stable identity on every provider that has workflows at all.
 */
export const PROMOTION_GATE_WORKFLOW_FILE = 'promotion-gate.yml';

/**
 * What the promotion gate said about one commit.
 *
 * Seven values rather than a boolean because the operator's next action
 * differs for each, and because a broken lookup and a real answer must
 * never render identically (the workflow file makes the same point about
 * its own E2E lookup).
 */
export type PromotionGateVerdict =
	/** The workflow run completed and concluded `success`. THE ONLY PASS. */
	| 'success'
	/** It ran and failed (`failure`, `timed_out`, `action_required`). */
	| 'failure'
	/** A run exists for the commit and has not finished. Ask again later. */
	| 'pending'
	/** Somebody stopped the run. There is no verdict, and none is coming. */
	| 'cancelled'
	/**
	 * The run finished without evaluating (`skipped`, `neutral`, `stale`).
	 * The most dangerous reading, because branch protection renders it
	 * green — here it is explicitly not a pass.
	 */
	| 'skipped'
	/** No run of that workflow exists for that commit at all. */
	| 'absent'
	/**
	 * The lookup itself failed, or the provider cannot answer this
	 * question. A BROKEN GATE, not a verdict.
	 */
	| 'unreadable';

export const PROMOTION_GATE_VERDICTS = [
	'success',
	'failure',
	'pending',
	'cancelled',
	'skipped',
	'absent',
	'unreadable'
] as const satisfies readonly PromotionGateVerdict[];

/**
 * THE rule. `true` for an explicit success and for nothing else.
 *
 * Written as an equality against the literal rather than as a set of
 * refusals so that a verdict added later is a not-a-pass by default —
 * a new value must be argued INTO the pass set, never fall into it.
 */
export function isPromotionGatePass(verdict: PromotionGateVerdict | null | undefined): boolean {
	return verdict === 'success';
}

/**
 * Has the gate said something final about this commit?
 *
 * `pending` is the only reading worth waiting on. `absent` and
 * `unreadable` are NOT decided — they may resolve as a run appears or a
 * token is fixed — but they are handled by the caller's grace window
 * rather than here, because "no run yet" ten seconds after opening a pull
 * request and "no run, ever" twenty minutes later are the same reading
 * with very different meanings.
 */
export function isPromotionGateDecided(verdict: PromotionGateVerdict | null | undefined): boolean {
	return verdict === 'success' || verdict === 'failure' || verdict === 'cancelled' || verdict === 'skipped';
}

/**
 * How long a promotion waits on a `pending` / `absent` / `unreadable`
 * gate before it tells the human anyway.
 *
 * A run does not exist the instant a pull request opens, so filing "the
 * gate never ran" immediately would be both noisy and wrong. Twenty
 * minutes is past the promotion gate's own longest job budget
 * (`node-contract`, 20 minutes) plus queue time, so anything still
 * unresolved by then is genuinely stuck rather than slow.
 */
export const PROMOTION_GATE_DECISION_GRACE_MS = 20 * 60 * 1000;

/**
 * Has an UNDECIDED gate stayed undecided long enough to be worth telling
 * a human about?
 *
 * The behavioural half of {@link PROMOTION_GATE_DECISION_GRACE_MS}, here
 * rather than private to the lane so the constant has one meaning and one
 * test. Fails CLOSED on an unusable clock: without a recorded time there
 * is no elapsed interval to measure, and inventing one would file "the
 * gate never ran" on a pull request opened seconds ago.
 */
export function isPromotionGateDecisionOverdue(
	headRecordedAt: Date | string | number | null | undefined,
	now: Date = new Date()
): boolean {
	if (headRecordedAt === null || headRecordedAt === undefined) return false;
	const since = headRecordedAt instanceof Date ? headRecordedAt.getTime() : new Date(headRecordedAt).getTime();
	if (Number.isNaN(since)) return false;
	const at = now.getTime();
	if (Number.isNaN(at)) return false;
	return at - since >= PROMOTION_GATE_DECISION_GRACE_MS;
}

/**
 * The label `promotion-gate.yml` accepts as a deliberate, attributable
 * override of its E2E leg.
 *
 * Shared with the workflow file BY VALUE because the two must agree
 * byte-for-byte: the workflow reads it off the pull request to decide
 * whether to exit 0 despite a red or unreadable E2E, and the lane reads
 * it off the SAME pull request to tell the approving human that the leg
 * may have been waived rather than green. GitHub folds an overridden run
 * back into a plain `success` conclusion, so without this the two are
 * indistinguishable downstream — see `isPromotionGateOverridden`.
 */
export const PROMOTION_GATE_OVERRIDE_LABEL = 'override-e2e-gate';

/**
 * Is the gate's E2E leg overridden on this pull request?
 *
 * `undefined` labels mean the provider read did not report labels at all,
 * which answers `false` — the caller uses this to ADD a warning, never to
 * grant anything, so an unknown label set must not manufacture one.
 */
export function isPromotionGateOverridden(labels: readonly string[] | null | undefined): boolean {
	return Array.isArray(labels) && labels.includes(PROMOTION_GATE_OVERRIDE_LABEL);
}

/**
 * The shape this reads from a provider's workflow run. Structural on
 * purpose: `@ever-works/contracts` has no dependencies, and the provider
 * types live in `@ever-works/plugin`.
 *
 * The two vocabularies are the same strings (`GitCheckStatus` /
 * `GitCheckConclusion`). That agreement is asserted where BOTH types are
 * importable — `packages/agent/src/facades/__tests__/git.facade.workflow-run.spec.ts`
 * assigns a `GitWorkflowRun` to this interface and feeds every
 * `GitCheckStatus` / `GitCheckConclusion` member through
 * {@link promotionGateVerdictFromRun}. It is NOT asserted by the
 * plugin-side conformance suite, which covers the pull-request insight
 * reads only; an earlier version of this comment said otherwise and sent
 * readers looking for a guard that was not there.
 */
export interface PromotionGateRunReading {
	readonly status?: string | null;
	readonly conclusion?: string | null;
}

/**
 * Map one workflow run onto a verdict.
 *
 * `null` / `undefined` (no run for this commit) is `'absent'`, NOT
 * `'pending'`: the difference is whether waiting can help.
 *
 * A run that reports `completed` with no conclusion is `'unreadable'`
 * rather than being guessed at — an unrecognised answer must never be
 * laundered into a pass, and it must not be laundered into a clean
 * failure either, because those two send an operator to different places.
 */
export function promotionGateVerdictFromRun(run: PromotionGateRunReading | null | undefined): PromotionGateVerdict {
	if (!run) return 'absent';

	const status = typeof run.status === 'string' ? run.status.trim().toLowerCase() : '';
	const conclusion = typeof run.conclusion === 'string' ? run.conclusion.trim().toLowerCase() : '';

	// Not finished yet — whatever conclusion is attached is stale or empty.
	if (status && status !== 'completed') return 'pending';

	switch (conclusion) {
		case 'success':
			return 'success';
		case 'failure':
		case 'timed_out':
		case 'action_required':
			return 'failure';
		case 'cancelled':
			return 'cancelled';
		case 'skipped':
		case 'neutral':
		case 'stale':
			return 'skipped';
		case '':
			// Completed with nothing to say, or a status we could not read
			// at all. Either way the gate did not answer.
			return 'unreadable';
		default:
			// A conclusion this platform does not know. Refuse to interpret.
			return 'unreadable';
	}
}
