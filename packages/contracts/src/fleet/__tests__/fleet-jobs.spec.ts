import { describe, expect, it } from 'vitest';

import { INBOX_MAX_BODY_CHARS, INBOX_MAX_TITLE_CHARS } from '../../inbox/inbox.types.js';
import {
	clampLeaseTtlSec,
	clampMaxAttempts,
	FLEET_AGENT_TASK_MAX_STEPS,
	FLEET_AGENT_TASK_META_DIR,
	FLEET_AGENT_TASK_QUESTION_FILE,
	FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES,
	FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES,
	FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS,
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
	normalizeFleetAgentTaskQuestion,
	parseFleetAgentTaskQuestionMarkdown,
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
		['FLEET_AGENT_TASK_MAX_STEPS', FLEET_AGENT_TASK_MAX_STEPS, 16],
		// Owner question (self-build slice Q): the node never reads more than
		// the file cap, the question line shares the Inbox title cap, and the
		// context cap keeps title + context inside the Inbox body cap.
		['FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES', FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES, 65536],
		['FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS', FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS, 300],
		['FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES', FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES, 6144]
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

	it('keeps the question caps inside the Inbox caps and far below the result cap', () => {
		// The question line becomes the Inbox item's title verbatim, and the
		// body is `text + blank line + context`, so both have to fit the Inbox
		// writer caps or the reconciler would have to cut a second time. The
		// file cap stays well under HALF the result cap: an oversize result
		// is REJECTED by the platform, and a question run must never fail
		// its report over the size of what it asked.
		expect(FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS).toBe(INBOX_MAX_TITLE_CHARS);
		expect(
			FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES + FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS + 2
		).toBeLessThanOrEqual(INBOX_MAX_BODY_CHARS);
		expect(FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES).toBeLessThan(FLEET_JOB_MAX_RESULT_BYTES / 2);
	});
});

