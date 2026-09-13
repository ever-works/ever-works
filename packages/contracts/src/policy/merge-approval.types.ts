/**
 * Merge approval — the RECORD an agent-driven merge consumes in place of
 * a hardcoded `humanApproved` literal (self-build slice AE, EW-805).
 *
 * The merge policy (`merge-policy.types.ts`) says WHETHER a human approval
 * is required. This file says what one IS, and it is deliberately the
 * narrowest possible thing: a canonical key naming exactly one pull
 * request at exactly one head commit, plus the age past which a recorded
 * decision stops counting.
 *
 * The key is the whole safety property. An approval is stored against
 * `mergeApprovalSubjectKey({ taskId, prNumber, headSha })`, and the merge
 * path re-derives that key from LIVE provider state at merge time. So a
 * decision cannot be replayed onto
 *
 *   - a different pull request (`prNumber` is in the key),
 *   - a different Task that happens to share a PR number (`taskId` is too),
 *   - or the same pull request after a force-push or a new commit
 *     (`headSha` is, and a rewritten branch has a different head).
 *
 * Zero-dependency and pure so the API, the worker and the fleet
 * reconciler all derive byte-identical keys — two implementations of this
 * function is how a stale approval becomes a merge.
 */

/** Namespace prefix so a subject key can never collide with another kind. */
const SUBJECT_PREFIX = 'merge';

/**
 * How long a recorded approval stays usable. A human who approved a green
 * pull request yesterday did not approve today's repository — branch
 * protection, the base branch and the reviewers have all had a day to
 * change underneath a decision that names none of them.
 *
 * 24h is a deliberate compromise: long enough that "approve now, the CI
 * queue is backed up" works, short enough that a forgotten approval is not
 * a standing merge permit. The head-SHA binding is the hard guarantee;
 * this is the soft one.
 */
export const MERGE_APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Physical width of `agent_action_proposals.subjectKey`. A key that would
 * be TRUNCATED by the column is refused rather than stored short — a
 * truncated head SHA is a prefix match waiting to happen.
 */
export const MERGE_APPROVAL_SUBJECT_KEY_MAX_LENGTH = 200;

/** What one recorded approval is bound to. All three are required. */
export interface MergeApprovalSubject {
	/** The Task the pull request belongs to — resolved from platform state. */
	readonly taskId: string;
	/** Provider pull-request number. */
	readonly prNumber: number;
	/** Head commit the approval was given for. */
	readonly headSha: string;
}

/**
 * Canonical form of a commit SHA, or `null` when the input is not one.
 *
 * Providers echo SHAs in mixed case and callers pass through webhooks,
 * caches and JSON columns, so the comparison is normalised in exactly one
 * place. Anything that is not a plausible hex object id — an abbreviated
 * ref, a branch name, an empty string, a SHA with a stray `refs/` prefix —
 * returns `null`, and every caller treats `null` as "unknown head", which
 * fails closed. Minimum 7 (git's own abbreviation floor) so an accidental
 * one-character value can never be accepted; maximum 64 so SHA-256 object
 * ids keep working when providers move.
 */
export function normalizeCommitSha(sha: string | null | undefined): string | null {
	if (typeof sha !== 'string') return null;
	const trimmed = sha.trim().toLowerCase();
	return /^[0-9a-f]{7,64}$/.test(trimmed) ? trimmed : null;
}

/**
 * THE key. `merge:<taskId>:<prNumber>:<headSha>`.
 *
 * Throws on an unusable subject rather than returning a partial key: a
 * caller that cannot name the head commit has nothing to look an approval
 * up by, and silently producing `merge:t:7:null` would match a row written
 * by the same bug on the other side.
 */
export function mergeApprovalSubjectKey(subject: MergeApprovalSubject): string {
	const taskId = (subject.taskId ?? '').trim();
	if (!taskId) throw new Error('A merge approval subject needs a taskId.');
	if (!Number.isInteger(subject.prNumber) || subject.prNumber <= 0) {
		throw new Error(`A merge approval subject needs a positive pull-request number, got ${subject.prNumber}.`);
	}
	const headSha = normalizeCommitSha(subject.headSha);
	if (!headSha) {
		throw new Error('A merge approval subject needs a head commit SHA.');
	}
	const key = `${SUBJECT_PREFIX}:${taskId}:${subject.prNumber}:${headSha}`;
	if (key.length > MERGE_APPROVAL_SUBJECT_KEY_MAX_LENGTH) {
		throw new Error(
			`Merge approval subject key exceeds ${MERGE_APPROVAL_SUBJECT_KEY_MAX_LENGTH} characters (${key.length}).`
		);
	}
	return key;
}

/**
 * Every key for one pull request, regardless of head — the SQL `LIKE`
 * prefix (`merge:<taskId>:<prNumber>:`).
 *
 * Used only to tell "nobody has approved this pull request" apart from
 * "somebody approved an EARLIER commit of it", which are the same refusal
 * with very different wording for the human reading it. It is never a
 * lookup an approval can be satisfied by.
 */
export function mergeApprovalPullRequestKeyPrefix(subject: Pick<MergeApprovalSubject, 'taskId' | 'prNumber'>): string {
	const taskId = (subject.taskId ?? '').trim();
	if (!taskId) throw new Error('A merge approval subject needs a taskId.');
	if (!Number.isInteger(subject.prNumber) || subject.prNumber <= 0) {
		throw new Error(`A merge approval subject needs a positive pull-request number, got ${subject.prNumber}.`);
	}
	return `${SUBJECT_PREFIX}:${taskId}:${subject.prNumber}:`;
}
