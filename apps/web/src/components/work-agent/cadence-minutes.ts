// Phase 4 PR L — small helpers for the Auto-generate Ideas
// settings row. The platform stores `autoGenerateCadence` as a
// cron string in `WorkAgentPreference` (Phase 0 PR 0.4), but the
// v1 settings UI exposes it as a plain "every N minutes" number
// field (Decision A10: keep the user-facing knob obvious and
// defer advanced cron-syntax editing to a later iteration).
//
// These helpers translate between the two — for "every-30-minutes"
// cron it's "*\/30 * * * *" (escaping the */ here only because
// JSDoc block comments would otherwise close prematurely):
//   - parseCadenceMinutes(cronStr) → 30
//   - formatCadenceMinutes(30)     → cronStr
//
// If the stored cron isn't in that simple shape (e.g. the user
// edited it via the API directly), parseCadenceMinutes returns
// null so the UI can render the platform default and let the
// user re-set it from the simple form.

const SIMPLE_CADENCE_RE = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/;

/** Platform fallback when the user hasn't set their own cadence
 *  (display-only — the actual fallback lives server-side in PR D). */
export const DEFAULT_CADENCE_MINUTES = 60;
/** Display fallback when the stored cron doesn't fit the simple step shape. */
export const DEFAULT_BATCH_SIZE = 3;
/** Display fallback for the auto-build daily throttle. */
export const DEFAULT_AUTOBUILD_THROTTLE = 50;
/** Display fallback for the mission-default outstanding cap (matches
 *  the platform default in MissionTickService for Phase 3 PR J). */
export const DEFAULT_MISSION_OUTSTANDING_CAP = 20;

export function parseCadenceMinutes(cadence: string | null | undefined): number | null {
    if (!cadence) return null;
    const trimmed = cadence.trim();
    const match = SIMPLE_CADENCE_RE.exec(trimmed);
    if (!match) return null;
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
}

export function formatCadenceMinutes(minutes: number): string {
    const n = Math.max(1, Math.min(1440, Math.floor(minutes)));
    return `*/${n} * * * *`;
}
