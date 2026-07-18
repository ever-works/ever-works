/**
 * Schedules ("Cadence") — provider-agnostic cadence → human-text + next-run
 * helpers. Kept server-side so every client (web, MCP) gets identical
 * strings (spec §4.4). Pure functions, never throw — malformed input
 * falls back to the raw string / null.
 */
import { RRule } from 'rrule';
import { parseCron } from '../missions/cron-matcher';
import { WorkScheduleCadence } from '../entities/types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: string | number): string {
    return String(value).padStart(2, '0');
}

function capitalize(text: string): string {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Best-effort cron → human text for the well-known cadences the platform
 * produces (minutely / hourly / daily / weekly / monthly). Anything more
 * exotic falls back to the raw 5-field expression rather than guessing.
 */
export function describeCron(expr: string | null | undefined): string {
    if (!expr) return '';
    const trimmed = expr.trim();
    if (trimmed.toLowerCase() === 'manual') return 'Manual';
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5) return trimmed;
    // Validate field ranges up-front so a malformed expression (out-of-range
    // value, zero step, etc. — e.g. '0 9 * * 8', '*/0 * * * *', '99 99 * * *')
    // falls back to the raw string rather than getting a plausible-but-wrong
    // friendly label. Raw is the documented fallback.
    try {
        parseCron(trimmed);
    } catch {
        return trimmed;
    }
    const [min, hour, dom, month, dow] = parts;
    const isLiteral = (token: string) => /^\d+$/.test(token);

    const allWild = dom === '*' && month === '*' && dow === '*';

    if (min === '*' && hour === '*' && allWild) return 'Every minute';

    const minStep = /^\*\/(\d+)$/.exec(min);
    if (minStep && hour === '*' && allWild) {
        const n = Number(minStep[1]);
        return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    }

    if (isLiteral(min) && hour === '*' && allWild) return 'Every hour';

    const hourStep = /^\*\/(\d+)$/.exec(hour);
    if (isLiteral(min) && hourStep && allWild) {
        const n = Number(hourStep[1]);
        return n === 1 ? 'Every hour' : `Every ${n} hours`;
    }

    if (isLiteral(min) && isLiteral(hour) && dom === '*' && month === '*' && dow === '*') {
        return `Every day at ${pad(hour)}:${pad(min)}`;
    }

    if (isLiteral(min) && isLiteral(hour) && dom === '*' && month === '*' && isLiteral(dow)) {
        const day = WEEKDAYS[Number(dow) % 7] ?? `day ${dow}`;
        return `Every ${day} at ${pad(hour)}:${pad(min)}`;
    }

    if (isLiteral(min) && isLiteral(hour) && isLiteral(dom) && month === '*' && dow === '*') {
        return `Monthly on day ${dom} at ${pad(hour)}:${pad(min)}`;
    }

    return trimmed;
}

/**
 * RRULE → human text via the `rrule` library's own `.toText()`. Falls
 * back to the raw rule string when the rule can't be parsed.
 */
export function describeRrule(rule: string | null | undefined): string {
    if (!rule) return '';
    try {
        return capitalize(RRule.fromString(rule).toText());
    } catch {
        return rule;
    }
}

/** Map a `WorkScheduleCadence` enum value to a human label. */
export function describeWorkCadence(
    cadence: WorkScheduleCadence | string | null | undefined,
): string {
    switch (cadence) {
        case WorkScheduleCadence.HOURLY:
            return 'Every hour';
        case WorkScheduleCadence.EVERY_3_HOURS:
            return 'Every 3 hours';
        case WorkScheduleCadence.EVERY_8_HOURS:
            return 'Every 8 hours';
        case WorkScheduleCadence.EVERY_12_HOURS:
            return 'Every 12 hours';
        case WorkScheduleCadence.DAILY:
            return 'Every day';
        case WorkScheduleCadence.WEEKLY:
            return 'Every week';
        case WorkScheduleCadence.MONTHLY:
            return 'Every month';
        default:
            return cadence ? String(cadence) : '';
    }
}

/** Human label for an N-minute polling interval. */
export function describeIntervalMinutes(minutes: number | null | undefined): string {
    if (!minutes || minutes <= 0) return '';
    if (minutes === 1) return 'Every minute';
    if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
    }
    return `Every ${minutes} minutes`;
}

type ParsedCron = ReturnType<typeof parseCron>;

function matchesParsed(parsed: ParsedCron, date: Date): boolean {
    const minute = date.getUTCMinutes();
    const hour = date.getUTCHours();
    const dom = date.getUTCDate();
    const month = date.getUTCMonth() + 1;
    const dow = date.getUTCDay();
    if (!parsed.minute.has(minute)) return false;
    if (!parsed.hour.has(hour)) return false;
    if (!parsed.month.has(month)) return false;
    // Vixie-cron OR semantics when both DOM and DOW are restricted.
    const domMatch = parsed.dayOfMonth.has(dom);
    const dowMatch = parsed.dayOfWeek.has(dow);
    if (parsed.domRestricted && parsed.dowRestricted) {
        return domMatch || dowMatch;
    }
    return domMatch && dowMatch;
}

// Bounded forward-walk horizon. This is called per Mission (up to 500) on
// the request thread, so the walk is hard-capped at 31 days (44,640
// minute-steps) to keep the aggregation cheap. Every normal cadence
// (minutely→monthly) fires well within this window; a rarer yearly/Feb-29
// expression that doesn't match returns null — the Schedules UI tolerates a
// null nextRunAt and renders '—'.
const MAX_LOOKAHEAD_MINUTES = 31 * 24 * 60;

/**
 * Compute the next UTC fire time strictly after `from` for a 5-field cron
 * expression, by walking forward minute-by-minute (reusing the Mission
 * tick worker's `parseCron` so the semantics match exactly). Returns an
 * ISO string, or null when the expression is invalid or does not fire
 * within the bounded look-ahead horizon (31 days).
 */
export function computeNextCronFire(expr: string | null | undefined, from: Date): string | null {
    if (!expr) return null;
    let parsed: ParsedCron;
    try {
        parsed = parseCron(expr);
    } catch {
        return null;
    }
    let cursor = new Date(from);
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMilliseconds(0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
        if (matchesParsed(parsed, cursor)) {
            return cursor.toISOString();
        }
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
    return null;
}
