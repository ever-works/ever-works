import type { HomeDayWindow } from '@ever-works/contracts';
import { isValidTimezone, resolveRunWindow } from '../agents/run-window';

/**
 * Home (AW-19) — which timezone "today" means, and the day it covers.
 *
 * The day window is the Runs ledger's own day window (`resolveRunWindow`), so
 * the `done today` / `failed today` counters and the ledger they link to can
 * never disagree about where today starts, including across a DST change.
 * A timezone the ledger accepts is a timezone Home accepts.
 */

/** A timezone was named explicitly and is not one the runtime knows. */
export class InvalidHomeTimezoneError extends Error {
    readonly code = 'invalid-timezone';

    constructor(timezone: string) {
        super(`Unknown timezone: ${timezone.slice(0, 64)}`);
        this.name = 'InvalidHomeTimezoneError';
    }
}

export interface ResolvedHomeTimezone {
    timezone: string;
    /** True when no usable timezone was known and UTC was used instead. */
    fallback: boolean;
}

/**
 * Resolution order: the explicit `candidate` (the browser's own zone), then
 * the profile timezone, then UTC. An explicit candidate that is not a real
 * zone is refused rather than silently replaced — a wrong day boundary is a
 * wrong number. A stale profile value simply falls through to UTC.
 */
export function resolveHomeTimezone(
    candidate: string | null | undefined,
    profileTimezone: string | null | undefined,
): ResolvedHomeTimezone {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
        const trimmed = candidate.trim();
        if (!isValidTimezone(trimmed)) {
            throw new InvalidHomeTimezoneError(trimmed);
        }
        return { timezone: trimmed, fallback: false };
    }
    if (isValidTimezone(profileTimezone)) {
        return { timezone: profileTimezone, fallback: false };
    }
    return { timezone: 'UTC', fallback: true };
}

/** The user's local calendar day containing `now`, as `[from, to)` instants. */
export function buildHomeDay(timezone: string, now: Date): HomeDayWindow {
    const window = resolveRunWindow({ granularity: 'day', timezone, now });
    return { date: window.anchorDate, from: window.from, to: window.to };
}
