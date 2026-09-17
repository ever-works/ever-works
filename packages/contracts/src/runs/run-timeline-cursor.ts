/**
 * Session detail (Feature K) — the one definition of "a run-timeline
 * cursor", shared by every edge that mints, validates, parses or consumes
 * one: the API query DTO, the controller's parser and the store's keyset
 * predicate.
 *
 * A cursor is the opaque `<epochMillis>_<tieBreak>` token the previous
 * page's `nextCursor` carried. The tie-break half is whichever column the
 * store orders equal timestamps by, and there are exactly TWO such
 * columns, so exactly two tie-break shapes exist:
 *
 * - an INTEGER insertion-order key (the engine `rowid`) on the sqlite
 *   family, where `@CreateDateColumn()` is whole-second text and ids are
 *   random uuid v4 — insertion order is the only chronological order
 *   available inside one second;
 * - the row's own UUID id on every other driver, where the timestamp is
 *   sub-second and the id IS the tie-break column.
 *
 * Both shapes are accepted on every driver, so a cursor a browser minted
 * before the integer form existed keeps working mid-session: the store
 * honours a shape ITS driver cannot compare as "the start of the
 * millisecond the cursor names", which may repeat rows the caller already
 * has (every consumer de-duplicates on row id) but can never skip one.
 *
 * Why the set is closed HERE rather than loosely at each edge: a
 * tie-break that is neither an integer nor a uuid is a value no store's
 * tie-break column can hold, and on Postgres binding one against the
 * `uuid` primary key raises `invalid input syntax for type uuid` — an
 * HTTP 500 for a request that should have been a clean 400. Validating
 * the token against the same closed set the store knows how to consume is
 * what keeps the edge and the store in agreement.
 */

/** The integer insertion-order tie-break (`rowid`) the sqlite family hands out. */
export const AGENT_RUN_TIMELINE_TIE_BREAK_PATTERN = /^\d{1,19}$/;

/** The uuid row-id tie-break every other driver hands out. */
export const AGENT_RUN_TIMELINE_ROW_ID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The whole `<epochMillis>_<tieBreak>` token, for edge validation.
 *
 * Spelled out rather than composed from the two patterns above so it stays
 * a literal a `@Matches()` decorator can carry and a reader can check by
 * eye; `run-timeline-cursor.spec.ts` pins the three in step.
 */
export const AGENT_RUN_TIMELINE_CURSOR_PATTERN =
	/^\d{1,15}_(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{1,19})$/;

/**
 * True when a cursor's tie-break half is the integer insertion-order form,
 * i.e. the shape only the sqlite family's `rowid` column can hold.
 *
 * The store asks this to decide whether the half in hand is a position its
 * OWN tie-break column can be compared against, so the answer here and the
 * shape accepted at the edge can never drift apart.
 */
export function isAgentRunTimelineInsertionOrderTieBreak(value: string): boolean {
	return AGENT_RUN_TIMELINE_TIE_BREAK_PATTERN.test(value);
}
