import type { ActionCategory } from './action-category.types.js';
import type { TrustRung } from './trust-rung.types.js';

/**
 * Safety rails (AW-24) — the seven checks, their fixed order, and the
 * closed list of reasons any of them may give.
 *
 * Ever Works enforces all seven today. What it has never had is a published
 * ORDER: the platform stop flag, the scope pauses, tool grants, budgets and
 * merge policy each refuse in their own call site, so nobody could say which
 * one a given refusal came from, or which would win when two disagreed.
 *
 * {@link SAFETY_RAIL_ORDER} is that order, and it is DATA rather than control
 * flow for the same reason `DEFAULT_RUN_ADMISSION_CHAIN` is: the order is a
 * product promise (FR-19) and has to be assertable by a test instead of read
 * out of an `if` ladder.
 *
 * Pure and dependency-free, like everything else in this folder.
 */

/**
 * The seven rails, plus `taxonomy` — which is not a rail and is never in the
 * order. It names the classifier itself, so an action nobody classified can
 * be recorded against something (FR-3 / FR-24) rather than attributed to a
 * rail that never ran.
 */
export type SafetyRailId =
	| 'platform-stop'
	| 'workspace-pause'
	| 'scope-pause'
	| 'grants'
	| 'ladder'
	| 'caps'
	| 'rules'
	| 'taxonomy';

/**
 * The published evaluation order (FR-19). First refusal wins.
 *
 *   1. platform stop flag   — the operator's global stop
 *   2. Workspace pause      — the owner's own stop
 *   3. Agent / Mission / Run pause
 *   4. connection and tool grants
 *   5. the trust ladder
 *   6. caps
 *   7. category-specific rules (send rules, merge policy, protected branches)
 *
 * The stops come first because a stopped platform must spend no query it does
 * not have to; grants come before the ladder because "this Agent cannot call
 * this tool at all" is a narrower statement than "this kind of work waits for
 * a person"; caps and rules come last because both are expensive and both are
 * moot once something above them has refused.
 */
export const SAFETY_RAIL_ORDER: readonly SafetyRailId[] = Object.freeze([
	'platform-stop',
	'workspace-pause',
	'scope-pause',
	'grants',
	'ladder',
	'caps',
	'rules'
] as readonly SafetyRailId[]);

/**
 * Why a rail refused or held (FR-65). Closed list — a refusal the product
 * cannot name is a refusal the owner cannot act on.
 */
export type SafetyReasonCode =
	| 'platform-stopped'
	| 'workspace-paused'
	| 'scope-paused'
	| 'rung-off'
	| 'rung-held'
	| 'ceiling-refused'
	| 'cap-reached'
	| 'grant-denied'
	| 'rule-blocked'
	| 'policy-refused'
	| 'unclassified-action'
	| 'instruction-widening-attempt'
	| 'non-human-actor'
	| 'safe-mode';

/** All fourteen, in the order the product documents them. */
export const SAFETY_REASON_CODES: readonly SafetyReasonCode[] = Object.freeze([
	'platform-stopped',
	'workspace-paused',
	'scope-paused',
	'rung-off',
	'rung-held',
	'ceiling-refused',
	'cap-reached',
	'grant-denied',
	'rule-blocked',
	'policy-refused',
	'unclassified-action',
	'instruction-widening-attempt',
	'non-human-actor',
	'safe-mode'
] as readonly SafetyReasonCode[]);

/**
 * What the gate decided.
 *
 *  - `allow`   — every rail passed; the side effect happens.
 *  - `refused` — a rail said no. Nothing is prepared and nothing is queued.
 *  - `held`    — the ladder parked it for a person. A decision carries it.
 *
 * P2 gives `held` its execution half; P3 adds the Workspace pause's own
 * in-flight stop. Both are additive to this union.
 */
export type SafetyDecision = 'allow' | 'refused' | 'held';

/** What the ladder allowed, when the verdict says it did not allow this. */
export interface SafetyCeiling {
	/** The rung in force for the category. */
	rung?: TrustRung;
	/** The rung the category may never pass (FR-11). */
	ceiling?: TrustRung;
	/** Which scope decided the rung. */
	decidedBy?: string;
}

/**
 * One rail's answer — and, when nothing refused, the gate's answer.
 *
 * Deliberately a value object with no methods: it crosses the agent runtime,
 * the API and the refusal record unchanged, and anything it cannot carry as
 * data would have to be recomputed somewhere, which is how two surfaces start
 * disagreeing about why something was stopped.
 */
export interface SafetyVerdict {
	decision: SafetyDecision;
	/** Which rail decided. `null` only on a clean `allow`. */
	railId: SafetyRailId | null;
	/** The classified category, or `null` when nothing classified it. */
	category: ActionCategory | null;
	/** The rung in force, when the ladder was reached. */
	rung: TrustRung | null;
	reasonCode: SafetyReasonCode | null;
	/** Human-readable, credential-free, capped — never a body or arguments. */
	summary: string | null;
	ceiling?: SafetyCeiling | null;
	/**
	 * True when the rung / pause state could not be read and every laddered
	 * category was treated as **Ask** (FR-18).
	 */
	safeMode?: boolean;
	/** True when the classifier had no mapping for this entry point (FR-3). */
	unclassified?: boolean;
	/** The approval row raised for a `held` verdict, once P2 stores one. */
	proposalId?: string | null;
}

/** The verdict a gate that refused nothing ends on. */
export const SAFETY_ALLOW: SafetyVerdict = Object.freeze({
	decision: 'allow',
	railId: null,
	category: null,
	rung: null,
	reasonCode: null,
	summary: null
} as SafetyVerdict);

/** Narrowing guard for a reason code arriving from a row or a DTO body. */
export function isSafetyReasonCode(value: unknown): value is SafetyReasonCode {
	return typeof value === 'string' && (SAFETY_REASON_CODES as readonly string[]).includes(value);
}

/** Narrowing guard for a rail id arriving from a row, a query string or a DTO. */
export function isSafetyRailId(value: unknown): value is SafetyRailId {
	return (
		typeof value === 'string' && ((SAFETY_RAIL_ORDER as readonly string[]).includes(value) || value === 'taxonomy')
	);
}
