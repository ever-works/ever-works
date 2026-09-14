import { describe, expect, it } from 'vitest';

import { TASK_BOARD_STATUSES } from '../task-board-columns.types.js';
import {
	clampTaskBoardStallAfterDays,
	compareTaskBoardCards,
	isTaskStalled,
	TASK_BOARD_DEFAULT_STALL_AFTER_DAYS,
	taskBoardStallCutoff
} from '../task-board-stall.types.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const base = {
	status: 'in_progress',
	latestRunStatus: null,
	updatedAt: hoursAgo(49),
	now: NOW,
	stallAfterDays: TASK_BOARD_DEFAULT_STALL_AFTER_DAYS
};

describe('isTaskStalled', () => {
	it('flags an in-progress Task untouched for 49 h at the 2-day default', () => {
		expect(isTaskStalled(base)).toBe(true);
	});

	it('does not flag the same Task at 47 h', () => {
		expect(isTaskStalled({ ...base, updatedAt: hoursAgo(47) })).toBe(false);
	});

	it.each(['queued', 'running'])('never flags a Task whose latest run is %s', (latestRunStatus) => {
		expect(isTaskStalled({ ...base, latestRunStatus })).toBe(false);
	});

	it.each(['completed', 'failed', 'cancelled', null, undefined])(
		'flags a Task whose latest run is %p (nothing is running)',
		(latestRunStatus) => {
			expect(isTaskStalled({ ...base, latestRunStatus })).toBe(true);
		}
	);

	it.each(TASK_BOARD_STATUSES.filter((status) => status !== 'in_progress'))(
		'never flags a %s Task, however old',
		(status) => {
			expect(isTaskStalled({ ...base, status, updatedAt: hoursAgo(24 * 365) })).toBe(false);
		}
	);

	it('accepts an ISO string for updatedAt, as the web receives it', () => {
		expect(isTaskStalled({ ...base, updatedAt: hoursAgo(49).toISOString() })).toBe(true);
	});

	it('refuses to flag an unparseable updatedAt rather than guess', () => {
		expect(isTaskStalled({ ...base, updatedAt: 'not a date' })).toBe(false);
	});

	it('uses a configured threshold once clamped', () => {
		expect(isTaskStalled({ ...base, updatedAt: hoursAgo(25), stallAfterDays: 1 })).toBe(true);
		expect(isTaskStalled({ ...base, updatedAt: hoursAgo(25), stallAfterDays: 0 })).toBe(true);
		expect(isTaskStalled({ ...base, updatedAt: hoursAgo(49), stallAfterDays: 3 })).toBe(false);
	});
});

describe('clampTaskBoardStallAfterDays', () => {
	it.each([
		[0, 1],
		[1, 1],
		[2, 2],
		[30, 30],
		[31, 30],
		[-5, 1],
		[2.7, 2],
		[null, 2],
		[undefined, 2],
		[Number.NaN, 2],
		[Number.POSITIVE_INFINITY, 2]
	])('%p → %p', (input, expected) => {
		expect(clampTaskBoardStallAfterDays(input as number | null | undefined)).toBe(expected);
	});
});

