/**
 * Task board — the column tables, the client mirror of the transition
 * lattice, and the drop-resolution rule.
 *
 * INVARIANT: every Task status appears in exactly one column of each
 * layout, and a column is never derived from anything but status. A column
 * computed from decisions, run state or freshness could disagree with the
 * Task's own status, and the first card that sits in one column while its
 * detail page says another is the moment the board stops being believable.
 * Decisions and stalls are card flags, never columns.
 *
 * Pure data and pure functions: no framework, no I/O. It lives in contracts
 * because it is the one package both the API (which pages a column) and the
 * web board (which renders and drops into it) already import, so the two
 * cannot compute different mappings.
 */

/** Every Task status, in board order. Mirrors the agent-side `TaskStatus` enum. */
export const TASK_BOARD_STATUSES = [
	'backlog',
	'todo',
	'in_progress',
	'in_review',
	'blocked',
	'done',
	'cancelled'
] as const;

export type TaskBoardStatus = (typeof TASK_BOARD_STATUSES)[number];

/**
 * Statuses a Task rests in once its work has stopped. The board bounds these
 * columns to a recent window, because an all-time Done column grows forever.
 */
export const TASK_BOARD_TERMINAL_STATUSES: readonly TaskBoardStatus[] = ['done', 'cancelled'];

/**
 * Client-side mirror of the server's transition lattice
 * (`TaskTransitionService`). It is an affordance only — it decides which
 * targets a card offers and which columns accept a drop. The server
 * re-checks every move and stays authoritative; an agent-package spec pins
 * this table to the real one so the two cannot drift.
 */
export const TASK_BOARD_TRANSITIONS: Readonly<Record<TaskBoardStatus, readonly TaskBoardStatus[]>> = {
	backlog: ['todo', 'cancelled'],
	todo: ['in_progress', 'blocked', 'cancelled'],
	in_progress: ['in_review', 'blocked', 'done', 'cancelled'],
	in_review: ['in_progress', 'blocked', 'done', 'cancelled'],
	blocked: ['todo', 'in_progress', 'cancelled'],
	done: ['in_progress'],
	cancelled: []
};

/** `status` = one column per status (the shipped board); `focus` = four grouped columns. */
export type TaskBoardLayout = 'status' | 'focus';

export const TASK_BOARD_LAYOUTS: readonly TaskBoardLayout[] = ['status', 'focus'];

export interface TaskBoardColumnDef {
	/** Stable column key. In the status layout it IS the status. */
	key: string;
	/** The statuses whose Tasks this column holds. */
	statuses: readonly TaskBoardStatus[];
	/** True when every status in the column is terminal (windowed column). */
	terminal: boolean;
	/** True for a column shown only when its toggle is on (Focus layout's Cancelled). */
	toggleOnly: boolean;
}

/** Status layout — seven columns, one status each, in board order. */
export const TASK_BOARD_STATUS_COLUMNS: readonly TaskBoardColumnDef[] = TASK_BOARD_STATUSES.map((status) => ({
	key: status,
	statuses: [status],
	terminal: TASK_BOARD_TERMINAL_STATUSES.includes(status),
	toggleOnly: false
}));

/**
 * Focus layout — the coarse read. `cancelled` is never dropped: it is a
 * toggle-only column, so no status is ever unreachable from the board.
 */
export const TASK_BOARD_FOCUS_COLUMNS: readonly TaskBoardColumnDef[] = [
	{ key: 'backlog', statuses: ['backlog', 'todo'], terminal: false, toggleOnly: false },
	{ key: 'in_flight', statuses: ['in_progress'], terminal: false, toggleOnly: false },
	{ key: 'needs_you', statuses: ['in_review', 'blocked'], terminal: false, toggleOnly: false },
	{ key: 'done', statuses: ['done'], terminal: true, toggleOnly: false },
	{ key: 'cancelled', statuses: ['cancelled'], terminal: true, toggleOnly: true }
];

export function isTaskBoardStatus(value: unknown): value is TaskBoardStatus {
	return typeof value === 'string' && (TASK_BOARD_STATUSES as readonly string[]).includes(value);
}

