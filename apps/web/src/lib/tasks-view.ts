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

import {
    isTaskBoardSort,
    TASK_BOARD_DEFAULT_SORT,
    TASK_BOARD_TERMINAL_WINDOW_ALL,
    type TaskBoardSort,
} from '@ever-works/contracts';

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

// ── Board options: card order and how far back completed Tasks go ──────

/**
 * `?sort=` — the board's card order. Both orders stay available because a
 * user can reasonably want either: `priority` (stalled first, then Urgent →
 * Low, then the oldest update) or `updated` (most recently updated first,
 * the order Task lists have always used).
 */
export const TASKS_BOARD_SORT_PARAM = 'sort';

/** The `/tasks` board opens priority-ordered. */
export const DEFAULT_TASKS_BOARD_SORT: TaskBoardSort = TASK_BOARD_DEFAULT_SORT;

/**
 * The scoped Mission / Work / Idea Task lists open most recently updated
 * first — the order they have always shown — with priority one click away.
 */
export const DEFAULT_SCOPED_BOARD_SORT: TaskBoardSort = 'updated';

/** Read a card order from an untrusted string; anything unknown is `null`. */
export function parseTasksBoardSort(value: unknown): TaskBoardSort | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return isTaskBoardSort(normalized) ? normalized : null;
}

/** URL beats the default. Reads the first value of a repeated parameter. */
export function resolveTasksBoardSort(
    url: string | string[] | null | undefined,
    fallback: TaskBoardSort = DEFAULT_TASKS_BOARD_SORT,
): TaskBoardSort {
    return parseTasksBoardSort(Array.isArray(url) ? url[0] : url) ?? fallback;
}

/**
 * `?done=` — how far back the Done and Cancelled columns reach. The four
 * choices the board offers; `all` is every completed Task of any age.
 */
export const TASKS_BOARD_DONE_PARAM = 'done';

export const TASKS_BOARD_DONE_WINDOWS = [7, 30, 90, TASK_BOARD_TERMINAL_WINDOW_ALL] as const;

export type TasksBoardDoneWindow = (typeof TASKS_BOARD_DONE_WINDOWS)[number];

/** A week, as the board has shown by default. */
export const DEFAULT_TASKS_BOARD_DONE_WINDOW: TasksBoardDoneWindow = 7;

/** Read one of the four windows from an untrusted value; anything else is `null`. */
export function parseTasksBoardDoneWindow(value: unknown): TasksBoardDoneWindow | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
    return TASKS_BOARD_DONE_WINDOWS.find((window) => String(window) === String(normalized)) ?? null;
}

/** URL beats the default. Reads the first value of a repeated parameter. */
export function resolveTasksBoardDoneWindow(
    url: string | string[] | null | undefined,
): TasksBoardDoneWindow {
    return (
        parseTasksBoardDoneWindow(Array.isArray(url) ? url[0] : url) ??
        DEFAULT_TASKS_BOARD_DONE_WINDOW
    );
}
