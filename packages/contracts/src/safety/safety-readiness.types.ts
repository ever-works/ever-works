import type { LadderedActionCategory } from './action-category.types.js';
import type { TrustRung } from './trust-rung.types.js';

/**
 * Safety rails (AW-24) — readiness, which the product COMPUTES and NEVER
 * APPLIES (FR-35, FR-36).
 *
 * A category is Ready when, over the trailing 30 days, at least 20 decisions
 * in it were answered, at least 95% were approved, none were withdrawn, and
 * no other rail refused anything in it. That is a statement about the record,
 * not an instruction: nothing in this epic may move a rung without a person,
 * and the words "Nothing graduates itself" appear on the promotion surface
 * precisely so the distinction is not left to be inferred.
 *
 * Kept in contracts so the screen renders the same arithmetic the API
 * computed, and so a test can pin every threshold at its boundary.
 */

/** The 30-day record behind one category's promotion decision. */
export interface ReadinessDto {
	category: LadderedActionCategory;
	/** All four conditions met. Advisory only — nothing reads this to act. */
	ready: boolean;
	windowDays: number;
	/** Decisions in this category that were answered in the window. */
	answered: number;
	approved: number;
	rejected: number;
	withdrawn: number;
	/** `approved / answered`, or `0` when nothing was answered. */
	approvalRate: number;
	/** Refusals by any rail other than the ladder, in this category. */
	otherRefusals: number;
	/** The rung a promotion from here would reach, or `null` at the top. */
	nextRung: TrustRung | null;
	/** Why it is not ready, as a stable code the screen turns into a sentence. */
	blockedBy: ReadinessBlocker | null;
}

/**
 * Which condition is unmet. First unmet condition in this order wins, so the
 * screen names one thing to fix rather than four.
 */
export type ReadinessBlocker = 'at-ceiling' | 'too-few-decisions' | 'approval-rate' | 'withdrawn' | 'other-refusals';

/** Closed list, for the i18n leaf lookup. */
export const READINESS_BLOCKERS: readonly ReadinessBlocker[] = Object.freeze([
	'at-ceiling',
	'too-few-decisions',
	'approval-rate',
	'withdrawn',
	'other-refusals'
] as readonly ReadinessBlocker[]);

/**
 * One answered decision, reduced to exactly what readiness reads.
 *
 * Deliberately not the approval row itself: readiness must not be able to see
 * a payload, a body or an actor, so the only thing that can reach the
 * calculation is this four-field projection.
 */
export interface ReadinessDecisionSample {
	category: LadderedActionCategory;
	outcome: 'approved' | 'rejected' | 'withdrawn';
	/** ISO-8601 or epoch millis — the window filter's only input. */
	decidedAt: string | number | Date;
}