describe('compareTaskBoardCards', () => {
	const card = (title: string, overrides: Partial<Record<string, unknown>> = {}) => ({
		title,
		status: 'todo',
		priority: 'p3',
		latestRunStatus: null as string | null,
		updatedAt: hoursAgo(10).toISOString(),
		...overrides
	});
	const order = (cards: ReturnType<typeof card>[]) =>
		[...cards].sort((a, b) => compareTaskBoardCards(a, b, NOW)).map((c) => c.title);

	it('puts Urgent first even when it is the oldest card', () => {
		expect(
			order([
				card('fresh normal', { updatedAt: hoursAgo(1).toISOString() }),
				card('old urgent', { priority: 'p0', updatedAt: hoursAgo(24 * 30).toISOString() }),
				card('high', { priority: 'p1' })
			])
		).toEqual(['old urgent', 'high', 'fresh normal']);
	});

	it('orders all five priorities p0 → p4', () => {
		const shuffled = ['p4', 'p2', 'p0', 'p3', 'p1'].map((priority) => card(priority, { priority }));
		expect(order(shuffled)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
	});

	it('breaks a priority tie by the oldest update first', () => {
		expect(
			order([
				card('newer', { updatedAt: hoursAgo(1).toISOString() }),
				card('older', { updatedAt: hoursAgo(5).toISOString() })
			])
		).toEqual(['older', 'newer']);
	});

	it('puts a stalled in-progress card ahead of an Urgent one, as the API does', () => {
		expect(
			order([
				card('urgent running', { status: 'in_progress', priority: 'p0', latestRunStatus: 'running' }),
				card('stalled low', { status: 'in_progress', priority: 'p4', updatedAt: hoursAgo(49).toISOString() })
			])
		).toEqual(['stalled low', 'urgent running']);
	});

	it('keeps arrival order for cards equal on every key and tolerates a bad date', () => {
		const same = hoursAgo(3).toISOString();
		expect(order([card('a', { updatedAt: same }), card('b', { updatedAt: same })])).toEqual(['a', 'b']);
		expect(order([card('bad', { updatedAt: 'nope' }), card('ok')])).toEqual(['bad', 'ok']);
	});

	it('breaks a full tie on the id, ascending, under both orders — as the API read ends on id ASC', () => {
		const same = hoursAgo(3).toISOString();
		const tied = [
			card('c', { id: 'c0ffee00-0000-4000-8000-000000000003', updatedAt: same }),
			card('a', { id: '0a000000-0000-4000-8000-000000000001', updatedAt: same }),
			card('b', { id: '0b000000-0000-4000-8000-000000000002', updatedAt: same })
		];
		expect(order(tied)).toEqual(['a', 'b', 'c']);
		expect(
			[...tied].sort((x, y) => compareTaskBoardCards(x, y, NOW, undefined, 'updated')).map((c) => c.title)
		).toEqual(['a', 'b', 'c']);
		// The id never outranks a real key.
		expect(
			order([
				card('newer, low id', {
					id: '00000000-0000-4000-8000-000000000000',
					updatedAt: hoursAgo(1).toISOString()
				}),
				card('older, high id', {
					id: 'ffffffff-0000-4000-8000-000000000000',
					updatedAt: hoursAgo(5).toISOString()
				})
			])
		).toEqual(['older, high id', 'newer, low id']);
		// Only one side carries an id: no tie-break, arrival order stands.
		expect(order([card('x', { id: 'ffff', updatedAt: same }), card('y', { updatedAt: same })])).toEqual(['x', 'y']);
	});

	it("orders by priority when the sort is omitted or 'priority' — the same result either way", () => {
		const cards = [
			card('fresh normal', { updatedAt: hoursAgo(1).toISOString() }),
			card('old urgent', { priority: 'p0', updatedAt: hoursAgo(24 * 30).toISOString() }),
			card('stalled low', { status: 'in_progress', priority: 'p4', updatedAt: hoursAgo(49).toISOString() })
		];
		const explicit = [...cards]
			.sort((a, b) => compareTaskBoardCards(a, b, NOW, undefined, 'priority'))
			.map((c) => c.title);
		expect(explicit).toEqual(['stalled low', 'old urgent', 'fresh normal']);
		expect(order(cards)).toEqual(explicit);
	});

	describe("sort: 'updated'", () => {
		const byUpdated = (cards: ReturnType<typeof card>[]) =>
			[...cards].sort((a, b) => compareTaskBoardCards(a, b, NOW, undefined, 'updated')).map((c) => c.title);

		it('puts the most recently updated card first, whatever its priority', () => {
			expect(
				byUpdated([
					card('old urgent', { priority: 'p0', updatedAt: hoursAgo(24 * 30).toISOString() }),
					card('newest low', { priority: 'p4', updatedAt: hoursAgo(1).toISOString() }),
					card('middle high', { priority: 'p1', updatedAt: hoursAgo(5).toISOString() })
				])
			).toEqual(['newest low', 'middle high', 'old urgent']);
		});

		it('does not lift a stalled card — recency is the only key', () => {
			expect(
				byUpdated([
					card('stalled', { status: 'in_progress', updatedAt: hoursAgo(72).toISOString() }),
					card('touched', { status: 'in_progress', updatedAt: hoursAgo(2).toISOString() })
				])
			).toEqual(['touched', 'stalled']);
		});

		it('accepts Date and ISO string updatedAt alike, and keeps arrival order on a tie', () => {
			const same = hoursAgo(3);
			expect(
				byUpdated([
					card('a', { updatedAt: same }),
					card('b', { updatedAt: same.toISOString() }),
					card('newer', { updatedAt: hoursAgo(1) })
				])
			).toEqual(['newer', 'a', 'b']);
		});
	});
});

describe('taskBoardStallCutoff', () => {
	it('is exactly the clamped number of days before now', () => {
		expect(taskBoardStallCutoff(NOW, 2).toISOString()).toBe('2026-09-08T12:00:00.000Z');
		expect(taskBoardStallCutoff(NOW, 99).toISOString()).toBe('2026-08-11T12:00:00.000Z');
	});
});
