/**
 * Which view of `/tasks` — Cards, Table or Board — a visit opens on.
 *
 * The view used to live in component state only: it was not in the URL, so
 * a filtered board could not be linked or bookmarked, and it reset to Cards
 * on every visit. Resolution order, implemented once here:
 *
 *   1. `?view=` in the URL   — a shared link reproduces exactly what was shared
 *   2. the `tasks-view` cookie — the last view this browser chose
 *   3. {@link DEFAULT_TASKS_VIEW}
 *
 * A cookie (not localStorage) because the page is server-rendered and has to
 * fetch different data per view: the board reads true per-column totals, the
 * list views read one page. Same cookie shape as the dashboard's
 * `sidebar-collapsed` / `chat-panel-open` preferences.
 *
 * Client-safe: no server imports.
 */

export const TASKS_VIEWS = ['cards', 'table', 'board'] as const;

export type TasksView = (typeof TASKS_VIEWS)[number];

/**
 * The view for a browser that has never chosen one. Cards, as it has always
 * been: changing what every existing user lands on is a product decision,
 * and this constant is the single place it would be made.
 */
export const DEFAULT_TASKS_VIEW: TasksView = 'cards';

export const TASKS_VIEW_COOKIE = 'tasks-view';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Read a view from an untrusted string. `kanban` is accepted as the board —
 * it is what the control has always been labelled — so a hand-typed or older
 * link still opens the board. Anything else is `null`.
 */
export function parseTasksView(value: unknown): TasksView | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'kanban') return 'board';
    return (TASKS_VIEWS as readonly string[]).includes(normalized)
        ? (normalized as TasksView)
        : null;
}

/** URL beats cookie beats the default. An invalid value falls through to the next source. */
export function resolveTasksView(input: {
    url?: string | string[] | null;
    cookie?: string | null;
}): TasksView {
    const url = Array.isArray(input.url) ? input.url[0] : input.url;
    return parseTasksView(url) ?? parseTasksView(input.cookie) ?? DEFAULT_TASKS_VIEW;
}

/** The `document.cookie` assignment that remembers a chosen view for a year. */
export function tasksViewCookie(view: TasksView, opts: { secure: boolean }): string {
    const secure = opts.secure ? '; Secure' : '';
    return `${TASKS_VIEW_COOKIE}=${view}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure}`;
}
