import { matchesCron, parseCron } from '../missions/cron-matcher';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 6.
 *
 * Compute the next UTC time on or after `from` (exclusive) at which
 * the given Agent heartbeat cron expression fires.
 *
 * The Agent dispatcher fires once per dispatch interval and picks
 * up rows whose `nextHeartbeatAt <= now`. After a successful run we
 * call this to recompute the next slot — passing the *previous*
 * scheduled fire time (not `Date.now()`) so a late dispatcher
 * doesn't double-slip the cadence.
 *
 * `cadence === 'manual'` returns `null` (manual Agents are dispatched
 * exclusively via `POST /agents/:id/run-now`).
 *
 * Strategy: iterate forward minute-by-minute up to `maxLookaheadMinutes`,
 * checking `matchesCron`. This is intentionally simple — same
 * approach the Mission tick worker uses (it dispatches every minute
 * and checks per-row), so we don't pull in a heavyweight cron-parser
 * dependency. The cap defaults to ~13 months which covers anything
 * a sane Agent cadence would express.
 *
 * Returns `null` if no match is found in the lookahead window, OR
 * if the cron expression fails to parse — callers must handle null
 * (the dispatcher pauses the Agent + emits an error log row).
 */
export function computeNextHeartbeat(
    cadence: string | null,
    from: Date = new Date(),
    maxLookaheadMinutes = 60 * 24 * 400,
): Date | null {
    if (!cadence) return null;
    if (cadence === 'manual') return null;

    try {
        // Parse-once to surface invalid expressions before iterating.
        parseCron(cadence);
    } catch {
        return null;
    }

    // Start at the next whole minute strictly after `from`. We never
    // return a value at or before `from` because the dispatcher's
    // `findDueForHeartbeat` would re-pick the row on the same tick.
    const cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);

    for (let i = 0; i < maxLookaheadMinutes; i++) {
        if (matchesCron(cadence, cursor)) {
            return cursor;
        }
        cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    }
    return null;
}
