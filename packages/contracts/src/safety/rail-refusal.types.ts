import type { ActionCategory } from './action-category.types.js';
import type { SafetyRailId, SafetyReasonCode } from './safety-rail.types.js';

/**
 * Safety rails (AW-24) — the durable record of what the rails stopped.
 *
 * Today a refusal is an exception, a log line, and sometimes a rejected
 * approval row. There is no queryable answer to "what did the rails stop this
 * month?" — which is the evidence behind every guarantee on the Safety screen
 * and the input to readiness.
 *
 * It is deliberately **not** an Activity record. A misconfigured agent can
 * produce hundreds of refusals an hour; the Live Feed must not drown, so only
 * the collapsed hourly summary reaches it (FR-68).
 *
 * A row never carries a credential, an email body, a document body or a
 * command's arguments — at most a 500-character summary plus the identifying
 * parameters (FR-70).
 */

/** A refusal stops the action; a hold parks it for a person. */
export type RailRefusalVerdict = 'refused' | 'held';

/** What the refusal was about. */
export type RailRefusalSubjectType = 'run' | 'agent' | 'mission' | 'task' | 'schedule' | 'trigger';

/** The closed list, for DTO validation and filter chips. */
export const RAIL_REFUSAL_SUBJECT_TYPES: readonly RailRefusalSubjectType[] = Object.freeze([
	'run',
	'agent',
	'mission',
	'task',
	'schedule',
	'trigger'
] as readonly RailRefusalSubjectType[]);

/** One recorded refusal or hold, as the API returns it. */
export interface RailRefusalDto {
	id: string;
	railId: SafetyRailId;
	/** `null` only for a `taxonomy` row — an action nothing classified. */
	category: ActionCategory | null;
	verdict: RailRefusalVerdict;
	reasonCode: SafetyReasonCode;
	subjectType: RailRefusalSubjectType;
	subjectId: string | null;
	agentId: string | null;
	runId: string | null;
	/** Credential-free, ≤ 500 characters. */
	summary: string;
	/** Identifying parameters only — never a body. */
	requested: Record<string, unknown> | null;
	/** What the rail allowed, for the "requested vs ceiling" line. */
	ceiling: Record<string, unknown> | null;
	/** The decision this hold raised, when it raised one. */
	proposalId: string | null;
	createdAt: string;
}

/**
 * A day's worth of the same rail refusing the same agent in the same
 * category, collapsed (FR-68). `Expand` fetches the rows behind it.
 */
export interface RailRefusalGroupDto {
	collapseKey: string;
	railId: SafetyRailId;
	category: ActionCategory | null;
	agentId: string | null;
	/** Calendar day, `YYYY-MM-DD` in UTC. */
	day: string;
	count: number;
	firstAt: string;
	lastAt: string;
	/** The most recent row's summary, so the group says something concrete. */
	summary: string;
}

/** One page of the refusal log: uncollapsed rows, plus the groups above them. */
export interface RailRefusalListDto {
	items: RailRefusalDto[];
	groups: RailRefusalGroupDto[];
	nextCursor: string | null;
	/** Total rows in the window, before collapsing. */
	total: number;
}

/** Counts behind the Safety screen's header line. */
export interface RailRefusalCountsDto {
	windowDays: number;
	total: number;
	refused: number;
	held: number;
	/** Refusals whose reason was `instruction-widening-attempt` — worth reading. */
	widenAttempts: number;
	/** Refusals the platform could not write, counted in memory (FR-69). */
	unrecorded: number;
}
