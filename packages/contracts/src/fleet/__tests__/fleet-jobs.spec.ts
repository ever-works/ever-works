import { describe, expect, it } from 'vitest';

import {
	clampLeaseTtlSec,
	clampMaxAttempts,
	FLEET_AGENT_TASK_MAX_STEPS,
	FLEET_BROWSER_CAPABILITY,
	FLEET_GPU_CAPABILITY,
	FLEET_JOB_ACTIVE_STATUSES,
	FLEET_JOB_DEFAULT_LEASE_TTL_SEC,
	FLEET_JOB_DEFAULT_MAX_ATTEMPTS,
	FLEET_JOB_KINDS,
	FLEET_JOB_MAX_ATTEMPTS_CEILING,
	FLEET_JOB_MAX_ERROR_LENGTH,
	FLEET_JOB_MAX_LEASE_BATCH,
	FLEET_JOB_MAX_LEASE_TTL_SEC,
	FLEET_JOB_MAX_PAYLOAD_BYTES,
	FLEET_JOB_MAX_REQUIRED_CAPABILITIES,
	FLEET_JOB_MAX_RESULT_BYTES,
	FLEET_JOB_MIN_LEASE_TTL_SEC,
	FLEET_JOB_STATUSES,
	FLEET_JOB_TERMINAL_STATUSES,
	isFleetJobActive,
	isFleetJobKind,
	isFleetJobTerminal,
	isNodeBusy,
	nodeSatisfiesCapabilities,
	type FleetJobKind,
	type FleetJobStatus,
	type FleetNodeLoadView
} from '../fleet-jobs.types.js';

/**
 * The lease protocol's pure surface. These predicates exist so the server,
 * the plugin and the node agree on ONE definition of "terminal", "active"
 * and "leasable" instead of three hand-written copies — so the tests below
 * pin the literal list contents, not just the predicate outcomes: a list
 * that silently gains a member is exactly the drift this file guards.
 */

/** Build a full load view so the defensive cases stay type-honest. */
function load(activeJobCount: number, currentJobKind: FleetJobKind | null = null): FleetNodeLoadView {
	return { activeJobCount, currentJobKind, currentJobId: currentJobKind ? 'j1' : null };
}

/** Values that arrive off the wire where a `FleetJobStatus` is declared. */
const NON_CANONICAL_STATUS_VALUES: Array<[string, unknown]> = [
	['an upper-cased status', 'DONE'],
	['a capitalised status', 'Done'],
	['a leading-space status', ' done'],
	['a synonym', 'complete'],
	['the empty string', ''],
	['null', null],
	['undefined', undefined],
	['zero', 0],
	['an object', {}],
	['an array wrapping the status', ['done']]
];

describe('FLEET_JOB_STATUSES', () => {
	it('lists the five lifecycle states in queue order', () => {
		expect(FLEET_JOB_STATUSES).toEqual(['queued', 'leased', 'running', 'done', 'failed']);
	});

	it('has exactly five members', () => {
		// Count guard: a status added here without updating ACTIVE/TERMINAL
		// silently becomes a state nothing classifies.
		expect(FLEET_JOB_STATUSES).toHaveLength(5);
	});

	it('contains no duplicates', () => {
		expect(new Set(FLEET_JOB_STATUSES).size).toBe(FLEET_JOB_STATUSES.length);
	});
});

describe('FLEET_JOB_ACTIVE_STATUSES', () => {
	it('is exactly the two claim-holding states', () => {
		expect(FLEET_JOB_ACTIVE_STATUSES).toEqual(['leased', 'running']);
	});

	it('has exactly two unique members', () => {
		expect(FLEET_JOB_ACTIVE_STATUSES).toHaveLength(2);
		expect(new Set(FLEET_JOB_ACTIVE_STATUSES).size).toBe(2);
	});
});

describe('FLEET_JOB_TERMINAL_STATUSES', () => {
	it('is exactly the two settled states', () => {
		expect(FLEET_JOB_TERMINAL_STATUSES).toEqual(['done', 'failed']);
	});

	it('has exactly two unique members', () => {
		expect(FLEET_JOB_TERMINAL_STATUSES).toHaveLength(2);
		expect(new Set(FLEET_JOB_TERMINAL_STATUSES).size).toBe(2);
	});
});

