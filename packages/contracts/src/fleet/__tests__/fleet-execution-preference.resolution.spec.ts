import { describe, expect, it } from 'vitest';

import {
	DEFAULT_FLEET_EXECUTION_MODE,
	decideFleetRouting,
	FLEET_EXECUTION_MODES,
	FLEET_EXECUTION_SCOPE_TYPES,
	isFleetExecutionMode,
	isLocalExecutionMode,
	QUEUED_REASON_WAITING_FOR_RUNNER,
	resolveFleetExecutionMode,
	type FleetExecutionMode,
	type FleetExecutionPreferenceView,
	type FleetRunnerAvailability
} from '../fleet-execution-preference.types.js';

/**
 * NOTE ON COVERAGE SPLIT — the happy paths of `resolveFleetExecutionMode`
 * and `decideFleetRouting` are owned by `src/__tests__/fleet-execution-
 * preference.spec.ts` (which imports through the package root barrel):
 * narrowest-wins across user/goal/work, the three fallback reasons, the
 * local-wait queue, and the runner count on a fallback.
 *
 * This file deliberately does NOT restate those. It adds the const pins
 * (none of the four exported constants are asserted upstream) and the
 * branches four happy paths cannot reach: the Array.isArray gate, the
 * falsy-scopeId gotcha, the default `scope` parameter, list order, and the
 * exact SHAPE of each decision object.
 *
 * The basename differs from the upstream spec on purpose so two files named
 * `fleet-execution-preference.spec.ts` never coexist in one package.
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

describe('FLEET_EXECUTION_MODES', () => {
	it('lists the three routing modes', () => {
		expect(FLEET_EXECUTION_MODES).toEqual(['local-wait', 'local-fallback', 'cloud']);
	});

	it('has exactly three unique members', () => {
		expect(FLEET_EXECUTION_MODES).toHaveLength(3);
		expect(new Set(FLEET_EXECUTION_MODES).size).toBe(3);
	});
});

describe('DEFAULT_FLEET_EXECUTION_MODE', () => {
	it('is local-fallback', () => {
		// NOT `local-wait`: an unconfigured account that happens to select the
		// fleet runtime must not acquire a new way to have runs sit forever
		// because a laptop is closed. The literal IS the safety property.
		expect(DEFAULT_FLEET_EXECUTION_MODE).toBe('local-fallback');
	});

	it('is a member of the canonical list', () => {
		expect(FLEET_EXECUTION_MODES).toContain(DEFAULT_FLEET_EXECUTION_MODE);
	});

	it('passes its own type guard', () => {
		expect(isFleetExecutionMode(DEFAULT_FLEET_EXECUTION_MODE)).toBe(true);
	});
});

describe('FLEET_EXECUTION_SCOPE_TYPES', () => {
	it('is ordered narrowest first', () => {
		// The ORDER, not just the membership, is pinned: the doc comment says
		// "resolution reads it". It does not — `resolveFleetExecutionMode`
		// hard-codes work → goal → user — so this assertion is the only thing
		// keeping the constant and the hard-coded ladder from silently drifting.
		expect(FLEET_EXECUTION_SCOPE_TYPES).toEqual(['work', 'goal', 'user']);
	});

	it('has exactly three unique members', () => {
		expect(FLEET_EXECUTION_SCOPE_TYPES).toHaveLength(3);
		expect(new Set(FLEET_EXECUTION_SCOPE_TYPES).size).toBe(3);
	});
});

describe('runtime mutability of the execution vocabularies', () => {
	it.each([
		['FLEET_EXECUTION_MODES', FLEET_EXECUTION_MODES],
		['FLEET_EXECUTION_SCOPE_TYPES', FLEET_EXECUTION_SCOPE_TYPES]
	] as Array<[string, readonly string[]]>)('leaves %s UNFROZEN at runtime', (_name, vocabulary) => {
		// MEASURED, not assumed. Both are plain array literals, so the
		// `readonly FleetExecutionMode[]` / `readonly FleetExecutionScopeType[]`
		// annotations are TYPE-SYSTEM guarantees only — at runtime each is an
		// ordinary mutable array shared by the router, the API and the settings
		// UI, and a consumer that casts the readonly away can push into it.
		//
		// FLEET_EXECUTION_MODES is also the allow-list `isFleetExecutionMode`
		// reads, so a runtime push would WIDEN a routing guard. Pinned as
		// CURRENT reality — as the policy and kb specs pin `Object.isFrozen` for
		// their vocabularies — so adding or removing `Object.freeze` is loud.
		expect(Object.isFrozen(vocabulary)).toBe(false);
	});
});

describe('QUEUED_REASON_WAITING_FOR_RUNNER', () => {
	it('is the machine token waiting-for-runner', () => {
		// A UI switches on this string and a log search greps for it, so the
		// literal is the contract — not the fact that some string exists.
		expect(QUEUED_REASON_WAITING_FOR_RUNNER).toBe('waiting-for-runner');
	});
});

describe('isFleetExecutionMode', () => {
	it.each(FLEET_EXECUTION_MODES.map((mode) => [mode]))('accepts %s', (mode) => {
		// Lockstep with the list. This is also what finally covers
		// `local-fallback` — the DEFAULT mode, which the upstream spec never
		// puts through the guard.
		expect(isFleetExecutionMode(mode)).toBe(true);
	});

	it.each([
		['the empty string', ''],
		['a leading-space mode', ' cloud'],
		['a trailing-space mode', 'cloud '],
		['an upper-cased mode', 'CLOUD'],
		['a title-cased mode', 'Local-Wait'],
		['an underscored mode', 'local_wait'],
		['an invented mode', 'fleet'],
		['undefined', undefined],
		['zero', 0],
		['one', 1],
		['true', true],
		['an object', {}],
		['an empty array', []],
		['an array wrapping a mode', ['cloud']]
	] as Array<[string, unknown]>)('rejects %s', (_label, value) => {
		expect(isFleetExecutionMode(value)).toBe(false);
	});

	it('rejects a boxed String even though its value matches', () => {
		expect(isFleetExecutionMode(new String('cloud'))).toBe(false);
	});
});

describe('isLocalExecutionMode', () => {
	it('classifies every canonical mode by whether it is cloud', () => {
		for (const mode of FLEET_EXECUTION_MODES) {
			expect(isLocalExecutionMode(mode)).toBe(mode !== 'cloud');
		}
	});

	it('leaves cloud as the only non-local mode', () => {
		const nonLocal = FLEET_EXECUTION_MODES.filter((mode) => !isLocalExecutionMode(mode));
		expect(nonLocal).toEqual(['cloud']);
	});

	it('fails closed on an unrecognised mode', () => {
		// An allow-list, not a deny-list: an unknown value must not be treated
		// as fleet-bound, because that would route a run at a machine the
		// caller never asked for.
		expect(isLocalExecutionMode('teleport' as unknown as FleetExecutionMode)).toBe(false);
	});
});

describe('resolveFleetExecutionMode — the Array.isArray gate', () => {
	it.each([
		['an object', {}],
		['a string', 'rows'],
		['zero', 0],
		['true', true]
	] as Array<[string, unknown]>)('returns the default for %s', (_label, preferences) => {
		// Distinct from the null/undefined cases the upstream spec covers: this
		// is the `!Array.isArray(...)` half of the same guard, which is what a
		// mis-shaped API response actually hits.
		expect(resolveFleetExecutionMode(preferences as readonly FleetExecutionPreferenceView[])).toBe(
			DEFAULT_FLEET_EXECUTION_MODE
		);
	});
});

describe('resolveFleetExecutionMode — row-level defensiveness', () => {
	it('skips null and undefined entries without throwing', () => {
		// The `entry &&` guard inside `find`. A sparse or partially-hydrated row
		// set must degrade to "no match", never to a TypeError inside routing.
		const rows = [null, undefined, pref('user', null, 'cloud'), null] as unknown as FleetExecutionPreferenceView[];
		expect(resolveFleetExecutionMode(rows, {})).toBe('cloud');
	});

	it('ignores a row whose scopeType is not a known scope', () => {
		const rows = [
			{ ...pref('user', null, 'cloud'), scopeType: 'tenant' } as unknown as FleetExecutionPreferenceView
		];
		expect(resolveFleetExecutionMode(rows, {})).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});

	it('never matches a work row whose scopeId is null against a real workId', () => {
		// The comparison is `(entry.scopeId ?? null) === scopeId`, so an
		// account-shaped row stored under scopeType 'work' is unreachable.
		const rows = [pref('work', null, 'cloud')];
		expect(resolveFleetExecutionMode(rows, { workId: 'w1' })).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});
});

describe('resolveFleetExecutionMode — the fall-through ladder', () => {
	it('falls to the goal row when a workId is supplied but has no row', () => {
		const rows = [pref('user', null, 'cloud'), pref('goal', 'g1', 'local-wait')];
		expect(resolveFleetExecutionMode(rows, { workId: 'w1', goalId: 'g1' })).toBe('local-wait');
	});

	it('falls to the user row when neither the workId nor the goalId has a row', () => {
		const rows = [pref('user', null, 'cloud')];
		expect(resolveFleetExecutionMode(rows, { workId: 'w9', goalId: 'g9' })).toBe('cloud');
	});

	it('falls to the default when nothing matches at any tier', () => {
		const rows = [pref('work', 'w1', 'cloud'), pref('goal', 'g1', 'local-wait')];
		expect(resolveFleetExecutionMode(rows, { workId: 'w2', goalId: 'g2' })).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});

	it('does not let an INVALID narrow row shadow a valid wider one', () => {
		// The upstream spec proves a lone invalid row collapses to the default,
		// which cannot tell "the tier was skipped" from "the tier matched and
		// the value was discarded". Here the user row must still win: the
		// invalid work row is skipped, not treated as a match.
		const rows = [
			{ ...pref('work', 'w1', 'cloud'), mode: 'teleport' } as unknown as FleetExecutionPreferenceView,
			pref('user', null, 'cloud')
		];
		expect(resolveFleetExecutionMode(rows, { workId: 'w1' })).toBe('cloud');
	});

	it('respects tier precedence regardless of list order', () => {
		// The work row is LAST in the array and still beats the user row that
		// comes first: precedence is by scope, not by position.
		const rows = [pref('user', null, 'cloud'), pref('work', 'w1', 'local-wait')];
		expect(resolveFleetExecutionMode(rows, { workId: 'w1' })).toBe('local-wait');
	});

	it('takes the FIRST matching row when a scope is duplicated', () => {
		// `Array.find`, so list order is load-bearing for duplicates — a second
		// row for the same scope is silently unreachable rather than an error.
		const rows = [pref('user', null, 'cloud'), pref('user', null, 'local-wait')];
		expect(resolveFleetExecutionMode(rows, {})).toBe('cloud');
	});
});

describe('resolveFleetExecutionMode — falsy scope ids', () => {
	it('SKIPS the work tier entirely for an empty-string workId', () => {
		// GOTCHA: the tier gate is `workId ? match(...) : null`, a truthiness
		// test rather than `!= null`. An empty-string workId is falsy, so a
		// stored row with scopeId '' is permanently unreachable — it can never
		// be resolved no matter how the caller asks for it.
		const rows = [pref('work', '', 'cloud')];
		expect(resolveFleetExecutionMode(rows, { workId: '' })).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});

	it('SKIPS the goal tier entirely for an empty-string goalId', () => {
		const rows = [pref('goal', '', 'cloud')];
		expect(resolveFleetExecutionMode(rows, { goalId: '' })).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});

	it('falls through to the user row when the empty-string tier is skipped', () => {
		const rows = [pref('work', '', 'cloud'), pref('user', null, 'local-wait')];
		expect(resolveFleetExecutionMode(rows, { workId: '' })).toBe('local-wait');
	});

	it('skips the work tier for an explicitly null workId', () => {
		const rows = [pref('work', 'w1', 'cloud'), pref('user', null, 'local-wait')];
		expect(resolveFleetExecutionMode(rows, { workId: null })).toBe('local-wait');
	});

	it('skips the goal tier for an explicitly null goalId', () => {
		const rows = [pref('goal', 'g1', 'cloud'), pref('user', null, 'local-wait')];
		expect(resolveFleetExecutionMode(rows, { goalId: null })).toBe('local-wait');
	});
});

describe('resolveFleetExecutionMode — default scope parameter', () => {
	it('treats a missing scope argument as the account scope', () => {
		// The upstream spec always passes a scope object; the `= {}` default is
		// what an account-level settings screen actually calls.
		expect(resolveFleetExecutionMode([pref('user', null, 'cloud')])).toBe('cloud');
	});

	it('still returns the default with a missing scope and no user row', () => {
		expect(resolveFleetExecutionMode([pref('work', 'w1', 'cloud')])).toBe(DEFAULT_FLEET_EXECUTION_MODE);
	});
});

describe('resolveFleetExecutionMode — totality', () => {
	it('always returns a canonical mode', () => {
		const rowSets: Array<readonly FleetExecutionPreferenceView[] | null | undefined> = [
			null,
			undefined,
			[],
			[pref('user', null, 'cloud')],
			[{ ...pref('work', 'w1', 'cloud'), mode: 'teleport' } as unknown as FleetExecutionPreferenceView],
			[null as unknown as FleetExecutionPreferenceView]
		];
		for (const rows of rowSets) {
			expect(FLEET_EXECUTION_MODES).toContain(resolveFleetExecutionMode(rows, { workId: 'w1', goalId: 'g1' }));
		}
	});
});

describe('decideFleetRouting — cloud mode', () => {
	it.each([
		['a free runner', FREE],
		['every runner busy', ALL_BUSY],
		['every runner offline', ALL_OFFLINE],
		['no runners at all', NONE]
	] as Array<[string, FleetRunnerAvailability]>)('ignores availability with %s', (_label, availability) => {
		// `toEqual` on the WHOLE object, not property probes: it pins the
		// ABSENCE of fallbackReason / runnerCount / queuedReason. Nothing was
		// taken away from the user, so nothing should notify them.
		expect(decideFleetRouting('cloud', availability)).toEqual({ target: 'cloud', mode: 'cloud' });
	});
});

describe('decideFleetRouting — the free-runner check', () => {
	it('places the run on the fleet even from an otherwise-empty snapshot', () => {
		// `free > 0` is checked before anything else about the snapshot, so an
		// inconsistent aggregate still PLACES the run — and the placed decision
		// carries neither a queuedReason nor a runnerCount.
		expect(decideFleetRouting('local-fallback', { total: 0, online: 0, free: 1 })).toEqual({
			target: 'fleet',
			mode: 'local-fallback'
		});
	});

	it.each([
		['local-wait', 'fleet-waiting'],
		['local-fallback', 'cloud']
	] as Array<[FleetExecutionMode, string]>)('routes %s to %s once free hits zero', (mode, expected) => {
		expect(decideFleetRouting(mode, { total: 2, online: 2, free: 1 }).target).toBe('fleet');
		expect(decideFleetRouting(mode, { total: 2, online: 2, free: 0 }).target).toBe(expected);
		// Negative is on the same side of the boundary as zero: the test is
		// `> 0`, so a corrupt count can never accidentally place a run.
		expect(decideFleetRouting(mode, { total: 2, online: 2, free: -1 }).target).toBe(expected);
	});
});

describe('decideFleetRouting — fallback reason precedence', () => {
	it('reports no-runners even when online is positive', () => {
		// `total <= 0` is tested FIRST, so an inconsistent snapshot tells an
		// owner who has three online runners that they have none. Pinned as
		// CURRENT behaviour — the stored fallback notification says this.
		expect(decideFleetRouting('local-fallback', { total: 0, online: 3, free: 0 })).toEqual({
			target: 'cloud',
			mode: 'local-fallback',
			fallbackReason: 'no-runners',
			runnerCount: 0
		});
	});

	it('reports no-runners for a negative total too', () => {
		expect(decideFleetRouting('local-fallback', { total: -1, online: -1, free: 0 }).fallbackReason).toBe(
			'no-runners'
		);
	});

	it('counts TOTAL enrolled runners, not the online or free ones', () => {
		expect(decideFleetRouting('local-fallback', { total: 7, online: 2, free: 0 })).toEqual({
			target: 'cloud',
			mode: 'local-fallback',
			fallbackReason: 'runners-busy',
			runnerCount: 7
		});
	});
});

describe('decideFleetRouting — decision shapes', () => {
	it('gives a waiting decision exactly three keys', () => {
		// `toEqual` pins that no fallbackReason and no runnerCount key leaks
		// onto the waiting path — the upstream spec's property-by-property
		// assertions cannot see an extra key appearing.
		expect(decideFleetRouting('local-wait', ALL_BUSY)).toEqual({
			target: 'fleet-waiting',
			mode: 'local-wait',
			queuedReason: QUEUED_REASON_WAITING_FOR_RUNNER
		});
	});

	it('gives a placed fleet decision no queuedReason', () => {
		// queuedReason is only meaningful for `fleet-waiting`; a placed run that
		// carried one would show up in the UI as queued behind a runner.
		const decision = decideFleetRouting('local-wait', FREE);
		expect(decision).toEqual({ target: 'fleet', mode: 'local-wait' });
		expect(decision.queuedReason).toBeUndefined();
	});

	it('treats an unrecognised mode like local-fallback rather than throwing', () => {
		// There is no mode validation inside the router: anything that is not
		// 'cloud' and not 'local-wait' takes the fallback exit, and the unknown
		// mode is echoed back verbatim. Pinned as CURRENT behaviour.
		expect(decideFleetRouting('teleport' as unknown as FleetExecutionMode, ALL_BUSY)).toEqual({
			target: 'cloud',
			mode: 'teleport',
			fallbackReason: 'runners-busy',
			runnerCount: 2
		});
	});
});

describe('decideFleetRouting — the whole 3 x 4 grid', () => {
	const AVAILABILITIES: Array<[string, FleetRunnerAvailability]> = [
		['FREE', FREE],
		['ALL_BUSY', ALL_BUSY],
		['ALL_OFFLINE', ALL_OFFLINE],
		['NONE', NONE]
	];

	const EXPECTED_TARGETS: Record<FleetExecutionMode, Record<string, string>> = {
		'local-wait': { FREE: 'fleet', ALL_BUSY: 'fleet-waiting', ALL_OFFLINE: 'fleet-waiting', NONE: 'fleet-waiting' },
		'local-fallback': { FREE: 'fleet', ALL_BUSY: 'cloud', ALL_OFFLINE: 'cloud', NONE: 'cloud' },
		cloud: { FREE: 'cloud', ALL_BUSY: 'cloud', ALL_OFFLINE: 'cloud', NONE: 'cloud' }
	};

	it.each(
		FLEET_EXECUTION_MODES.flatMap((mode) =>
			AVAILABILITIES.map(
				([label, availability]) =>
					[mode, label, EXPECTED_TARGETS[mode][label], availability] as [
						FleetExecutionMode,
						string,
						string,
						FleetRunnerAvailability
					]
			)
		)
	)('routes %s with %s to %s', (mode, _label, expected, availability) => {
		// One regression net over the entire matrix. It asserts only `target`
		// on purpose — the detail assertions live in the describes above and in
		// the upstream spec, and duplicating them here would just add noise.
		expect(decideFleetRouting(mode, availability).target).toBe(expected);
	});
});
