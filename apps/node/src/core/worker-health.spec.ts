import { describe, expect, it } from 'vitest';
import { FLEET_MAX_WORKER_STATE_REASON_LENGTH, FLEET_NODE_WORKER_STATES } from '@ever-works/contracts';
import { describeWorkerHealth } from './worker-health';
import type { WorkerLoopState, WorkerState } from './worker-loop';

/**
 * The projection from the loop's internal state machine onto the five
 * values the fleet wire knows (EW-776).
 *
 * Every `WorkerState` is exercised by name below — not a sample — because
 * the failure this whole slice exists to fix is a state that the platform
 * never heard about. A new member added to `WorkerState` and forgotten
 * here would silently fall into the `idle` default, which is exactly the
 * "healthy and idle" lie a self-quarantined machine was telling.
 */

const state = (over: Partial<WorkerLoopState> = {}): WorkerLoopState => ({
	state: 'idle',
	activeJobIds: [],
	consecutiveFailures: 0,
	completed: 0,
	failed: 0,
	lastError: null,
	paused: false,
	throttleReason: null,
	...over
});

/** Every member of the loop's own union, and what it must report as. */
const MAPPING: Array<[WorkerState, string]> = [
	['idle', 'idle'],
	['polling', 'idle'],
	['retrying', 'idle'],
	['unauthorized', 'idle'],
	['stopped', 'idle'],
	['working', 'working'],
	['paused', 'paused'],
	['draining', 'paused'],
	['throttled', 'throttled'],
	['unsafe', 'quarantined']
];

describe('describeWorkerHealth', () => {
	it.each(MAPPING)('maps the loop state %s to %s', (loopState, expected) => {
		expect(describeWorkerHealth(state({ state: loopState }))?.workerState).toBe(expected);
	});

	it('covers every member of WorkerState', () => {
		// The list above is the contract. If `WorkerState` grows and this
		// does not, the new member falls into the `idle` default unnoticed.
		const covered = new Set(MAPPING.map(([loopState]) => loopState));
		const declared: WorkerState[] = [
			'idle',
			'polling',
			'working',
			'retrying',
			'unauthorized',
			'draining',
			'throttled',
			'paused',
			'unsafe',
			'stopped'
		];
		expect([...covered].sort()).toEqual([...declared].sort());
	});

	it('only ever reports a value the wire contract knows', () => {
		for (const [loopState] of MAPPING) {
			const health = describeWorkerHealth(state({ state: loopState }));
			expect(FLEET_NODE_WORKER_STATES).toContain(health!.workerState);
		}
	});

	it('carries the quarantine reason, which is the sentence the owner needs', () => {
		const health = describeWorkerHealth(
			state({ state: 'unsafe', lastError: 'process tree for job 42 could not be proven terminated' })
		);

		expect(health).toEqual({
			workerState: 'quarantined',
			workerStateReason: 'process tree for job 42 could not be proven terminated'
		});
	});

	it('falls back to a stated reason when a quarantine carries none', () => {
		// "Quarantined, reason unknown" is still far better than the old
		// answer, which was no field at all.
		expect(describeWorkerHealth(state({ state: 'unsafe', lastError: null }))).toEqual({
			workerState: 'quarantined',
			workerStateReason: 'Worker process-tree quarantine is active'
		});
	});

	it('carries the throttle reason so an idle-looking node can explain itself', () => {
		const health = describeWorkerHealth(
			state({ state: 'throttled', throttleReason: 'free disk 1.2 GB is below the 5 GB floor' })
		);

		expect(health).toEqual({
			workerState: 'throttled',
			workerStateReason: 'free disk 1.2 GB is below the 5 GB floor'
		});
	});

	it('omits the reason entirely rather than sending an empty one', () => {
		// Absent means "no reason"; an empty string would render as a blank
		// caption under the badge.
		expect(describeWorkerHealth(state({ state: 'throttled', throttleReason: '   ' }))).toEqual({
			workerState: 'throttled'
		});
		expect(describeWorkerHealth(state({ state: 'paused' }))).toEqual({ workerState: 'paused' });
	});

	it('does not leak a working node’s last error as a reason', () => {
		// `lastError` is the last FAILURE, not a description of the current
		// state. Only the quarantine mapping reads it, because there it IS
		// the quarantine's message.
		expect(describeWorkerHealth(state({ state: 'working', lastError: 'a job failed an hour ago' }))).toEqual({
			workerState: 'working'
		});
	});

	it('truncates a reason to the bound the server enforces', () => {
		const health = describeWorkerHealth(state({ state: 'unsafe', lastError: 'x'.repeat(2_000) }));

		expect(health?.workerStateReason).toHaveLength(FLEET_MAX_WORKER_STATE_REASON_LENGTH);
	});

	it('reports NOTHING for a node with no worker loop at all', () => {
		// A visibility-only daemon has no worker. Reporting `idle` would
		// claim capacity that does not exist; "unknown" is the truth.
		expect(describeWorkerHealth(null)).toBeNull();
		expect(describeWorkerHealth(undefined)).toBeNull();
	});
});
