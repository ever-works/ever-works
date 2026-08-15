import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FLEET_EXECUTION_MODE,
	decideFleetRouting,
	isFleetExecutionMode,
	isLocalExecutionMode,
	QUEUED_REASON_WAITING_FOR_RUNNER,
	resolveFleetExecutionMode,
	summarizeRunnerStatus,
	type FleetExecutionPreferenceView,
	type FleetRunnerAvailability
} from '../index.js';

/**
 * The fleet ROUTING RULE lives in this package as a pure function on
 * purpose: the API router, the settings UI and these tests must agree on
 * one definition of "where does this run go", and a rule embedded in a
 * NestJS service can only be exercised through a DI graph.
 *
 * So the matrix the brief cares about — local-only WAITS, local-fallback
 * FALLS BACK — is asserted here directly, and the service test only has
 * to prove it calls this.
 */

function pref(
	scopeType: FleetExecutionPreferenceView['scopeType'],
	scopeId: string | null,
	mode: FleetExecutionPreferenceView['mode']
): FleetExecutionPreferenceView {
	return { id: `${scopeType}:${scopeId ?? 'account'}`, scopeType, scopeId, mode, createdAt: null, updatedAt: null };
}

const FREE: FleetRunnerAvailability = { total: 2, online: 2, free: 1 };
const ALL_BUSY: FleetRunnerAvailability = { total: 2, online: 2, free: 0 };
const ALL_OFFLINE: FleetRunnerAvailability = { total: 2, online: 0, free: 0 };
const NONE: FleetRunnerAvailability = { total: 0, online: 0, free: 0 };

describe('resolveFleetExecutionMode', () => {
	it('falls back to the default when nothing is configured', () => {
		expect(resolveFleetExecutionMode([], {})).toBe(DEFAULT_FLEET_EXECUTION_MODE);
		expect(resolveFleetExecutionMode(null, { workId: 'w1' })).toBe(DEFAULT_FLEET_EXECUTION_MODE);
		expect(resolveFleetExecutionMode(undefined, {})).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});

	it('uses the account-wide row when no narrower one matches', () => {
		const rows = [pref('user', null, 'cloud')];
		expect(resolveFleetExecutionMode(rows, {})).toBe('cloud');
		expect(resolveFleetExecutionMode(rows, { workId: 'w1', goalId: 'g1' })).toBe('cloud');
	});

	it('lets a Goal row beat the account default', () => {
		const rows = [pref('user', null, 'cloud'), pref('goal', 'g1', 'local-wait')];
		expect(resolveFleetExecutionMode(rows, { goalId: 'g1' })).toBe('local-wait');
		// A different Goal must not inherit g1's setting.
		expect(resolveFleetExecutionMode(rows, { goalId: 'g2' })).toBe('cloud');
	});

	it('lets a Work row beat BOTH the Goal row and the account default', () => {
		const rows = [
			pref('user', null, 'cloud'),
			pref('goal', 'g1', 'local-wait'),
			pref('work', 'w1', 'local-fallback')
		];
		expect(resolveFleetExecutionMode(rows, { workId: 'w1', goalId: 'g1' })).toBe('local-fallback');
	});

	it('ignores rows with an unknown mode instead of returning garbage', () => {
		const rows = [{ ...pref('work', 'w1', 'cloud'), mode: 'teleport' } as FleetExecutionPreferenceView];
		expect(resolveFleetExecutionMode(rows, { workId: 'w1' })).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});

	it('treats an absent scopeId as the account row', () => {
		const rows = [{ ...pref('user', null, 'local-wait'), scopeId: undefined } as FleetExecutionPreferenceView];
		expect(resolveFleetExecutionMode(rows, {})).toBe('local-wait');
	});
});

describe('decideFleetRouting', () => {
	it('sends cloud-mode runs to the cloud with no fallback reason, even with runners free', () => {
		// No `fallbackReason`: nothing was taken away from the user, so
		// nothing should notify them.
		expect(decideFleetRouting('cloud', FREE)).toEqual({ target: 'cloud', mode: 'cloud' });
	});

	it.each(['local-wait', 'local-fallback'] as const)('sends %s to the fleet when a runner is free', (mode) => {
		expect(decideFleetRouting(mode, FREE)).toEqual({ target: 'fleet', mode });
	});

	it('makes local-wait WAIT on the fleet rather than falling back', () => {
		for (const availability of [ALL_BUSY, ALL_OFFLINE, NONE]) {
			const decision = decideFleetRouting('local-wait', availability);
			expect(decision.target).toBe('fleet-waiting');
			expect(decision.queuedReason).toBe(QUEUED_REASON_WAITING_FOR_RUNNER);
			// The whole point of the mode: never relocated.
			expect(decision.fallbackReason).toBeUndefined();
		}
	});

	it('falls local-fallback back to the cloud and NAMES the reason', () => {
		expect(decideFleetRouting('local-fallback', ALL_BUSY)).toEqual({
			target: 'cloud',
			mode: 'local-fallback',
			fallbackReason: 'runners-busy',
			runnerCount: 2
		});
		expect(decideFleetRouting('local-fallback', ALL_OFFLINE)).toEqual({
			target: 'cloud',
			mode: 'local-fallback',
			fallbackReason: 'runners-offline',
			runnerCount: 2
		});
		expect(decideFleetRouting('local-fallback', NONE)).toEqual({
			target: 'cloud',
			mode: 'local-fallback',
			fallbackReason: 'no-runners',
			runnerCount: 0
		});
	});

	it('carries the REAL enrolled-runner count on a fallback', () => {
		// The fallback notification stores this number. The decision is
		// the only place that saw the availability snapshot, so a caller
		// downstream could only guess — and a guess ("busy, so call it
		// 1") is what an owner with four runners would have read.
		const decision = decideFleetRouting('local-fallback', { total: 4, online: 4, free: 0 });

		expect(decision.runnerCount).toBe(4);
	});

	it('carries no count when nothing was taken away', () => {
		// `cloud` and a placed `fleet` run are not fallbacks; there is no
		// notification, so there is nothing to count.
		expect(decideFleetRouting('cloud', FREE).runnerCount).toBeUndefined();
		expect(decideFleetRouting('local-wait', ALL_BUSY).runnerCount).toBeUndefined();
	});
});

describe('mode guards', () => {
	it('accepts only the canonical modes', () => {
		expect(isFleetExecutionMode('local-wait')).toBe(true);
		expect(isFleetExecutionMode('cloud')).toBe(true);
		expect(isFleetExecutionMode('local')).toBe(false);
		expect(isFleetExecutionMode(null)).toBe(false);
	});

	it('classifies which modes route to the fleet at all', () => {
		expect(isLocalExecutionMode('local-wait')).toBe(true);
		expect(isLocalExecutionMode('local-fallback')).toBe(true);
		expect(isLocalExecutionMode('cloud')).toBe(false);
	});
});

describe('summarizeRunnerStatus', () => {
	it('hides the pill when the owner has no runner at all', () => {
		expect(summarizeRunnerStatus({ total: 0, online: 0, busy: 0 })).toBe('none');
	});

	it('reports offline when runners exist but none is up', () => {
		expect(summarizeRunnerStatus({ total: 3, online: 0, busy: 0 })).toBe('offline');
	});

	it('reports busy only when EVERY online runner is holding work', () => {
		expect(summarizeRunnerStatus({ total: 2, online: 2, busy: 2 })).toBe('busy');
		expect(summarizeRunnerStatus({ total: 2, online: 2, busy: 1 })).toBe('online');
	});
});
