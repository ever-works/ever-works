/**
 * Record visibility vocabulary (EW-P1-3, `docs/specs/features/record-visibility/spec.md`).
 *
 * Tasks, Goals, Missions, Ideas (`work_proposals`) and Agents stay owned by their
 * user exactly as before; `visibility` ADDS who else may read an org-scoped row:
 *
 *   - `private`      — the owner and the record's participants only (today's rule).
 *   - `team`         — also the members of the record's Teams and of its Work.
 *   - `organization` — also every member of the Organization.
 *
 * Lives in `@ever-works/contracts` because the API, the agent package and the web
 * app all need the same list, and `apps/web` does not depend on `@ever-works/agent`.
 */
export const RECORD_VISIBILITIES = ['private', 'team', 'organization'] as const;

export type RecordVisibility = (typeof RECORD_VISIBILITIES)[number];

/** The column default, and what every personal-scope row reads as. */
export const DEFAULT_RECORD_VISIBILITY: RecordVisibility = 'private';

/** The aggregates that carry `visibility` / `visibilityExplicit`. */
export const VISIBILITY_AGGREGATES = ['task', 'goal', 'mission', 'idea', 'agent'] as const;

export type VisibilityAggregate = (typeof VISIBILITY_AGGREGATES)[number];

const RECORD_VISIBILITY_SET: ReadonlySet<string> = new Set<string>(RECORD_VISIBILITIES);

/** Type guard for WRITE paths. Fail closed: an unknown value is rejected, never coerced. */
export function isRecordVisibility(value: unknown): value is RecordVisibility {
	return typeof value === 'string' && RECORD_VISIBILITY_SET.has(value);
}

/**
 * Coerce a stored value for READ paths. `visibility` is a `varchar(16)`, so a row written
 * by a newer server may carry a value this build does not know; it reads as `private`,
 * the narrowest value, so an unknown value can never widen who sees a row. NEVER throws.
 */
export function normalizeRecordVisibility(value?: string | null): RecordVisibility {
	if (typeof value !== 'string') {
		return DEFAULT_RECORD_VISIBILITY;
	}
	const normalized = value.trim().toLowerCase();
	return RECORD_VISIBILITY_SET.has(normalized) ? (normalized as RecordVisibility) : DEFAULT_RECORD_VISIBILITY;
}

/**
 * The automatic visibility of a record (owner decision D11): a personal-scope record is
 * `private`; an org-scope record is `team` while it sits on at least one Team and
 * `organization` otherwise. Used for new records, by the migration backfill and for the
 * automatic narrowing/widening while `visibilityExplicit` is false.
 */
export function automaticRecordVisibility(input: {
	organizationId?: string | null;
	hasTeam: boolean;
}): RecordVisibility {
	if (!input.organizationId) {
		return 'private';
	}
	return input.hasTeam ? 'team' : 'organization';
}

/**
 * List tabs on `/tasks`, `/goals`, `/missions`, `/ideas` and `/agents`.
 *
 *   - `mine`         — rows the caller owns: exactly today's list (the default).
 *   - `shared`       — rows the caller does not own but may read: as a participant or
 *                      through a Team / Work, plus org-wide rows they take part in.
 *   - `organization` — every row of the active Organization the caller may read.
 */
export const RECORD_LIST_VIEWS = ['mine', 'shared', 'organization'] as const;

export type RecordListView = (typeof RECORD_LIST_VIEWS)[number];

export const DEFAULT_RECORD_LIST_VIEW: RecordListView = 'mine';

const RECORD_LIST_VIEW_SET: ReadonlySet<string> = new Set<string>(RECORD_LIST_VIEWS);

/** Unknown or missing values read as `mine`, so an old client keeps today's list. */
export function normalizeRecordListView(value?: string | null): RecordListView {
	if (typeof value !== 'string') {
		return DEFAULT_RECORD_LIST_VIEW;
	}
	const normalized = value.trim().toLowerCase();
	return RECORD_LIST_VIEW_SET.has(normalized) ? (normalized as RecordListView) : DEFAULT_RECORD_LIST_VIEW;
}
