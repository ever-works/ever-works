/**
 * Runs ledger (AW-09) — the one definition of "a date the ledger can be
 * anchored on", shared by every edge that accepts one (the API query DTO and
 * the dashboard's URL parser).
 *
 * The `YYYY-MM-DD` shape alone is not enough: `2026-02-31` matches it, and a
 * window resolver handed an impossible day would have to guess what was
 * meant. Each edge rejects it instead, so a shared link or a hand-typed query
 * can never be answered with a window nobody asked for.
 */

const RUN_LEDGER_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `value` is a `YYYY-MM-DD` string naming a real Gregorian calendar day. */
export function isRunLedgerCalendarDate(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = RUN_LEDGER_DATE_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	// `Date.UTC` rolls an overflowing month or day into the next unit, so a
	// round trip that comes back different means the date does not exist.
	// `setUTCFullYear` keeps years 0000–0099 literal instead of mapping them to 19xx.
	const probe = new Date(0);
	probe.setUTCFullYear(year, month - 1, day);
	return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}
