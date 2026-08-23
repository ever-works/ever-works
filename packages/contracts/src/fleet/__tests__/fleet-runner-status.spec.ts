import { describe, expect, it } from 'vitest';

import {
	FLEET_RUNNER_STATUS_MAX_REFRESH_SEC,
	FLEET_RUNNER_STATUS_MIN_REFRESH_SEC,
	FLEET_RUNNER_STATUS_REFRESH_SEC,
	summarizeRunnerStatus,
	type FleetRunnerStatusView,
	type FleetRunnerSummaryState
} from '../fleet-runner-status.types.js';

/**
 * NOTE ON COVERAGE SPLIT — `summarizeRunnerStatus` is ALSO exercised from
 * `src/__tests__/fleet-execution-preference.spec.ts` (it imports through the
 * package root barrel), which owns the four canonical cases: {0,0,0} → none,
 * {3,0,0} → offline, {2,2,2} → busy and {2,2,1} → online. This file owns the
 * three refresh-cadence constants (uncovered there) plus the precedence,
 * boundary and defensive edges that four happy cases cannot reach.
 */

const SUMMARY_STATES: readonly FleetRunnerSummaryState[] = ['none', 'offline', 'busy', 'online'];

describe('runner-status refresh cadence constants', () => {
	it('pins the shipped cadence at 30 seconds', () => {
		// The pill's "Refreshes every 30s" caption is generated from this
		// number, and the value is shipped in the payload rather than hard-coded
		// in the component — so the constant and the copy cannot drift apart.
		expect(FLEET_RUNNER_STATUS_REFRESH_SEC).toBe(30);
	});

	it('pins the operator floor at 5 seconds', () => {
		expect(FLEET_RUNNER_STATUS_MIN_REFRESH_SEC).toBe(5);
	});

	it('pins the operator ceiling at 600 seconds', () => {
		expect(FLEET_RUNNER_STATUS_MAX_REFRESH_SEC).toBe(600);
	});

	it('keeps the shipped default clampable to itself', () => {
		// If the default ever fell outside [min, max], the server would clamp
		// its OWN default and ship a cadence nobody configured.
		expect(FLEET_RUNNER_STATUS_MIN_REFRESH_SEC).toBeLessThan(FLEET_RUNNER_STATUS_REFRESH_SEC);
		expect(FLEET_RUNNER_STATUS_REFRESH_SEC).toBeLessThan(FLEET_RUNNER_STATUS_MAX_REFRESH_SEC);
	});

	it.each([
		['FLEET_RUNNER_STATUS_REFRESH_SEC', FLEET_RUNNER_STATUS_REFRESH_SEC],
		['FLEET_RUNNER_STATUS_MIN_REFRESH_SEC', FLEET_RUNNER_STATUS_MIN_REFRESH_SEC],
		['FLEET_RUNNER_STATUS_MAX_REFRESH_SEC', FLEET_RUNNER_STATUS_MAX_REFRESH_SEC]
	])('keeps %s a positive safe integer', (_name, value) => {
		expect(Number.isSafeInteger(value)).toBe(true);
		expect(value).toBeGreaterThan(0);
	});

	it('never allows a sub-second cadence', () => {
		// The pill polls from EVERY dashboard page for EVERY signed-in user; a
		// 0s floor would turn the whole product into a busy loop against the API.
		expect(FLEET_RUNNER_STATUS_MIN_REFRESH_SEC).toBeGreaterThanOrEqual(1);
	});
});

describe('summarizeRunnerStatus — precedence, boundaries and defensive input', () => {
	it.each([
		// The `total <= 0` gate is checked FIRST, so an inconsistent snapshot
		// (a stale online count with no enrolled runners) still HIDES the pill
		// rather than claiming capacity that cannot exist.
		['an inconsistent snapshot with no total', { total: 0, online: 5, busy: 0 }, 'none'],
		['a negative total', { total: -1, online: 0, busy: 0 }, 'none'],

		// `online <= 0` is the second gate.
		['runners that exist but are all down', { total: 2, online: 0, busy: 0 }, 'offline'],
		['a negative online count', { total: 2, online: -1, busy: 0 }, 'offline'],

		// `busy >= online` uses >=, not ===, so an over-count still reads busy.
		['more busy than online', { total: 2, online: 1, busy: 2 }, 'busy'],
		['a wildly over-counted busy', { total: 2, online: 2, busy: 5 }, 'busy'],

		// Off-by-one on the busy comparison, at a size the upstream spec does
		// not use (it owns {2,2,2} and {2,2,1}).
		['one online runner still free', { total: 3, online: 3, busy: 2 }, 'online'],
		['every online runner taken', { total: 3, online: 3, busy: 3 }, 'busy'],

		// Single-runner edges: total 1 is above the gate, not on the wrong side.
		['a single busy runner', { total: 1, online: 1, busy: 1 }, 'busy'],
		['a single free runner', { total: 1, online: 1, busy: 0 }, 'online'],
		['a single down runner', { total: 1, online: 0, busy: 0 }, 'offline']
	] as Array<[string, { total: number; online: number; busy: number }, FleetRunnerSummaryState]>)(
		'summarises %s',
		(_label, status, expected) => {
			expect(summarizeRunnerStatus(status)).toBe(expected);
		}
	);

	it('falls through to online when every field is NaN', () => {
		// Every comparison against NaN is false, so all three gates are skipped
		// and the final `return 'online'` wins. The function is fed straight
		// from a DB aggregate and must be TOTAL — it never throws, and this is
		// the shape of "it never throws" at its most degenerate.
		expect(summarizeRunnerStatus({ total: Number.NaN, online: Number.NaN, busy: Number.NaN })).toBe('online');
	});

	it('reads only total/online/busy from a full runner-status payload', () => {
		// The other fields are deliberately contradictory: offline/drained claim
		// nothing is up and the node row says busy, yet the verdict follows the
		// three scalars alone. Pinned so the summary rule cannot quietly start
		// depending on the wider view shape.
		const view: FleetRunnerStatusView = {
			total: 4,
			online: 4,
			busy: 1,
			offline: 99,
			drained: 99,
			refreshIntervalSec: FLEET_RUNNER_STATUS_REFRESH_SEC,
			loadUnavailable: true,
			nodes: [
				{
					id: 'n1',
					name: 'workhorse',
					kind: 'node',
					status: 'disabled',
					lastHeartbeatAt: null,
					daemonVersion: null,
					cliVersion: null,
					diskFreeBytes: null,
					busy: true,
					activeJobCount: 7,
					currentJobKind: 'agent-task'
				}
			]
		};
		expect(summarizeRunnerStatus(view)).toBe('online');
	});

	it('only ever returns one of the four summary states', () => {
		const samples = [
			{ total: 0, online: 0, busy: 0 },
			{ total: -5, online: 3, busy: 3 },
			{ total: 2, online: 0, busy: 0 },
			{ total: 2, online: 2, busy: 2 },
			{ total: 2, online: 2, busy: 0 },
			{ total: 1, online: 1, busy: 1 },
			{ total: Number.NaN, online: Number.NaN, busy: Number.NaN }
		];
		for (const sample of samples) {
			expect(SUMMARY_STATES).toContain(summarizeRunnerStatus(sample));
		}
	});
});
