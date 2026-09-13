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

function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function describeFeedTime(iso: string, now: Date, locale: string): FeedRelativeTime {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return { kind: 'justNow' };
    const elapsed = Math.max(0, now.getTime() - at.getTime());

    if (elapsed < MINUTE) return { kind: 'justNow' };
    if (elapsed < HOUR) return { kind: 'minutesAgo', count: Math.floor(elapsed / MINUTE) };

    const today = startOfDay(now);
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(at);
    if (at.getTime() >= today) {
        return { kind: 'hoursAgo', count: Math.max(1, Math.floor(elapsed / HOUR)) };
    }
    if (at.getTime() >= today - DAY) return { kind: 'yesterdayAt', time };
    if (elapsed < 7 * DAY) {
        const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(at);
        return { kind: 'withinWeek', weekday, time };
    }
    return {
        kind: 'absolute',
        date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(at),
    };
}