describe('status set invariants', () => {
	it('keeps ACTIVE a subset of STATUSES', () => {
		for (const status of FLEET_JOB_ACTIVE_STATUSES) {
			expect(FLEET_JOB_STATUSES).toContain(status);
		}
	});

	it('keeps TERMINAL a subset of STATUSES', () => {
		for (const status of FLEET_JOB_TERMINAL_STATUSES) {
			expect(FLEET_JOB_STATUSES).toContain(status);
		}
	});

	it('keeps ACTIVE and TERMINAL disjoint', () => {
		// A status that is both would make `isFleetJobActive` and
		// `isFleetJobTerminal` true at once, and the sweeper would try to
		// reclaim a lease on a job nothing can transition out of.
		const overlap = FLEET_JOB_ACTIVE_STATUSES.filter((status) => FLEET_JOB_TERMINAL_STATUSES.includes(status));
		expect(overlap).toEqual([]);
	});

	it('leaves exactly queued in NEITHER bucket', () => {
		// The two lists do NOT partition the status set — `queued` is the
		// pre-lease state and deliberately belongs to neither. Pinned by name
		// so a future "tidy-up" that folds queued into ACTIVE breaks loudly
		// rather than making every queued job look like it holds a claim.
		const unclassified = FLEET_JOB_STATUSES.filter(
			(status) => !FLEET_JOB_ACTIVE_STATUSES.includes(status) && !FLEET_JOB_TERMINAL_STATUSES.includes(status)
		);
		expect(unclassified).toEqual(['queued']);
	});
});

describe('isFleetJobTerminal / isFleetJobActive', () => {
	it.each([
		['queued', false, false],
		['leased', false, true],
		['running', false, true],
		['done', true, false],
		['failed', true, false]
	] as Array<[FleetJobStatus, boolean, boolean]>)(
		'classifies %s as terminal=%s active=%s',
		(status, terminal, active) => {
			expect(isFleetJobTerminal(status)).toBe(terminal);
			expect(isFleetJobActive(status)).toBe(active);
		}
	);

	it('stays in lockstep with the canonical lists', () => {
		// Guards the predicate against the list: either one edited alone fails.
		for (const status of FLEET_JOB_STATUSES) {
			expect(isFleetJobTerminal(status)).toBe(FLEET_JOB_TERMINAL_STATUSES.includes(status));
			expect(isFleetJobActive(status)).toBe(FLEET_JOB_ACTIVE_STATUSES.includes(status));
		}
	});

	it('never reports a status as both terminal and active', () => {
		for (const status of FLEET_JOB_STATUSES) {
			expect(isFleetJobTerminal(status) && isFleetJobActive(status)).toBe(false);
		}
	});

	it.each(NON_CANONICAL_STATUS_VALUES)('reports %s as neither terminal nor active', (_label, value) => {
		// Both predicates take a declared `FleetJobStatus`, but the value is a
		// column read off the wire — a near-miss must be inert, not truthy.
		// `toBe(false)` rather than `toBeFalsy`: Array.includes returns a real
		// boolean and a future `undefined` return would be a contract change.
		expect(isFleetJobTerminal(value as FleetJobStatus)).toBe(false);
		expect(isFleetJobActive(value as FleetJobStatus)).toBe(false);
	});
});

describe('FLEET_JOB_KINDS', () => {
	it('lists the three executors', () => {
		expect(FLEET_JOB_KINDS).toEqual(['acceptance-checks', 'agent-task', 'browser-check']);
	});

	it('has exactly three unique members', () => {
		expect(FLEET_JOB_KINDS).toHaveLength(3);
		expect(new Set(FLEET_JOB_KINDS).size).toBe(3);
	});
});

describe('runtime mutability of the job vocabularies', () => {
	it.each([
		['FLEET_JOB_STATUSES', FLEET_JOB_STATUSES],
		['FLEET_JOB_ACTIVE_STATUSES', FLEET_JOB_ACTIVE_STATUSES],
		['FLEET_JOB_TERMINAL_STATUSES', FLEET_JOB_TERMINAL_STATUSES],
		['FLEET_JOB_KINDS', FLEET_JOB_KINDS]
	] as Array<[string, readonly string[]]>)('leaves %s UNFROZEN at runtime', (_name, vocabulary) => {
		// MEASURED, not assumed. Every list here is a plain array literal, so
		// its `readonly FleetJobStatus[]` / `readonly FleetJobKind[]` annotation
		// is a TYPE-SYSTEM guarantee only: at runtime each is an ordinary
		// mutable array, shared by every importer, and a consumer that casts the
		// readonly away really can push a member into the canonical list.
		//
		// Pinned as CURRENT reality — matching how the policy and kb specs pin
		// `Object.isFrozen` for their own vocabularies — so that adding (or
		// removing) an `Object.freeze` here is a loud, deliberate change instead
		// of a silent one in the file that defines what "terminal" means.
		expect(Object.isFrozen(vocabulary)).toBe(false);
	});
});

