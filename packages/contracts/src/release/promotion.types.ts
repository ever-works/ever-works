/**
 * The release promotion lane — `develop → stage → main` (self-build
 * slice AI, EW-808).
 *
 * ## What this file is
 *
 * The house release flow moves a batch forward one rung at a time by
 * opening a pull request from one long-lived branch to the next. Nothing
 * in the platform modelled that: a Task's pull request goes from a Task
 * branch to ONE base branch (`Work.taskIsolationBaseBranch`), which
 * cannot express a ladder, and the deploy surface refuses a Repository
 * Work outright.
 *
 * These are the zero-dependency pieces both halves of the lane must
 * agree on byte-for-byte — the API that opens a promotion, and the
 * merge-gate guard that decides whether one may be merged. Two
 * implementations of `resolvePromotionBranches` is how a promotion opens
 * against the wrong branch.
 *
 * ## What this file deliberately is NOT
 *
 * It is not a cascade. There is no "next rung" function here, no
 * `advance()`, and nothing that maps a completed promotion onto the one
 * after it. That absence is the point: the founder performs each rung
 * deliberately, per batch, after reading the end-to-end verdict, because
 * the stage e2e gate has been unreliable for weeks and a bad promotion
 * is a multi-hour outage on a build lane measured at 215–243 minutes.
 * `PROMOTION_RUNGS` is ORDERED so a human reading a list sees the ladder;
 * it is not an iteration the platform walks.
 */

/**
 * One rung of the ladder. The value names both ends, so a row, a log
 * line and a Task label all say which promotion this is without a
 * lookup.
 *
 * There is no `develop-to-main`: skipping `stage` is the exact mistake
 * the lane exists to make hard.
 */
export type PromotionRung = 'develop-to-stage' | 'stage-to-main';

/**
 * The ladder, in order, for display and for validation.
 *
 * ORDERED FOR READING, NOT FOR WALKING. Nothing in the platform consumes
 * `PROMOTION_RUNGS[i + 1]`; a second promotion is a separate,
 * separately-approved act. See the file header.
 */
export const PROMOTION_RUNGS = ['develop-to-stage', 'stage-to-main'] as const satisfies readonly PromotionRung[];

/** Narrowing guard for a rung arriving from a request body or a column. */
export function isPromotionRung(value: unknown): value is PromotionRung {
	return typeof value === 'string' && (PROMOTION_RUNGS as readonly string[]).includes(value);
}

/**
 * The three long-lived branches, as PLATFORM STATE.
 *
 * Stored on the Work (`works.releaseLadder`) and never accepted from the
 * caller who asks for a promotion: a request that could name its own
 * branches could open `attacker-branch → main` and call it a release.
 * The caller picks a RUNG; the branches come from here.
 */
export interface ReleaseLadder {
	/** Where merged work lands first. `develop` in this repository. */
	readonly integration: string;
	/** The rehearsal branch. `stage`. */
	readonly staging: string;
	/** Production. `main`. */
	readonly production: string;
}

/**
 * Longest branch name accepted into a ladder. Matches the physical width
 * of `works.taskIsolationBaseBranch`, so the two branch-shaped columns on
 * a Work cannot disagree about what fits.
 */
export const RELEASE_BRANCH_MAX_LENGTH = 128;

/**
 * Branch names a ladder may contain. Deliberately narrower than git's
 * own rules: a release branch in this platform is a plain, boring,
 * long-lived name. Refusing `..`, a leading `-`, whitespace, `~^:?*[\`
 * and a trailing `.lock` keeps a ladder value from ever being read as a
 * refspec, an option, or a path escape by anything downstream.
 */
const RELEASE_BRANCH_PATTERN = /^(?!-)(?!\/)[A-Za-z0-9._\-/]+$/;

function normalizeBranch(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > RELEASE_BRANCH_MAX_LENGTH) return null;
	if (!RELEASE_BRANCH_PATTERN.test(trimmed)) return null;
	if (trimmed.includes('..') || trimmed.includes('//')) return null;
	if (trimmed.endsWith('/') || trimmed.endsWith('.lock')) return null;
	return trimmed;
}

/**
 * Read a stored / submitted ladder, or `null` when it is not one.
 *
 * FAILS CLOSED in every direction. A Work with no ladder, a partial
 * ladder, a ladder with a branch name this platform will not vouch for,
 * or a ladder whose rungs are not three DISTINCT branches, has no
 * promotion lane at all — the service refuses rather than guessing
 * `main`. Guessing is how a promotion opens against production.
 */