export function isTaskBoardLayout(value: unknown): value is TaskBoardLayout {
	return value === 'status' || value === 'focus';
}

/**
 * The columns a layout renders. The status layout always includes Cancelled
 * (it is today's board); the focus layout includes it only when asked.
 */
export function taskBoardColumnsFor(
	layout: TaskBoardLayout,
	opts: { includeCancelled: boolean } = { includeCancelled: false }
): TaskBoardColumnDef[] {
	if (layout === 'status') return [...TASK_BOARD_STATUS_COLUMNS];
	return TASK_BOARD_FOCUS_COLUMNS.filter((column) => !column.toggleOnly || opts.includeCancelled);
}

/** Look a column up by key within a layout (toggle-only columns included). */
export function findTaskBoardColumn(layout: TaskBoardLayout, key: string): TaskBoardColumnDef | undefined {
	const table = layout === 'status' ? TASK_BOARD_STATUS_COLUMNS : TASK_BOARD_FOCUS_COLUMNS;
	return table.find((column) => column.key === key);
}

/** The key of the column a status lands in, for a layout. */
export function taskBoardColumnForStatus(layout: TaskBoardLayout, status: TaskBoardStatus): string {
	const table = layout === 'status' ? TASK_BOARD_STATUS_COLUMNS : TASK_BOARD_FOCUS_COLUMNS;
	const column = table.find((entry) => entry.statuses.includes(status));
	// Unreachable while the invariant holds; the spec enforces it.
	return column ? column.key : status;
}

export type TaskBoardDropResolution =
	| { kind: 'apply'; to: TaskBoardStatus }
	| { kind: 'ask'; options: TaskBoardStatus[] }
	| { kind: 'refuse' };

/**
 * What a drop of a card in `from` onto `column` means:
 *   - no status in the column is a legal move → refuse
 *   - exactly one is → apply it
 *   - more than one is → ask which (the board must not guess)
 *
 * A drop onto the card's own status is not a move and is refused.
 */
export function resolveTaskBoardDrop(
	from: TaskBoardStatus,
	column: Pick<TaskBoardColumnDef, 'statuses'>,
	allowed: Readonly<Record<TaskBoardStatus, readonly TaskBoardStatus[]>> = TASK_BOARD_TRANSITIONS
): TaskBoardDropResolution {
	const legal = column.statuses.filter((status) => status !== from && (allowed[from] ?? []).includes(status));
	if (legal.length === 0) return { kind: 'refuse' };
	if (legal.length === 1) return { kind: 'apply', to: legal[0] };
	return { kind: 'ask', options: legal };
}

// ── Read-model bounds ───────────────────────────────────────────────

/** Cards per column on the first read. */
export const TASK_BOARD_DEFAULT_COLUMN_LIMIT = 50;
export const TASK_BOARD_MAX_COLUMN_LIMIT = 100;

/** Days of `done` / `cancelled` history the board shows by default. */
export const TASK_BOARD_DEFAULT_TERMINAL_WINDOW_DAYS = 7;
export const TASK_BOARD_MAX_TERMINAL_WINDOW_DAYS = 90;

function clampInt(value: unknown, fallback: number, max: number): number {
	if (typeof value === 'string' && value.trim() === '') return fallback;
	const parsed = typeof value === 'string' ? Number(value) : value;
	if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(parsed)));
}

/**
 * Total: anything absent or unparseable is the default, anything else is
 * clamped into 1..100. A junk query string never becomes a 500 or an
 * unbounded read.
 */
export function clampTaskBoardColumnLimit(value: unknown): number {
	return clampInt(value, TASK_BOARD_DEFAULT_COLUMN_LIMIT, TASK_BOARD_MAX_COLUMN_LIMIT);
}

/** Total, like {@link clampTaskBoardColumnLimit}; clamped into 1..90. */
export function clampTaskBoardTerminalWindowDays(value: unknown): number {
	return clampInt(value, TASK_BOARD_DEFAULT_TERMINAL_WINDOW_DAYS, TASK_BOARD_MAX_TERMINAL_WINDOW_DAYS);
}
