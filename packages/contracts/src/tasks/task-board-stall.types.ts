/**
 * Task board — the stall predicate.
 *
 * A Task is stalled when it is `in_progress`, nothing is running for it,
 * and it has not changed for longer than the threshold. All three inputs
 * are already on the Task row, so no new stored state is needed.
 *
 * WHAT THIS COSTS: "has not changed" is read from `updatedAt`, which moves
 * on ANY edit to the row — a title change, a pull-request status refresh.
 * So the predicate UNDER-reports (a touched stalled Task loses its flag until
 * the threshold elapses again) and NEVER over-reports (it cannot call a Task
 * stalled while something runs or something changed). That asymmetry is the
 * reason the signal is derived rather than stored in a new column.
 *
 * The API orders columns with the same rule in SQL; the web board recomputes
 * the flag with this function, so ordering and flag cannot drift.
 */

import type { TaskBoardStatus } from './task-board-columns.types.js';

/** Platform default stall threshold, in days. */
export const TASK_BOARD_DEFAULT_STALL_AFTER_DAYS = 2;
export const TASK_BOARD_MIN_STALL_AFTER_DAYS = 1;
export const TASK_BOARD_MAX_STALL_AFTER_DAYS = 30;

/** Run statuses after which nothing is running for a Task. */
export const TASK_RUN_FINISHED_STATUSES = ['completed', 'failed', 'cancelled'] as const;

const DAY_MS = 86_400_000;

/** Clamp a configured threshold into 1..30; anything unusable is the default of 2. */
export function clampTaskBoardStallAfterDays(value: number | null | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return TASK_BOARD_DEFAULT_STALL_AFTER_DAYS;
	return Math.min(TASK_BOARD_MAX_STALL_AFTER_DAYS, Math.max(TASK_BOARD_MIN_STALL_AFTER_DAYS, Math.floor(value)));
}

/** The instant before which an untouched `in_progress` Task counts as stalled. */
export function taskBoardStallCutoff(now: Date, days: number): Date {
	return new Date(now.getTime() - clampTaskBoardStallAfterDays(days) * DAY_MS);
}

export interface TaskStallInput {
	status: TaskBoardStatus | string;
	/** Mirror of the latest run's status; `null` when the Task was never run. */
	latestRunStatus: string | null | undefined;
	updatedAt: Date | string;
	now: Date;
	stallAfterDays: number | null | undefined;
}

export function isTaskStalled(input: TaskStallInput): boolean {
	if (input.status !== 'in_progress') return false;
	const runStatus = input.latestRunStatus ?? null;
	if (runStatus !== null && !(TASK_RUN_FINISHED_STATUSES as readonly string[]).includes(runStatus)) {
		return false;
	}
	const updated = input.updatedAt instanceof Date ? input.updatedAt : new Date(input.updatedAt);
	if (Number.isNaN(updated.getTime())) return false;
	return (
		updated.getTime() <
		taskBoardStallCutoff(input.now, clampTaskBoardStallAfterDays(input.stallAfterDays)).getTime()
	);
}

/** The fields of a Task card that decide where it sits inside its column. */
export interface TaskBoardOrderInput {
	status: TaskBoardStatus | string;
	/** `p0`..`p4`. */
	priority: string;
	latestRunStatus?: string | null;
	updatedAt: Date | string;
}

function timeOf(value: Date | string): number {
	const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(time) ? 0 : time;
}

/**
 * Card order inside one board column — the same order the API's
 * `stalledThenPriority` read produces, so a card a user moves or pages in
 * lands where the server would have put it:
 *
 *   1. stalled first (see {@link isTaskStalled});
 *   2. then priority, `p0` (Urgent) first — the values sort lexicographically;
 *   3. then the oldest update first, so the longest-waiting work leads.
 *
 * A comparator for `Array.prototype.sort`, which is stable: two cards equal
 * on all three keys keep the order they arrived in.
 */
export function compareTaskBoardCards(
	a: TaskBoardOrderInput,
	b: TaskBoardOrderInput,
	now: Date,
	stallAfterDays: number | null | undefined = TASK_BOARD_DEFAULT_STALL_AFTER_DAYS
): number {
	const stalledA = isTaskStalled({ ...a, latestRunStatus: a.latestRunStatus, now, stallAfterDays });
	const stalledB = isTaskStalled({ ...b, latestRunStatus: b.latestRunStatus, now, stallAfterDays });
	if (stalledA !== stalledB) return stalledA ? -1 : 1;
	if (a.priority !== b.priority) return a.priority < b.priority ? -1 : 1;
	return timeOf(a.updatedAt) - timeOf(b.updatedAt);
}
