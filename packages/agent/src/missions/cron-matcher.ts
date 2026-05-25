/**
 * Phase 3 PR J — minimal 5-field cron matcher used by the
 * Mission tick worker to decide whether a Mission's stored
 * `schedule` cron expression matches a given timestamp.
 *
 * Supports the standard 5 fields (minute, hour, day-of-month,
 * month, day-of-week) and the common operators:
 *   *           every value
 *   N           literal
 *   N-M         inclusive range
 *   N,M,O       enumeration
 *   * / N         every Nth value within the field's range
 *   N-M/S       step within a range
 *
 * Month and day-of-week also accept the standard 3-letter
 * aliases (case-insensitive): JAN..DEC and SUN..SAT (Sunday
 * accepted as either 0 or 7 to match Unix cron).
 *
 * The matcher is intentionally NOT a full cron parser: it
 * doesn't implement non-standard operators (`?`, `L`, `W`, `#`,
 * `H`, `@reboot`/`@hourly`/etc.) — keeping the surface tight
 * lets the spec live with zero new runtime deps. If a Mission
 * needs richer scheduling later we'll either swap in a
 * dedicated library here or push the decision up to Trigger.dev
 * native cron support per-Mission.
 *
 * Day-of-month and day-of-week have OR semantics when BOTH are
 * restricted (matches standard cron — `0 9 1 * MON` fires on
 * the 1st of every month OR every Monday, not their intersection).
 */
const MONTH_ALIASES: Record<string, number> = {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
};

const DOW_ALIASES: Record<string, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
};

interface FieldSpec {
    min: number;
    max: number;
    aliases?: Record<string, number>;
}

const MINUTE: FieldSpec = { min: 0, max: 59 };
const HOUR: FieldSpec = { min: 0, max: 23 };
const DOM: FieldSpec = { min: 1, max: 31 };
const MONTH: FieldSpec = { min: 1, max: 12, aliases: MONTH_ALIASES };
const DOW: FieldSpec = { min: 0, max: 7, aliases: DOW_ALIASES };

function resolveAlias(token: string, spec: FieldSpec): string {
    if (!spec.aliases) return token;
    const upper = token.toUpperCase();
    if (upper in spec.aliases) return String(spec.aliases[upper]);
    return token;
}

function parseInteger(token: string, spec: FieldSpec): number {
    const resolved = resolveAlias(token, spec);
    const n = Number(resolved);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw new Error(
            `Invalid cron value "${token}" — expected integer in [${spec.min}, ${spec.max}].`,
        );
    }
    return n;
}

function parseFieldPart(part: string, spec: FieldSpec): Set<number> {
    const out = new Set<number>();
    // Step: <range>/<step>
    const [rangeRaw, stepRaw] = part.split('/');
    let step = 1;
    if (stepRaw !== undefined) {
        const parsedStep = Number(stepRaw);
        if (!Number.isInteger(parsedStep) || parsedStep < 1) {
            throw new Error(`Invalid cron step "${stepRaw}" — must be a positive integer.`);
        }
        step = parsedStep;
    }

    let start: number;
    let end: number;
    if (rangeRaw === '*' || rangeRaw === '') {
        start = spec.min;
        end = spec.max;
    } else if (rangeRaw.includes('-')) {
        const [a, b] = rangeRaw.split('-');
        start = parseInteger(a, spec);
        end = parseInteger(b, spec);
        if (start > end) {
            throw new Error(`Invalid cron range "${rangeRaw}" — start > end.`);
        }
    } else {
        const single = parseInteger(rangeRaw, spec);
        start = single;
        end = stepRaw !== undefined ? spec.max : single;
    }

    for (let v = start; v <= end; v += step) {
        out.add(v);
    }
    return out;
}

function parseField(field: string, spec: FieldSpec): Set<number> {
    const out = new Set<number>();
    for (const part of field.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        for (const v of parseFieldPart(trimmed, spec)) out.add(v);
    }
    if (out.size === 0) {
        throw new Error(`Empty cron field.`);
    }
    return out;
}

interface ParsedCron {
    minute: Set<number>;
    hour: Set<number>;
    dayOfMonth: Set<number>;
    month: Set<number>;
    dayOfWeek: Set<number>;
    /** Whether the day-of-month field is restricted (not `*`). */
    domRestricted: boolean;
    /** Whether the day-of-week field is restricted (not `*`). */
    dowRestricted: boolean;
}

export function parseCron(cron: string): ParsedCron {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(
            `Invalid cron expression "${cron}" — expected 5 space-separated fields (minute hour day month dow).`,
        );
    }
    const [minute, hour, dom, month, dow] = parts;
    const parsed: ParsedCron = {
        minute: parseField(minute, MINUTE),
        hour: parseField(hour, HOUR),
        dayOfMonth: parseField(dom, DOM),
        month: parseField(month, MONTH),
        dayOfWeek: parseField(dow, DOW),
        domRestricted: dom !== '*',
        dowRestricted: dow !== '*',
    };
    // Normalize Sunday: cron accepts both 0 and 7 — collapse to 0.
    if (parsed.dayOfWeek.has(7)) {
        parsed.dayOfWeek.delete(7);
        parsed.dayOfWeek.add(0);
    }
    return parsed;
}

/**
 * True iff `date` (interpreted in UTC) matches the cron expression.
 *
 * UTC is deliberate: Mission cron expressions are stored as the
 * user provided them, and the tick worker fires on Trigger.dev's
 * own (UTC) clock. Mixing local time would make "every Monday
 * 9am" mean different things across daylight-saving boundaries
 * and across deployments in different regions. The spec calls
 * out UTC explicitly (§1.3 Mission.schedule).
 */
export function matchesCron(cron: string, date: Date): boolean {
    const parsed = parseCron(cron);
    const minute = date.getUTCMinutes();
    const hour = date.getUTCHours();
    const dom = date.getUTCDate();
    const month = date.getUTCMonth() + 1; // JS months are 0-indexed
    const dow = date.getUTCDay(); // 0..6 (Sun..Sat) — already matches our normalization
    if (!parsed.minute.has(minute)) return false;
    if (!parsed.hour.has(hour)) return false;
    if (!parsed.month.has(month)) return false;

    // Day-of-month and day-of-week have OR semantics when BOTH
    // are restricted (Vixie cron convention). When only one is
    // restricted, the other must match (which is trivially true
    // when it's `*`). When NEITHER is restricted, both sets are
    // full so either branch matches.
    const domMatch = parsed.dayOfMonth.has(dom);
    const dowMatch = parsed.dayOfWeek.has(dow);
    if (parsed.domRestricted && parsed.dowRestricted) {
        return domMatch || dowMatch;
    }
    return domMatch && dowMatch;
}
