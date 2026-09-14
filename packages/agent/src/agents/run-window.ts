import {
    isRunLedgerCalendarDate,
    RUN_LEDGER_GRANULARITIES,
    RUN_LEDGER_REACH_BACK_MONTHS,
    RUN_LEDGER_REACH_FORWARD_DAYS,
    type RunLedgerGranularity,
    type RunLedgerWindow,
} from '@ever-works/contracts';

/**
 * Runs ledger (AW-09) — calendar window resolution.
 *
 * Pure and dependency-free (no TypeORM, no Nest) so the API, a CLI or a
 * test can all resolve "this week in Asia/Tokyo" to the same two instants.
 * The server is the single place a window is computed: clients send a
 * granularity, an anchor date and a timezone, never raw instants, so a
 * client clock or a hand-crafted range can never widen what is read.
 *
 * Calendar maths happens on `YYYY-MM-DD` strings (timezone-free), and only
 * the final "local midnight → UTC instant" step consults the timezone, so a
 * DST transition shortens or lengthens that one day instead of shifting
 * every boundary after it.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is `timezone` an IANA zone the runtime can format in? */
export function isValidTimezone(timezone: unknown): timezone is string {
    if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 64) {
        return false;
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

/**
 * A calendar date string, or null when it is not a real `YYYY-MM-DD` date.
 *
 * Validity is the shared contracts predicate — the same one the API query
 * DTO and the dashboard URL parser apply — so a date an edge accepts is
 * never one the resolver silently reads as "no anchor".
 */
export function parseCalendarDate(value: unknown): { y: number; m: number; d: number } | null {
    if (!isRunLedgerCalendarDate(value)) return null;
    const match = DATE_PATTERN.exec(value);
    if (!match) return null;
    return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function formatCalendarDate(y: number, m: number, d: number): string {
    // Normalise through Date.UTC so month/day overflow rolls over correctly.
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toISOString().slice(0, 10);
}

/** Add whole days to a calendar date string. */
export function addCalendarDays(date: string, days: number): string {
    const parts = parseCalendarDate(date);
    if (!parts) throw new RangeError(`Invalid calendar date: ${date}`);
    return formatCalendarDate(parts.y, parts.m, parts.d + days);
}

/** Add whole months, clamping the day to the target month's length (31 Mar − 1 month = 28/29 Feb). */
export function addCalendarMonths(date: string, months: number): string {
    const parts = parseCalendarDate(date);
    if (!parts) throw new RangeError(`Invalid calendar date: ${date}`);
    const firstOfTarget = new Date(Date.UTC(parts.y, parts.m - 1 + months, 1));
    const lastDay = new Date(
        Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return formatCalendarDate(
        firstOfTarget.getUTCFullYear(),
        firstOfTarget.getUTCMonth() + 1,
        Math.min(parts.d, lastDay),
    );
}

/** The calendar date of `instant` as seen in `timezone`. */
export function calendarDateInTimezone(instant: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(instant);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset of `timezone` from UTC at `instant`, in milliseconds (east positive). */
function timezoneOffsetMs(instant: number, timezone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour') % 24,
        get('minute'),
        get('second'),
    );
    // Drop sub-second noise from `instant` so the difference is whole seconds.
    return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The UTC instant at which `date` begins (local 00:00) in `timezone`.
 *
 * Two-pass offset correction: the first guess uses the offset at UTC
 * midnight, the second re-reads the offset at the guessed instant, which
 * is what lands on the right side of a DST change happening that night.
 */
export function startOfCalendarDate(date: string, timezone: string): Date {
    const parts = parseCalendarDate(date);
    if (!parts) throw new RangeError(`Invalid calendar date: ${date}`);
    const wallClock = Date.UTC(parts.y, parts.m - 1, parts.d);
    const firstGuess = wallClock - timezoneOffsetMs(wallClock, timezone);
    const secondGuess = wallClock - timezoneOffsetMs(firstGuess, timezone);
    return new Date(secondGuess);
}

/** Monday of the ISO week containing `date`. */
export function startOfIsoWeek(date: string): string {
    const parts = parseCalendarDate(date);
    if (!parts) throw new RangeError(`Invalid calendar date: ${date}`);
    const weekday = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay(); // 0 = Sunday
    const sinceMonday = (weekday + 6) % 7;
    return addCalendarDays(date, -sinceMonday);
}

/** First day of the calendar month containing `date`. */
export function startOfCalendarMonth(date: string): string {
    return `${date.slice(0, 8)}01`;
}

export interface ResolveRunWindowInput {
    granularity?: RunLedgerGranularity | string | null;
    /** `YYYY-MM-DD` in `timezone`; defaults to today there. */
    date?: string | null;
    /** IANA timezone; an unknown or missing value falls back to UTC. */
    timezone?: string | null;
    /** Injected clock for tests. */
    now?: Date;
}

/** The reachable anchor-date range for "today" in `timezone`. */
export function reachableRange(now: Date, timezone: string): { earliest: string; latest: string } {
    const today = calendarDateInTimezone(now, timezone);
    return {
        earliest: addCalendarMonths(today, -RUN_LEDGER_REACH_BACK_MONTHS),
        latest: addCalendarDays(today, RUN_LEDGER_REACH_FORWARD_DAYS),
    };
}

/**
 * Resolve a granularity + anchor date + timezone to a half-open `[from, to)`
 * window. The anchor is clamped into the reachable range (12 months back,
 * 7 days forward) and `clamped` says so; an invalid date anchors on today.
 */
export function resolveRunWindow(input: ResolveRunWindowInput = {}): RunLedgerWindow {
    const now = input.now ?? new Date();
    const timezone = isValidTimezone(input.timezone) ? input.timezone : 'UTC';
    const granularity: RunLedgerGranularity = (
        RUN_LEDGER_GRANULARITIES as readonly string[]
    ).includes(input.granularity ?? '')
        ? (input.granularity as RunLedgerGranularity)
        : 'day';

    const { earliest, latest } = reachableRange(now, timezone);
    let anchorDate = parseCalendarDate(input.date)
        ? (input.date as string)
        : calendarDateInTimezone(now, timezone);
    let clamped = false;
    if (anchorDate < earliest) {
        anchorDate = earliest;
        clamped = true;
    } else if (anchorDate > latest) {
        anchorDate = latest;
        clamped = true;
    }

    let startDate: string;
    let endDate: string;
    if (granularity === 'week') {
        startDate = startOfIsoWeek(anchorDate);
        endDate = addCalendarDays(startDate, 7);
    } else if (granularity === 'month') {
        startDate = startOfCalendarMonth(anchorDate);
        endDate = addCalendarMonths(startDate, 1);
    } else {
        startDate = anchorDate;
        endDate = addCalendarDays(anchorDate, 1);
    }

    return {
        granularity,
        anchorDate,
        from: startOfCalendarDate(startDate, timezone).toISOString(),
        to: startOfCalendarDate(endDate, timezone).toISOString(),
        timezone,
        clamped,
    };
}
