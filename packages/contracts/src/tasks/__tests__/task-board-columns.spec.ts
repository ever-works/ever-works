import { describe, expect, it } from 'vitest';

import {
	clampTaskBoardColumnLimit,
	clampTaskBoardTerminalWindowDays,
	findTaskBoardColumn,
	isTaskBoardLayout,
	isTaskBoardSort,
	isTaskBoardStatus,
	resolveTaskBoardDrop,
	resolveTaskBoardSort,
	resolveTaskBoardTerminalWindow,
	TASK_BOARD_DEFAULT_SORT,
	TASK_BOARD_FOCUS_COLUMNS,
	TASK_BOARD_SORTS,
	TASK_BOARD_STATUS_COLUMNS,
	TASK_BOARD_STATUSES,
	TASK_BOARD_TERMINAL_WINDOW_ALL,
	TASK_BOARD_TRANSITIONS,
	taskBoardColumnForStatus,
	taskBoardColumnsFor,
	type TaskBoardColumnDef,
	type TaskBoardDropResolution,
	type TaskBoardLayout,
	type TaskBoardStatus
} from '../task-board-columns.types.js';

/** Every status, counted across a layout's columns (toggle-only included). */
function statusOccurrences(columns: readonly TaskBoardColumnDef[]): Map<TaskBoardStatus, number> {
	const counts = new Map<TaskBoardStatus, number>();
	for (const column of columns) {
		for (const status of column.statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	return counts;
}

describe('task board column tables', () => {
	it.each<[TaskBoardLayout, readonly TaskBoardColumnDef[]]>([
		['status', TASK_BOARD_STATUS_COLUMNS],
		['focus', TASK_BOARD_FOCUS_COLUMNS]
	])('the %s layout places every status in exactly one column', (_layout, columns) => {
		const counts = statusOccurrences(columns);
		expect(new Set(counts.keys())).toEqual(new Set(TASK_BOARD_STATUSES));
		for (const status of TASK_BOARD_STATUSES) expect(counts.get(status)).toBe(1);
	});

	it('keeps the shipped seven-column order in the status layout', () => {
		expect(TASK_BOARD_STATUS_COLUMNS.map((column) => column.key)).toEqual([
			'backlog',
			'todo',
			'in_progress',
			'in_review',
			'blocked',
			'done',
			'cancelled'
		]);
		for (const column of TASK_BOARD_STATUS_COLUMNS) expect(column.statuses).toEqual([column.key]);
	});

	it('marks only done and cancelled as terminal (windowed) columns', () => {
		expect(TASK_BOARD_STATUS_COLUMNS.filter((column) => column.terminal).map((column) => column.key)).toEqual([
			'done',
			'cancelled'
		]);
	});

	it('never drops cancelled from the focus layout — it is a toggle-only column', () => {
		expect(taskBoardColumnsFor('focus', { includeCancelled: false }).map((c) => c.key)).toEqual([
			'backlog',
			'in_flight',
			'needs_you',
			'done'
		]);
		expect(taskBoardColumnsFor('focus', { includeCancelled: true }).map((c) => c.key)).toContain('cancelled');
		// The status layout always carries it, toggle or not.
		expect(taskBoardColumnsFor('status', { includeCancelled: false }).map((c) => c.key)).toContain('cancelled');
		expect(findTaskBoardColumn('focus', 'cancelled')?.toggleOnly).toBe(true);
	});

	it('maps a status to its column key in each layout', () => {
		expect(taskBoardColumnForStatus('status', 'in_review')).toBe('in_review');
		expect(taskBoardColumnForStatus('focus', 'todo')).toBe('backlog');
		expect(taskBoardColumnForStatus('focus', 'blocked')).toBe('needs_you');
		expect(taskBoardColumnForStatus('focus', 'cancelled')).toBe('cancelled');
	});

	it('returns undefined for an unknown column key rather than guessing', () => {
		expect(findTaskBoardColumn('status', 'needs_you')).toBeUndefined();
		expect(findTaskBoardColumn('focus', 'in_progress')).toBeUndefined();
		expect(findTaskBoardColumn('status', '')).toBeUndefined();
	});

	it('recognises statuses and layouts exactly', () => {
		expect(isTaskBoardStatus('in_progress')).toBe(true);
		expect(isTaskBoardStatus('In Progress')).toBe(false);
		expect(isTaskBoardStatus(undefined)).toBe(false);
		expect(isTaskBoardLayout('focus')).toBe(true);
		expect(isTaskBoardLayout('kanban')).toBe(false);
	});
});

describe('resolveTaskBoardDrop — the full status × focus-column matrix', () => {
	const apply = (to: TaskBoardStatus): TaskBoardDropResolution => ({ kind: 'apply', to });
	const refuse: TaskBoardDropResolution = { kind: 'refuse' };

	const EXPECTED: Record<TaskBoardStatus, Record<string, TaskBoardDropResolution>> = {
		backlog: {
			backlog: apply('todo'),
			in_flight: refuse,
			needs_you: refuse,
			done: refuse,
			cancelled: apply('cancelled')
		},
		todo: {
			backlog: refuse,
			in_flight: apply('in_progress'),
			needs_you: apply('blocked'),
			done: refuse,
			cancelled: apply('cancelled')
		},
		in_progress: {
			backlog: refuse,
			in_flight: refuse,
			needs_you: { kind: 'ask', options: ['in_review', 'blocked'] },
			done: apply('done'),
			cancelled: apply('cancelled')
		},
		in_review: {
			backlog: refuse,
			in_flight: apply('in_progress'),
			needs_you: apply('blocked'),
			done: apply('done'),
			cancelled: apply('cancelled')
		},
		blocked: {
			backlog: apply('todo'),
			in_flight: apply('in_progress'),
			needs_you: refuse,
			done: refuse,
			cancelled: apply('cancelled')
		},
		done: {
			backlog: refuse,
			in_flight: apply('in_progress'),
			needs_you: refuse,
			done: refuse,
			cancelled: refuse
		},
		cancelled: {
			backlog: refuse,
			in_flight: refuse,
			needs_you: refuse,
			done: refuse,
			cancelled: refuse
		}
	};

	const pairs = TASK_BOARD_STATUSES.flatMap((from) =>
		TASK_BOARD_FOCUS_COLUMNS.map((column) => [from, column.key, column] as const)
	);

	it('covers all 35 pairs', () => {
		expect(pairs).toHaveLength(35);
	});

	it.each(pairs)('%s dropped on %s', (from, key, column) => {
		expect(resolveTaskBoardDrop(from, column)).toEqual(EXPECTED[from][key]);
	});

	it('asks in exactly one place: in_progress onto Needs you', () => {
		const asks = pairs.filter(([from, , column]) => resolveTaskBoardDrop(from, column).kind === 'ask');
		expect(asks.map(([from, key]) => `${from}->${key}`)).toEqual(['in_progress->needs_you']);
	});

	it('refuses every drop out of cancelled, in every layout', () => {
		for (const column of [...TASK_BOARD_FOCUS_COLUMNS, ...TASK_BOARD_STATUS_COLUMNS]) {
			expect(resolveTaskBoardDrop('cancelled', column)).toEqual(refuse);
		}
	});

	it('in the status layout, a drop applies exactly the lattice', () => {
		for (const from of TASK_BOARD_STATUSES) {
			for (const column of TASK_BOARD_STATUS_COLUMNS) {
				const to = column.statuses[0];
				const expected = TASK_BOARD_TRANSITIONS[from].includes(to) ? apply(to) : refuse;
				expect(resolveTaskBoardDrop(from, column)).toEqual(expected);
			}
		}
	});

	it('honours a caller-supplied lattice instead of the built-in mirror', () => {
		const closed = Object.fromEntries(TASK_BOARD_STATUSES.map((s) => [s, []])) as unknown as Record<
			TaskBoardStatus,
			TaskBoardStatus[]
		>;
		expect(resolveTaskBoardDrop('todo', { statuses: ['in_progress'] }, closed)).toEqual(refuse);
	});
});

describe('board read-model clamps', () => {
	it.each([
		[undefined, 50],
		[null, 50],
		['', 50],
		['abc', 50],
		[Number.NaN, 50],
		[0, 1],
		[-4, 1],
		[1, 1],
		['1', 1],
		[50, 50],
		[100, 100],
		[101, 100],
		['7.9', 7]
	])('column limit %p → %p', (input, expected) => {
		expect(clampTaskBoardColumnLimit(input)).toBe(expected);
	});

	it.each([
		[undefined, 7],
		['junk', 7],
		[0, 1],
		[1, 1],
		[90, 90],
		[91, 90],
		['30', 30]
	])('terminal window %p → %p', (input, expected) => {
		expect(clampTaskBoardTerminalWindowDays(input)).toBe(expected);
	});

	it.each([
		['all', 'all'],
		[' ALL ', 'all'],
		[undefined, 7],
		['', 7],
		['junk', 7],
		[0, 1],
		['0', 1],
		[90, 90],
		[91, 90],
		['365', 90],
		['30', 30]
	])('resolved terminal window %s → %s (the sentinel is the only way past 90)', (input, expected) => {
		expect(resolveTaskBoardTerminalWindow(input)).toBe(expected);
	});

	it('names the all-time sentinel once', () => {
		expect(TASK_BOARD_TERMINAL_WINDOW_ALL).toBe('all');
	});
});

describe('board card order', () => {
	it('offers exactly priority and updated, defaulting to priority', () => {
		expect(TASK_BOARD_SORTS).toEqual(['priority', 'updated']);
		expect(TASK_BOARD_DEFAULT_SORT).toBe('priority');
	});

	it.each([
		['priority', true],
		['updated', true],
		['updatedAt', false],
		['', false],
		[undefined, false]
	])('isTaskBoardSort(%s) → %s', (input, expected) => {
		expect(isTaskBoardSort(input)).toBe(expected);
	});

	it.each([
		['priority', 'priority'],
		['updated', 'updated'],
		[' Updated ', 'updated'],
		['recent', 'priority'],
		[undefined, 'priority'],
		[42, 'priority']
	])('resolveTaskBoardSort(%s) → %s', (input, expected) => {
		expect(resolveTaskBoardSort(input)).toBe(expected);
	});
});
