import {
    HOME_COMPOSER_MAX_CHARS,
    HOME_COMPOSER_MIN_CHARS,
    HOME_COUNTER_MAX,
    HOME_TASK_TITLE_MAX_CHARS,
    type HomeBlock,
    type HomeGlance,
    type HomeSummaryDto,
} from '@ever-works/contracts';

/**
 * Home (AW-19) — pure, client-safe helpers shared by the server page, the
 * server actions and the Home components. No directive, no React, no fetch.
 * The thresholds come from `@ever-works/contracts` so the API and the web
 * never disagree about a boundary.
 */

export {
    HOME_ACTIVITY_MAX,
    HOME_ALSO_BROKEN_MAX,
    HOME_COMPOSER_CHIPS_MAX,
    HOME_COMPOSER_CHIP_TTL_MS,
    HOME_COMPOSER_COUNTER_FROM_CHARS,
    HOME_COMPOSER_MAX_CHARS,
    HOME_COMPOSER_MIN_CHARS,
    HOME_COUNTER_MAX,
    HOME_DECISIONS_PREVIEW,
    HOME_SPEND_WINDOW_DAYS,
    HOME_TASK_TITLE_MAX_CHARS,
    HOME_TODAY_DUE_MAX,
    HOME_WORKING_NOW_MAX,
    homeCapTone,
    homeRunChip,
    homeWaitingTone,
} from '@ever-works/contracts';

/** The composer field's id — the Working now empty state focuses it. */
export const HOME_COMPOSER_INPUT_ID = 'home-composer-input';

/**
 * The Today half of `Your workspace` when there is NO morning read at all —
 * the whole summary failed to load.
 *
 * `undefined` means "still loading" to `GlanceCounters`, and a skeleton that
 * never resolves is exactly the "a broken read looks like a quiet morning"
 * failure that block exists to prevent. So a missing summary is reported as a
 * FAILED block: it says what could not be read and offers the Retry.
 *
 * A summary that loaded but whose `glance` block failed already carries its own
 * failed block, so it is passed through untouched.
 */
export const GLANCE_UNAVAILABLE: HomeBlock<HomeGlance> = {
    status: 'failed',
    errorKey: 'error',
    data: null,
};

/** The Today counters to render for a given morning read (or its absence). */
export function glanceForSummary(
    summary: HomeSummaryDto | null | undefined,
): HomeBlock<HomeGlance> {
    return summary?.glance ?? GLANCE_UNAVAILABLE;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `waiting {n}m` under an hour, `{n}h` under a day, `{n}d` from a day. */
export function formatWaiting(waitingMs: number): {
    unit: 'minutes' | 'hours' | 'days';
    count: number;
} {
    const ms = Math.max(0, Number.isFinite(waitingMs) ? waitingMs : 0);
    if (ms < HOUR_MS) return { unit: 'minutes', count: Math.floor(ms / MINUTE_MS) };
    if (ms < DAY_MS) return { unit: 'hours', count: Math.floor(ms / HOUR_MS) };
    return { unit: 'days', count: Math.floor(ms / DAY_MS) };
}

/** Elapsed run time: `{n}m` under an hour, `{h}h {m}m` from an hour. */
export function formatElapsed(elapsedMs: number): { hours: number; minutes: number } {
    const totalMinutes = Math.floor(
        Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / MINUTE_MS,
    );
    return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** A counter as text: exact up to 999, `999+` beyond. */
export function formatCount(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '0';
    return value > HOME_COUNTER_MAX ? `${HOME_COUNTER_MAX}+` : String(Math.floor(value));
}

/** Morning 05:00–11:59, afternoon 12:00–17:59, evening 18:00–04:59. */
export function greetingKeyForHour(hour: number): 'morning' | 'afternoon' | 'evening' {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 18) return 'afternoon';
    return 'evening';
}

/** The hour (0–23) of `instant` on the wall clock of `timeZone`; UTC when the zone is unusable. */
export function localHour(instant: Date, timeZone: string): number {
    const read = (zone: string) =>
        Number(
            new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })
                .formatToParts(instant)
                .find((part) => part.type === 'hour')?.value ?? 0,
        );
    try {
        return read(timeZone) % 24;
    } catch {
        return read('UTC') % 24;
    }
}

/** Whether the composer may submit this text. */
export function canSubmitComposer(text: string): boolean {
    const length = text.trim().length;
    return length >= HOME_COMPOSER_MIN_CHARS && length <= HOME_COMPOSER_MAX_CHARS;
}

const SENTENCE_END = /[.!?](?=\s|$)|\n/;

/**
 * The Task title for a composer sentence: the first sentence, cut at the last
 * word boundary at or before 80 characters with a single trailing `…` when it
 * was cut. A first sentence shorter than 3 characters falls back to the whole
 * text, so `OK. Summarise the week` does not become a Task called `OK`.
 */
export function deriveTaskTitle(text: string): string {
    const whole = text.replace(/\s+/g, ' ').trim();
    const firstLine = text.trim();
    const end = firstLine.search(SENTENCE_END);
    const firstSentence = (end >= 0 ? firstLine.slice(0, end) : firstLine)
        .replace(/\s+/g, ' ')
        .trim();
    const source = firstSentence.length >= HOME_COMPOSER_MIN_CHARS ? firstSentence : whole;
    if (source.length <= HOME_TASK_TITLE_MAX_CHARS) return source;

    const budget = HOME_TASK_TITLE_MAX_CHARS - 1; // room for the ellipsis
    const slice = source.slice(0, budget + 1);
    const boundary = slice.lastIndexOf(' ');
    const cut = (boundary > 0 ? slice.slice(0, boundary) : source.slice(0, budget)).trimEnd();
    return `${cut}…`;
}
