import type { ActionCategory, LadderedActionCategory } from './action-category.types.js';
import type { TrustRung } from './trust-rung.types.js';

/**
 * Safety rails (AW-24) — the stored rung, and the ladder it resolves into.
 *
 * One row per (scope, category). A row that does not exist is not "denied"
 * and not "allowed" — it is INHERIT, and the resolver falls through to the
 * next scope up and finally to the shipped default. That is the same posture
 * `tool_grants` takes, and for the same reason: the absence of a row must
 * never be a decision somebody did not make.
 *
 * Exactly three scopes resolve, least → most specific (FR-9):
 *
 *     platform default  <  Workspace  <  Agent
 *
 * with the one rule that makes it a safety property rather than a preference:
 * **a lower scope may only ever NARROW** (FR-10). A per-Agent row that would
 * raise a rung above its Workspace is refused at write time, naming the
 * Workspace rung — it is never silently dropped, because an owner who thinks
 * they widened something and did not is worse off than one who was told no.
 */

/** The two configurable scopes. The platform default is not a row. */
export type AutonomyGrantScopeType = 'workspace' | 'agent';

/** Least → most specific. The resolver sorts by this, so no caller can invert it. */
export const AUTONOMY_GRANT_SCOPE_PRECEDENCE: readonly AutonomyGrantScopeType[] = Object.freeze([
	'workspace',
	'agent'
] as readonly AutonomyGrantScopeType[]);

/** Where a resolved rung came from. */
export type LadderDecidedBy = 'default' | AutonomyGrantScopeType;

/** One stored rung, as the API returns it. Never carries a credential. */
export interface AutonomyGrantDto {
	id: string;
	scopeType: AutonomyGrantScopeType;
	scopeId: string;
	category: LadderedActionCategory;
	rung: TrustRung;
	note: string | null;
	setByUserId: string;
	createdAt: string;
	updatedAt: string;
}

/** One row of the ladder, resolved for one subject. */
export interface ResolvedLadderEntry {
	category: LadderedActionCategory;
	/** The rung in force after the narrow-only merge. */
	rung: TrustRung;
	/** Which scope decided it — the Safety tab's "narrowed here" line. */
	decidedBy: LadderDecidedBy;
	/** The rung this category may never pass (FR-11). */
	ceiling: TrustRung;
	/** Whether the ladder offers **Draft** here (FR-8). */
	draftable: boolean;
	/** Where a brand-new workspace starts. */
	defaultRung: TrustRung;
	/** The Workspace rung, when an Agent row narrowed below it. `null` otherwise. */
	workspaceRung: TrustRung | null;
	/** The row that decided, when a row did. `null` for the shipped default. */
	grantId: string | null;
	/**
	 * Whether the rails ACT on this rung, as opposed to only showing it.
	 *
	 * An explicit rung is always enforced. A shipped default is enforced only
	 * once `SHIPPED_DEFAULT_RUNG_POLICY` says so — until an approval executes
	 * the thing it held, a default of `draft` would be a dead end rather than
	 * a pause. The screen renders the difference rather than implying an
	 * enforcement that is not there.
	 */
	enforced: boolean;
}

/** The whole ladder for one subject, in {@link ACTION_CATEGORIES} order. */
export interface ResolvedLadder {
	/** `null` when this is the Workspace ladder rather than one Agent's. */
	agentId: string | null;
	entries: ResolvedLadderEntry[];
	/**
	 * True when the rungs could not be read and every laddered category was
	 * resolved to **Ask** instead (FR-18). The screen says so out loud.
	 */
	safeMode: boolean;
}

/** What a rung write asks for. The actor is never in the body — it is the session. */
export interface AutonomyGrantWriteInput {
	scopeType: AutonomyGrantScopeType;
	scopeId: string;
	category: LadderedActionCategory;
	rung: TrustRung;
	note?: string | null;
}

/** Narrowing guard for a scope type arriving from a row or a DTO body. */
export function isAutonomyGrantScopeType(value: unknown): value is AutonomyGrantScopeType {
	return typeof value === 'string' && (AUTONOMY_GRANT_SCOPE_PRECEDENCE as readonly string[]).includes(value);
}

/**
 * The read-only description of one category, as `GET /api/safety/categories`
 * returns it — the one list the screen, the API and the docs all render.
 */
export interface SafetyCategoryListDto {
	categories: Array<{
		id: ActionCategory;
		laddered: boolean;
		ceiling: TrustRung | null;
		defaultRung: TrustRung | null;
		draftable: boolean;
		i18nKey: string;
	}>;
}
