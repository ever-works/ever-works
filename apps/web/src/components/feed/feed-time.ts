/**
 * Live Feed relative timestamps: `just now`, `4m ago`, `2h ago`,
 * `Yesterday 18:04`, a weekday within the last week, then a date. Pure, so
 * the boundaries are testable; the words come from translations.
 */
export type FeedRelativeTime =
    | { kind: 'justNow' }
    | { kind: 'minutesAgo'; count: number }
    | { kind: 'hoursAgo'; count: number }
    | { kind: 'yesterdayAt'; time: string }
    | { kind: 'withinWeek'; weekday: string; time: string }
    | { kind: 'absolute'; date: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Whole local calendar days from `earlier` to `later` (0 = same day). Built
 * from the date components rather than elapsed time, because a local day is
 * 23 or 25 hours long across a daylight-saving change.
 */
function calendarDaysBetween(earlier: Date, later: Date): number {
    const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((day(later) - day(earlier)) / DAY);
}

export function describeFeedTime(iso: string, now: Date, locale: string): FeedRelativeTime {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return { kind: 'justNow' };
    const elapsed = Math.max(0, now.getTime() - at.getTime());

    if (elapsed < MINUTE) return { kind: 'justNow' };
    if (elapsed < HOUR) return { kind: 'minutesAgo', count: Math.floor(elapsed / MINUTE) };

    const daysAgo = calendarDaysBetween(at, now);
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
    if (daysAgo <= 0) {
        return { kind: 'hoursAgo', count: Math.max(1, Math.floor(elapsed / HOUR)) };
    }
    if (daysAgo === 1) return { kind: 'yesterdayAt', time };
    if (daysAgo < 7) {
        const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at);
        return { kind: 'withinWeek', weekday, time };
    }
    return {
        kind: 'absolute',
        date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at),
    };
}