export function sanitizeReleaseLadder(raw: unknown): ReleaseLadder | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const candidate = raw as Record<string, unknown>;
	const integration = normalizeBranch(candidate.integration);
	const staging = normalizeBranch(candidate.staging);
	const production = normalizeBranch(candidate.production);
	if (!integration || !staging || !production) return null;
	// Three distinct branches. `develop → develop` is not a promotion, and
	// `stage === main` would make the second rung a no-op that still asked
	// a human to approve a production merge.
	if (new Set([integration, staging, production]).size !== 3) return null;
	return { integration, staging, production };
}

/** The head/base pair one rung promotes. */
export interface PromotionBranches {
	/** Branch being promoted FROM — the pull request's head. */
	readonly head: string;
	/** Branch being promoted INTO — the pull request's base. */
	readonly base: string;
}

/**
 * THE branch resolution. One function, so the opener and every later
 * verification agree about what a promotion is for.
 *
 * `null` when the ladder is unusable — never a partially-resolved pair.
 */
export function resolvePromotionBranches(
	ladder: ReleaseLadder | null | undefined,
	rung: PromotionRung
): PromotionBranches | null {
	const safe = sanitizeReleaseLadder(ladder);
	if (!safe) return null;
	switch (rung) {
		case 'develop-to-stage':
			return { head: safe.integration, base: safe.staging };
		case 'stage-to-main':
			return { head: safe.staging, base: safe.production };
		default:
			return null;
	}
}

// ── Task labelling ───────────────────────────────────────────────────
//
// A promotion Task is an ordinary Task carrying two labels. Labels rather
// than a new `kind` column because the Task entity has no discriminator
// today and adding one would touch every Task read in the product for a
// feature two rows a week use — and because the merge gate needs a
// FAIL-CLOSED answer to "is this a promotion?" even when the promotion
// service itself is not wired, which a label on the row it already loaded
// gives it for free.

/** Present on every promotion Task. */
export const PROMOTION_TASK_LABEL = 'release:promotion';

/** Per-rung label, e.g. `release:promotion:stage-to-main`. */
export function promotionRungLabel(rung: PromotionRung): string {
	return `${PROMOTION_TASK_LABEL}:${rung}`;
}

/** The labels a promotion Task is filed with. */
export function promotionTaskLabels(rung: PromotionRung): string[] {
	return [PROMOTION_TASK_LABEL, promotionRungLabel(rung)];
}

/**
 * Is this Task a promotion?
 *
 * Used by the merge gate to fail CLOSED when the promotion service is not
 * bound: a Task that says it is a promotion, in a deployment that cannot
 * evaluate promotions, must not be merged by the ordinary agent path.
 */
export function isPromotionTask(labels: readonly string[] | null | undefined): boolean {
	return Array.isArray(labels) && labels.includes(PROMOTION_TASK_LABEL);
}

/** Which rung a promotion Task is, or `null` if it is not one. */
export function promotionRungFromLabels(labels: readonly string[] | null | undefined): PromotionRung | null {
	if (!isPromotionTask(labels)) return null;
	for (const rung of PROMOTION_RUNGS) {
		if (labels!.includes(promotionRungLabel(rung))) return rung;
	}
	return null;
}

// ── Lane occupancy ───────────────────────────────────────────────────

/** Lifecycle of one promotion row. */
export type PromotionState = 'open' | 'merged' | 'closed' | 'refused';

export const PROMOTION_STATES = ['open', 'merged', 'closed', 'refused'] as const satisfies readonly PromotionState[];

/**
 * The value `ReleasePromotion.laneKey` carries while the promotion is
 * live. See {@link promotionLaneKey}.
 */
export const PROMOTION_LANE_OPEN = 'open';

/**
 * The third column of the UNIQUE `(workId, rung, laneKey)` index — a
 * portable stand-in for a partial unique index.
 *
 * Postgres can express "at most one OPEN promotion per (Work, rung)" as
 * `CREATE UNIQUE INDEX … WHERE state = 'open'`. better-sqlite3 — which CI
 * and the e2e stack run — cannot, and a migration that behaves
 * differently on the two databases is a race that only reproduces in
 * production. So the constraint is carried in a VALUE instead: every live
 * promotion writes the same literal `'open'` and therefore collides, and
 * every terminal one writes something unique to itself and therefore does
 * not.
 *
 * This is the whole anti-duplicate guarantee. Two merges to `develop`
 * seconds apart both try to claim `(work, 'develop-to-stage', 'open')`;
 * exactly one INSERT survives, and the loser is told an open promotion
 * already exists instead of opening a competing pull request.
 */
export function promotionLaneKey(state: PromotionState, promotionId: string): string {
	if (state === 'open') return PROMOTION_LANE_OPEN;
	const id = (promotionId ?? '').trim();
	if (!id) {
		// A terminal row with no id cannot free the lane safely: writing
		// `'open'` would keep it occupied forever, and writing a constant
		// would collide with the next terminal row. Refuse loudly.
		throw new Error('A terminal promotion needs its row id to release the lane.');
	}
	return `${state}:${id}`;
}
