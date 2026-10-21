/**
 * The Activity page's view model — one place where the server component and
 * the client shell agree on what a `?view=` value means.
 *
 * Activity is the single surface for "what happened in my workspace", and it
 * answers that question four ways, each of which used to be its own page or its
 * own tab somewhere else:
 *
 *  - `log`       — every operation the platform recorded (the original page).
 *  - `runs`      — every AGENT EXECUTION on a Day / Week / Month calendar, with
 *                  the window's totals and a receipt per run. This was the
 *                  standalone `/runs` page (AW-09); `/runs` now redirects here
 *                  with `view=runs` and the whole view state carried over.
 *  - `feed`      — the narrated Live Feed.
 *  - `schedules` — what will run without you.
 *  - `sessions`  — (FL-05) every session on your computers, on a board by what
 *                  it needs from you (Needs you · Working · Done · Idle) or as a
 *                  list; shown only while `FLEET_SESSIONS_ENABLED` is on.
 *
 * The order is deliberate: the record first, then the executions inside it,
 * then the narration, then the forecast — and the live sessions last.
 */
export const ACTIVITY_VIEWS = ['log', 'runs', 'feed', 'schedules', 'sessions'] as const;

export type ActivityView = (typeof ACTIVITY_VIEWS)[number];

/** Where the Activities/`view` search param lives. */
export const ACTIVITY_VIEW_PARAM = 'view';

export function isActivityView(value: string | null | undefined): value is ActivityView {
    return value != null && (ACTIVITY_VIEWS as readonly string[]).includes(value);
}

/**
 * The single-key shortcut that switches to each view. Chosen so they collide
 * with nothing a view already binds: the Runs ledger owns `d w m t j k o`,
 * the Live Feed owns `a x`, and both own the arrows and `Enter`/`Esc`.
 */
export const ACTIVITY_VIEW_KEYS: Record<string, ActivityView> = {
    l: 'log',
    r: 'runs',
    f: 'feed',
    s: 'schedules',
    // FL-05 (spec FR-52): `n` — what needs you now.
    n: 'sessions',
};