describe('isFleetJobKind', () => {
	it.each(FLEET_JOB_KINDS.map((kind) => [kind]))('accepts %s', (kind) => {
		// Lockstep with the list: a kind added to FLEET_JOB_KINDS is
		// automatically required to pass the guard.
		expect(isFleetJobKind(kind)).toBe(true);
	});

	it.each([
		['the singular form', 'acceptance-check'],
		['a prefix of a kind', 'browser'],
		['an upper-cased kind', 'AGENT-TASK'],
		['a padded kind', ' agent-task '],
		['a trailing-space kind', 'browser-check '],
		['the empty string', ''],
		['null', null],
		['undefined', undefined],
		['zero', 0],
		['NaN', Number.NaN],
		['true', true],
		['an object', {}],
		['an empty array', []],
		['an array wrapping the kind', ['agent-task']]
	] as Array<[string, unknown]>)('rejects %s', (_label, value) => {
		expect(isFleetJobKind(value)).toBe(false);
	});

	it('rejects a boxed String even though its value matches', () => {
		// `typeof new String('agent-task') === 'object'`, so the typeof check —
		// not the list membership — is what refuses it. Pinned because dropping
		// the typeof guard for a bare `.includes()` would start accepting it.
		expect(isFleetJobKind(new String('agent-task'))).toBe(false);
	});
});

describe('capability tag constants', () => {
	it('names the browser capability', () => {
		// Named here rather than in the node so the enqueue side and the node's
		// own detector cannot drift into two different spellings.
		expect(FLEET_BROWSER_CAPABILITY).toBe('browser');
	});

	it('names the gpu capability', () => {
		expect(FLEET_GPU_CAPABILITY).toBe('gpu');
	});

	it('keeps the two tags distinct', () => {
		expect(FLEET_BROWSER_CAPABILITY).not.toBe(FLEET_GPU_CAPABILITY);
	});
});