describe('owner question file constants (self-build slice Q)', () => {
	it('names the reserved directory and the question file inside it', () => {
		// The node builds the OS path from these two, the planner tells the
		// model the same relative path, and the node excludes the directory
		// from Git — three consumers, one spelling.
		expect(FLEET_AGENT_TASK_META_DIR).toBe('.ever-works');
		expect(FLEET_AGENT_TASK_QUESTION_FILE).toBe('.ever-works/QUESTION.md');
		expect(FLEET_AGENT_TASK_QUESTION_FILE.startsWith(`${FLEET_AGENT_TASK_META_DIR}/`)).toBe(true);
	});

	it('is case-exact (ext4 would not find `question.md`)', () => {
		expect(FLEET_AGENT_TASK_QUESTION_FILE).not.toBe(FLEET_AGENT_TASK_QUESTION_FILE.toLowerCase());
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

/** The two characters the escape-averse tests below need, built without `\u` escapes. */
const BOM = String.fromCharCode(0xfeff);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
/** True when the string's last UTF-16 unit is an unpaired high surrogate (a torn code point). */
const endsWithLoneHighSurrogate = (value: string): boolean => {
	const last = value.charCodeAt(value.length - 1);
	return last >= 0xd800 && last <= 0xdbff;
};

describe('parseFleetAgentTaskQuestionMarkdown (self-build slice Q)', () => {
	it('takes a `# ` heading as the question, without the marker', () => {
		expect(parseFleetAgentTaskQuestionMarkdown('# Which database?\n\nPostgres or SQLite?')).toEqual({
			text: 'Which database?',
			context: 'Postgres or SQLite?',
			truncated: false,
			mountDir: null
		});
	});

	it('takes a plain first line as the question', () => {
		expect(parseFleetAgentTaskQuestionMarkdown('Which database?')).toEqual({
			text: 'Which database?',
			context: null,
			truncated: false,
			mountDir: null
		});
	});

	it('skips a UTF-8 BOM and leading blank lines', () => {
		const parsed = parseFleetAgentTaskQuestionMarkdown(`${BOM}\n\n   \n## Ship it?\nContext.`);
		expect(parsed?.text).toBe('Ship it?');
		expect(parsed?.context).toBe('Context.');
	});

	it('leaves no carriage return behind on CRLF input', () => {
		const parsed = parseFleetAgentTaskQuestionMarkdown('# Which DB?\r\n\r\nPostgres\r\nor SQLite\r\n');
		expect(parsed?.text).toBe('Which DB?');
		expect(parsed?.context).toBe('Postgres\nor SQLite');
		expect(parsed?.text).not.toContain('\r');
		expect(parsed?.context).not.toContain('\r');
	});

	it('trims the remainder into context and reports null context when nothing is left', () => {
		expect(parseFleetAgentTaskQuestionMarkdown('Question?\n\n\n  \n')?.context).toBeNull();
		expect(parseFleetAgentTaskQuestionMarkdown('Question?\n\n  - a\n  - b  \n\n')?.context).toBe('- a\n  - b');
	});

	it.each([
		['the empty string', ''],
		['whitespace only', '   \n\t\n'],
		['heading markers only', '#\n##\n'],
		['a BOM only', BOM]
	])('returns null for %s — a blank file is not a question', (_label, input) => {
		expect(parseFleetAgentTaskQuestionMarkdown(input)).toBeNull();
	});

	it('keeps a long first line whole by moving it into the context', () => {
		// A 400-char question line: the title is the first 300 code points,
		// the FULL line is prepended to the context, so nothing was dropped
		// and `truncated` is honestly false.
		const line = Array.from({ length: 80 }, (_v, i) => `word${i}`).join(' ');
		expect(line.length).toBeGreaterThan(300);
		const parsed = parseFleetAgentTaskQuestionMarkdown(`${line}\nMore.`);
		expect(parsed).not.toBeNull();
		expect(Array.from(parsed!.text)).toHaveLength(Array.from(line).slice(0, 300).join('').trimEnd().length);
		expect(line.startsWith(parsed!.text)).toBe(true);
		expect(parsed!.context?.startsWith(line)).toBe(true);
		expect(parsed!.context?.endsWith('More.')).toBe(true);
		expect(parsed!.truncated).toBe(false);
	});

	it('cuts oversize multi-byte context on a code-point boundary and says so', () => {
		// 'a' + 3000 three-byte characters = 9001 bytes. The 6144-byte cap
		// lands two bytes into a character, which must be dropped whole —
		// never decoded into a replacement character.
		const context = `a${'中'.repeat(3000)}`;
		const parsed = parseFleetAgentTaskQuestionMarkdown(`Q?\n\n${context}`);
		expect(parsed?.truncated).toBe(true);
		expect(parsed?.context).toBe(`a${'中'.repeat(2047)}`);
		expect(parsed?.context).not.toContain(REPLACEMENT_CHAR);
		expect(new TextEncoder().encode(parsed!.context!).length).toBeLessThanOrEqual(
			FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES
		);
	});

	it('never splits a surrogate pair when capping the question line', () => {
		const parsed = parseFleetAgentTaskQuestionMarkdown('😀'.repeat(301));
		expect(Array.from(parsed!.text)).toHaveLength(300);
		expect(endsWithLoneHighSurrogate(parsed!.text)).toBe(false);
		// The full line is preserved in the context, so still not truncated.
		expect(parsed!.context).toBe('😀'.repeat(301));
		expect(parsed!.truncated).toBe(false);
	});

	it('strips control characters and ANSI escapes, and skips a line that is nothing but control characters (review SR-3)', () => {
		// A binary head or a terminal-coloured paste: NUL / BEL / DEL and the
		// CSI colour codes go, a tab stays, and a line of only NULs is not
		// the question — the real one below it is.
		const parsed = parseFleetAgentTaskQuestionMarkdown(
			'\x00\x01\n\x1B[31mWhich\x00 DB?\x1B[0m\r\n\x07Context\x7F\tindented.'
		);
		expect(parsed).toEqual({ text: 'Which DB?', context: 'Context\tindented.', truncated: false, mountDir: null });
		expect(parseFleetAgentTaskQuestionMarkdown('\x00\n\x1B\n')).toBeNull();
	});

	it('passes the mount directory through and defaults it to null', () => {
		expect(parseFleetAgentTaskQuestionMarkdown('Q?', 'template')?.mountDir).toBe('template');
		expect(parseFleetAgentTaskQuestionMarkdown('Q?')?.mountDir).toBeNull();
		expect(parseFleetAgentTaskQuestionMarkdown('Q?', null)?.mountDir).toBeNull();
	});

	it('returns null for a non-string without throwing', () => {
		expect(parseFleetAgentTaskQuestionMarkdown(undefined as unknown as string)).toBeNull();
		expect(parseFleetAgentTaskQuestionMarkdown(42 as unknown as string)).toBeNull();
	});
});

describe('normalizeFleetAgentTaskQuestion (self-build slice Q)', () => {
	it.each([
		['null', null],
		['undefined', undefined],
		['a string', 'Which DB?'],
		['an array', ['Which DB?']],
		['a number', 7],
		['an object without text', { context: 'x' }],
		['a non-string text', { text: 42 }],
		['a blank text', { text: '   ' }],
		['a text of only newlines', { text: '\n\n' }]
	] as Array<[string, unknown]>)('returns null for %s', (_label, value) => {
		expect(normalizeFleetAgentTaskQuestion(value)).toBeNull();
	});

	it('keeps only the first line of a multi-line text', () => {
		expect(normalizeFleetAgentTaskQuestion({ text: 'a\nb' })).toEqual({
			text: 'a',
			context: null,
			truncated: false,
			mountDir: null
		});
	});

	it('trims text and context, and ignores a non-string context', () => {
		expect(normalizeFleetAgentTaskQuestion({ text: '  Q?  ', context: '  why  ' })).toEqual({
			text: 'Q?',
			context: 'why',
			truncated: false,
			mountDir: null
		});
		expect(normalizeFleetAgentTaskQuestion({ text: 'Q?', context: 12 })?.context).toBeNull();
		expect(normalizeFleetAgentTaskQuestion({ text: 'Q?', context: '   ' })?.context).toBeNull();
	});

	it('re-caps an oversize text and context and marks the cut', () => {
		const result = normalizeFleetAgentTaskQuestion({ text: 'x'.repeat(400), context: 'y'.repeat(10_000) });
		expect(result?.text).toHaveLength(FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS);
		expect(result?.context).toHaveLength(FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES);
		expect(result?.truncated).toBe(true);
	});

	it('preserves a sticky truncated flag and never invents one', () => {
		expect(normalizeFleetAgentTaskQuestion({ text: 'Q?', truncated: true })?.truncated).toBe(true);
		expect(normalizeFleetAgentTaskQuestion({ text: 'Q?', truncated: 'yes' })?.truncated).toBe(false);
		expect(normalizeFleetAgentTaskQuestion({ text: 'Q?' })?.truncated).toBe(false);
	});

	it('strips C0 controls, DEL and ANSI escapes from text and context, keeping tabs (review SR-3)', () => {
		// A NUL in `text` would make the reconciler's first Postgres write
		// throw and leave the run `running`; ESC sequences would reach the
		// Inbox title as-is.
		expect(normalizeFleetAgentTaskQuestion({ text: '\x1B[1mQ\x00?\x1B[0m', context: 'a\tb\x00\x7Fc' })).toEqual({
			text: 'Q?',
			context: 'a\tbc',
			truncated: false,
			mountDir: null
		});
		expect(normalizeFleetAgentTaskQuestion({ text: '\x00\x00' })).toBeNull();
		expect(normalizeFleetAgentTaskQuestion({ text: '\x00\nReal question?' })?.text).toBe('Real question?');
	});

	it('drops every key it does not declare — a smuggled id never reaches a consumer', () => {
		const result = normalizeFleetAgentTaskQuestion({ text: 'q', userId: 'x', taskId: 'y', agentRunId: 'z' });
		expect(Object.keys(result!).sort()).toEqual(['context', 'mountDir', 'text', 'truncated']);
	});

	it.each([
		['a traversal', '../x'],
		['a nested path', 'a/b'],
		['a backslash path', 'a\\b'],
		['a blank string', '   '],
		['the empty string', ''],
		['a non-string', 7],
		['an over-long name', 'm'.repeat(65)]
	] as Array<[string, unknown]>)('nulls a mountDir that is %s', (_label, mountDir) => {
		expect(normalizeFleetAgentTaskQuestion({ text: 'q', mountDir })?.mountDir).toBeNull();
	});

	it('keeps a well-formed mountDir', () => {
		expect(normalizeFleetAgentTaskQuestion({ text: 'q', mountDir: 'template-1.0_x' })?.mountDir).toBe(
			'template-1.0_x'
		);
	});

	it('is idempotent — normalizing its own output changes nothing', () => {
		const once = normalizeFleetAgentTaskQuestion({
			text: 'Which DB?',
			context: 'Postgres or SQLite',
			truncated: true,
			mountDir: 'template'
		});
		expect(normalizeFleetAgentTaskQuestion(once)).toEqual(once);
	});
});