describe('numeric limits', () => {
	const LIMITS: Array<[string, number, number]> = [
		['FLEET_JOB_DEFAULT_LEASE_TTL_SEC', FLEET_JOB_DEFAULT_LEASE_TTL_SEC, 300],
		['FLEET_JOB_MIN_LEASE_TTL_SEC', FLEET_JOB_MIN_LEASE_TTL_SEC, 30],
		['FLEET_JOB_MAX_LEASE_TTL_SEC', FLEET_JOB_MAX_LEASE_TTL_SEC, 3600],
		['FLEET_JOB_DEFAULT_MAX_ATTEMPTS', FLEET_JOB_DEFAULT_MAX_ATTEMPTS, 3],
		['FLEET_JOB_MAX_ATTEMPTS_CEILING', FLEET_JOB_MAX_ATTEMPTS_CEILING, 10],
		['FLEET_JOB_MAX_LEASE_BATCH', FLEET_JOB_MAX_LEASE_BATCH, 5],
		['FLEET_JOB_MAX_PAYLOAD_BYTES', FLEET_JOB_MAX_PAYLOAD_BYTES, 262144],
		['FLEET_JOB_MAX_RESULT_BYTES', FLEET_JOB_MAX_RESULT_BYTES, 262144],
		['FLEET_JOB_MAX_ERROR_LENGTH', FLEET_JOB_MAX_ERROR_LENGTH, 4096],
		['FLEET_JOB_MAX_REQUIRED_CAPABILITIES', FLEET_JOB_MAX_REQUIRED_CAPABILITIES, 8],
		['FLEET_AGENT_TASK_MAX_STEPS', FLEET_AGENT_TASK_MAX_STEPS, 16]
	];

	it.each(LIMITS)('pins %s', (_name, actual, expected) => {
		// These caps are mirrored by the API DTOs and by the node app; the
		// literal IS the contract, so it is asserted rather than derived.
		expect(actual).toBe(expected);
	});

	it.each(LIMITS)('keeps %s a positive safe integer', (_name, actual) => {
		expect(Number.isSafeInteger(actual)).toBe(true);
		expect(actual).toBeGreaterThan(0);
	});

	it('expresses the payload cap as 256 KiB', () => {
		expect(FLEET_JOB_MAX_PAYLOAD_BYTES).toBe(256 * 1024);
	});

	it('keeps the payload and result caps symmetric', () => {
		// Deliberate symmetry: a node that may receive 256 KiB must be able to
		// answer with 256 KiB, or a job can be dispatched but never reported.
		expect(FLEET_JOB_MAX_PAYLOAD_BYTES).toBe(FLEET_JOB_MAX_RESULT_BYTES);
	});

	it('orders the lease TTL bounds min < default < max', () => {
		expect(FLEET_JOB_MIN_LEASE_TTL_SEC).toBeLessThan(FLEET_JOB_DEFAULT_LEASE_TTL_SEC);
		expect(FLEET_JOB_DEFAULT_LEASE_TTL_SEC).toBeLessThan(FLEET_JOB_MAX_LEASE_TTL_SEC);
	});

	it('keeps the default attempt budget inside [1, ceiling]', () => {
		expect(FLEET_JOB_DEFAULT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
		expect(FLEET_JOB_DEFAULT_MAX_ATTEMPTS).toBeLessThanOrEqual(FLEET_JOB_MAX_ATTEMPTS_CEILING);
	});
});

describe('clampLeaseTtlSec', () => {
	it.each([
		[300, 300],
		[120, 120],
		[3599, 3599]
	])('passes %d through unchanged', (input, expected) => {
		expect(clampLeaseTtlSec(input)).toBe(expected);
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['a numeric string', '600'],
		['the empty string', ''],
		['true', true],
		['false', false],
		['an object', {}],
		['an empty array', []],
		['an array wrapping a number', [300]],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY],
		['a boxed Number', new Number(300)]
	] as Array<[string, unknown]>)('falls back to the default for %s', (_label, value) => {
		// GOTCHA worth pinning: '600' is NOT parsed. A TTL read from a query
		// string or an env var is silently discarded, not honoured.
		expect(clampLeaseTtlSec(value)).toBe(FLEET_JOB_DEFAULT_LEASE_TTL_SEC);
	});

	it.each([
		['one below the floor', 29, 30],
		['exactly the floor', 30, 30],
		['one above the floor', 31, 31],
		['zero', 0, 30],
		['negative', -1, 30],
		['MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER, 30]
	])('clamps %s up to the floor', (_label, input, expected) => {
		expect(clampLeaseTtlSec(input)).toBe(expected);
	});

	it.each([
		['one below the ceiling', 3599, 3599],
		['exactly the ceiling', 3600, 3600],
		['one above the ceiling', 3601, 3600],
		['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER, 3600]
	])('clamps %s down to the ceiling', (_label, input, expected) => {
		expect(clampLeaseTtlSec(input)).toBe(expected);
	});

	it.each([
		[100.4, 100],
		[100.5, 101],
		[99.5, 100],
		[29.4, 30],
		[29.5, 30],
		[3600.4, 3600],
		[3600.5, 3600],
		[-0.5, 30]
	])('ROUNDS %d (half-up) rather than flooring it, giving %d', (input, expected) => {
		// Math.round, not Math.trunc/Math.floor: 100.5 becomes 101, and .5 always
		// goes toward +Infinity (Math.round(-0.5) is -0, which then clamps to the
		// floor). 3600.5 rounds to 3601 and is then clamped back to 3600.
		expect(clampLeaseTtlSec(input)).toBe(expected);
	});

	it('is total — every input yields an integer inside [min, max]', () => {
		const samples: unknown[] = [
			undefined,
			null,
			'600',
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			-9999,
			0,
			45.7,
			1e12,
			{},
			[]
		];
		for (const sample of samples) {
			const result = clampLeaseTtlSec(sample);
			expect(Number.isInteger(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(FLEET_JOB_MIN_LEASE_TTL_SEC);
			expect(result).toBeLessThanOrEqual(FLEET_JOB_MAX_LEASE_TTL_SEC);
		}
	});
});

describe('clampMaxAttempts', () => {
	it.each([
		[3, 3],
		[5, 5]
	])('passes %d through unchanged', (input, expected) => {
		expect(clampMaxAttempts(input)).toBe(expected);
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['a numeric string', '5'],
		['true', true],
		['an object', {}],
		['an empty array', []],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['-Infinity', Number.NEGATIVE_INFINITY]
	] as Array<[string, unknown]>)('falls back to the DEFAULT (not the floor) for %s', (_label, value) => {
		expect(clampMaxAttempts(value)).toBe(FLEET_JOB_DEFAULT_MAX_ATTEMPTS);
	});

	it('is asymmetric at the bottom: -Infinity yields the default but -1 yields the floor', () => {
		// "Not a finite number" and "too small" take DIFFERENT exits, so two
		// inputs that both mean "nonsense, and small" produce different budgets.
		// Pinned because it is surprising, not because it is desirable.
		expect(clampMaxAttempts(Number.NEGATIVE_INFINITY)).toBe(3);
		expect(clampMaxAttempts(-1)).toBe(1);
		expect(clampMaxAttempts(Number.NEGATIVE_INFINITY)).not.toBe(clampMaxAttempts(-1));
	});

	it.each([
		['zero', 0, 1],
		['exactly the floor', 1, 1],
		['negative', -1, 1],
		['a fraction rounding down to zero', 0.4, 1],
		['a fraction rounding up to one', 0.5, 1]
	])('clamps %s up to the bare literal floor of 1', (_label, input, expected) => {
		// The floor is a hard-coded `1` in the implementation — unlike the TTL
		// clamp, which names FLEET_JOB_MIN/MAX_LEASE_TTL_SEC. There is no
		// constant to import, so the literal is asserted directly.
		expect(clampMaxAttempts(input)).toBe(expected);
	});

	it.each([
		['one below the ceiling', 9, 9],
		['exactly the ceiling', 10, 10],
		['a fraction rounding down to the ceiling', 10.4, 10],
		['a fraction rounding up past the ceiling', 10.5, 10],
		['one above the ceiling', 11, 10],
		['a million', 1e6, 10]
	])('clamps %s down to the ceiling', (_label, input, expected) => {
		expect(clampMaxAttempts(input)).toBe(expected);
	});

	it('is total — every input yields an integer inside [1, ceiling]', () => {
		const samples: unknown[] = [undefined, null, '5', Number.NaN, -1e9, 0, 2.5, 1e9, {}, []];
		for (const sample of samples) {
			const result = clampMaxAttempts(sample);
			expect(Number.isInteger(result)).toBe(true);
			expect(result).toBeGreaterThanOrEqual(1);
			expect(result).toBeLessThanOrEqual(FLEET_JOB_MAX_ATTEMPTS_CEILING);
		}
	});
});

describe('nodeSatisfiesCapabilities', () => {
	it.each([
		['null node capabilities', null],
		['undefined node capabilities', undefined],
		['an empty node capability list', []],
		['a populated node capability list', ['gpu']]
	] as Array<[string, readonly string[] | null | undefined]>)(
		'short-circuits to true for an empty required list with %s',
		(_label, nodeCapabilities) => {
			expect(nodeSatisfiesCapabilities(nodeCapabilities, [])).toBe(true);
		}
	);

	it('treats a null required list as requiring nothing', () => {
		expect(nodeSatisfiesCapabilities(['gpu'], null)).toBe(true);
	});

	it('treats an undefined required list as requiring nothing', () => {
		expect(nodeSatisfiesCapabilities(['gpu'], undefined)).toBe(true);
	});

	it('FAILS OPEN on a non-array required list', () => {
		// The doc comment claims "Fail-closed by construction", but that only
		// holds for the NODE side. `Array.isArray(requiredCapabilities) ? … : []`
		// collapses a truthy non-array (a string arriving off the wire, say)
		// into "requires nothing", so a browser-only job becomes leasable by a
		// node with no browser. Pinned as CURRENT behaviour, not as desirable.
		expect(nodeSatisfiesCapabilities([], 'browser' as unknown as readonly string[])).toBe(true);
		expect(nodeSatisfiesCapabilities(null, 'browser' as unknown as readonly string[])).toBe(true);
	});

	it('matches when the node advertises the single required tag', () => {
		expect(nodeSatisfiesCapabilities(['browser'], ['browser'])).toBe(true);
	});

	it('ignores capabilities the job did not ask for', () => {
		expect(nodeSatisfiesCapabilities(['browser', 'gpu', 'docker', 'terminal'], ['browser'])).toBe(true);
	});

	it('refuses a partial match', () => {
		expect(nodeSatisfiesCapabilities(['browser'], ['browser', 'gpu'])).toBe(false);
	});

	it.each([
		['an empty node list', []],
		['a null node list', null],
		['an undefined node list', undefined],
		['a non-array node list', 'browser' as unknown as readonly string[]]
	] as Array<[string, readonly string[] | null | undefined]>)(
		'fails CLOSED on the node side for %s',
		(_label, nodeCapabilities) => {
			// The node side really is fail-closed: anything that is not an array
			// becomes the empty set, which satisfies no non-empty requirement.
			expect(nodeSatisfiesCapabilities(nodeCapabilities, ['browser'])).toBe(false);
		}
	);

	it('is insensitive to duplicates on either side', () => {
		expect(nodeSatisfiesCapabilities(['gpu'], ['gpu', 'gpu'])).toBe(true);
		expect(nodeSatisfiesCapabilities(['gpu', 'gpu'], ['gpu'])).toBe(true);
	});

	it.each([
		['a differently cased tag', ['Browser']],
		['a leading-space tag', [' browser']]
	] as Array<[string, string[]]>)('matches tags EXACTLY, so it refuses %s', (_label, required) => {
		// No trimming, no case folding: the node advertises tags verbatim and
		// the scheduler compares them verbatim.
		expect(nodeSatisfiesCapabilities(['browser'], required)).toBe(false);
	});

	it('treats the empty string as an ordinary tag', () => {
		expect(nodeSatisfiesCapabilities([], [''])).toBe(false);
		expect(nodeSatisfiesCapabilities([''], [''])).toBe(true);
	});

	it('uses the exported capability constants consistently', () => {
		expect(nodeSatisfiesCapabilities([FLEET_GPU_CAPABILITY], [FLEET_BROWSER_CAPABILITY])).toBe(false);
		expect(
			nodeSatisfiesCapabilities([FLEET_GPU_CAPABILITY, FLEET_BROWSER_CAPABILITY], [FLEET_BROWSER_CAPABILITY])
		).toBe(true);
	});

	it('does NOT enforce FLEET_JOB_MAX_REQUIRED_CAPABILITIES', () => {
		// The cap is a DTO concern (it bounds what may be STORED); this filter
		// is the lease-time predicate and happily evaluates an over-long list.
		const oversized = Array.from({ length: FLEET_JOB_MAX_REQUIRED_CAPABILITIES + 1 }, (_v, i) => `tag-${i}`);
		expect(oversized.length).toBeGreaterThan(FLEET_JOB_MAX_REQUIRED_CAPABILITIES);
		expect(nodeSatisfiesCapabilities(oversized, oversized)).toBe(true);
	});
});

describe('isNodeBusy', () => {
	it('reports an absent load view as idle', () => {
		expect(isNodeBusy(null)).toBe(false);
		expect(isNodeBusy(undefined)).toBe(false);
	});

	it('reports a zero active count as idle', () => {
		expect(isNodeBusy(load(0))).toBe(false);
	});

	it('reports one live claim as busy', () => {
		expect(isNodeBusy(load(1, 'agent-task'))).toBe(true);
	});

	it('reports several live claims as busy', () => {
		expect(isNodeBusy(load(5, 'acceptance-checks'))).toBe(true);
	});

	it('treats a fractional count above zero as busy', () => {
		expect(isNodeBusy(load(0.5))).toBe(true);
	});

	it.each([
		['a negative count', -1],
		['NaN', Number.NaN]
	])('reports %s as idle', (_label, count) => {
		// `NaN > 0` is false, so a corrupt aggregate reads idle rather than
		// pinning the node as permanently busy.
		expect(isNodeBusy(load(count))).toBe(false);
	});

	it('reads ONLY the active count, not a stale current job', () => {
		// A currentJobKind/currentJobId left behind by a finished claim must not
		// make an idle node look busy — otherwise a node never becomes leasable
		// again until the next write clears those fields.
		expect(isNodeBusy({ activeJobCount: 0, currentJobKind: 'browser-check', currentJobId: 'j9' })).toBe(false);
	});

	it('always returns a real boolean', () => {
		// The implementation wraps in Boolean(); without it the `load &&` chain
		// would leak `null`/`undefined` out of a predicate declared `: boolean`.
		expect(typeof isNodeBusy(null)).toBe('boolean');
		expect(typeof isNodeBusy(undefined)).toBe('boolean');
		expect(typeof isNodeBusy(load(0))).toBe('boolean');
		expect(typeof isNodeBusy(load(2, 'agent-task'))).toBe('boolean');
	});
});
