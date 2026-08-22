import { describe, expect, it } from 'vitest';

import {
	FLEET_CREDENTIAL_MAX_LENGTH,
	FLEET_CREDENTIAL_MIN_LENGTH,
	FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS,
	FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH,
	FLEET_DEFAULT_MAX_CAPABILITY_TAGS,
	FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS,
	FLEET_ENROLLABLE_NODE_KINDS,
	FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING,
	FLEET_MAX_CAPABILITY_TAGS_CEILING,
	FLEET_MAX_CLI_VERSION_LENGTH,
	FLEET_MAX_DISK_FREE_BYTES,
	FLEET_MAX_NODE_NAME_LENGTH,
	FLEET_MAX_PLATFORM_LENGTH,
	FLEET_MAX_VERSION_LENGTH,
	FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS,
	FLEET_MIN_NODE_NAME_LENGTH,
	FLEET_MIN_NODE_OFFLINE_AFTER_MS,
	FLEET_NODE_KINDS,
	FLEET_NODE_NON_LEASABLE_STATUSES,
	FLEET_NODE_STATUSES,
	isFleetEnrollableNodeKind
} from '../fleet-node.types.js';

/**
 * The node registry's runtime surface: two kind lists, two status lists,
 * one guard and the protocol bounds. Everything here used to exist as a
 * hand-written MIRROR inside the node apps, so the point of these tests is
 * the LITERALS — a member quietly added or dropped is the exact failure
 * mode moving the shapes into contracts was meant to end.
 */

/** Every numeric constant in the module, for the blanket sanity checks. */
function BOUNDS_AND_TUNABLES(): Array<[string, number]> {
	return [
		['FLEET_MAX_PLATFORM_LENGTH', FLEET_MAX_PLATFORM_LENGTH],
		['FLEET_MAX_VERSION_LENGTH', FLEET_MAX_VERSION_LENGTH],
		['FLEET_MAX_CLI_VERSION_LENGTH', FLEET_MAX_CLI_VERSION_LENGTH],
		['FLEET_MAX_DISK_FREE_BYTES', FLEET_MAX_DISK_FREE_BYTES],
		['FLEET_MIN_NODE_NAME_LENGTH', FLEET_MIN_NODE_NAME_LENGTH],
		['FLEET_MAX_NODE_NAME_LENGTH', FLEET_MAX_NODE_NAME_LENGTH],
		['FLEET_CREDENTIAL_MIN_LENGTH', FLEET_CREDENTIAL_MIN_LENGTH],
		['FLEET_CREDENTIAL_MAX_LENGTH', FLEET_CREDENTIAL_MAX_LENGTH],
		['FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS', FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS],
		['FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS', FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS],
		['FLEET_DEFAULT_MAX_CAPABILITY_TAGS', FLEET_DEFAULT_MAX_CAPABILITY_TAGS],
		['FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH', FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH],
		['FLEET_MAX_CAPABILITY_TAGS_CEILING', FLEET_MAX_CAPABILITY_TAGS_CEILING],
		['FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING', FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING],
		['FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS', FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS],
		['FLEET_MIN_NODE_OFFLINE_AFTER_MS', FLEET_MIN_NODE_OFFLINE_AFTER_MS]
	];
}

describe('FLEET_NODE_KINDS', () => {
	it('lists the three node kinds', () => {
		expect(FLEET_NODE_KINDS).toEqual(['desktop-node', 'node', 'k8s']);
	});

	it('has exactly three unique members', () => {
		expect(FLEET_NODE_KINDS).toHaveLength(3);
		expect(new Set(FLEET_NODE_KINDS).size).toBe(3);
	});
});

describe('FLEET_ENROLLABLE_NODE_KINDS', () => {
	it('lists only the kinds a machine can enroll as', () => {
		expect(FLEET_ENROLLABLE_NODE_KINDS).toEqual(['desktop-node', 'node']);
	});

	it('has exactly two unique members', () => {
		expect(FLEET_ENROLLABLE_NODE_KINDS).toHaveLength(2);
		expect(new Set(FLEET_ENROLLABLE_NODE_KINDS).size).toBe(2);
	});

	it('is a subset of FLEET_NODE_KINDS', () => {
		for (const kind of FLEET_ENROLLABLE_NODE_KINDS) {
			expect(FLEET_NODE_KINDS).toContain(kind);
		}
	});

	it('excludes k8s in both directions', () => {
		// Cluster rows are merged into list responses live and never persisted,
		// so a machine must never be able to enroll AS one. Asserting both
		// halves means neither a removal from KINDS nor an addition to
		// ENROLLABLE can slip through unnoticed.
		expect(FLEET_NODE_KINDS).toContain('k8s');
		expect(FLEET_ENROLLABLE_NODE_KINDS).not.toContain('k8s');
	});

	it('leaves exactly k8s as the non-enrollable complement', () => {
		const complement = FLEET_NODE_KINDS.filter(
			(kind) => !(FLEET_ENROLLABLE_NODE_KINDS as readonly string[]).includes(kind)
		);
		expect(complement).toEqual(['k8s']);
	});
});

describe('isFleetEnrollableNodeKind', () => {
	it.each(FLEET_ENROLLABLE_NODE_KINDS.map((kind) => [kind]))('accepts %s', (kind) => {
		expect(isFleetEnrollableNodeKind(kind)).toBe(true);
	});

	it('rejects k8s', () => {
		// The entire reason this guard exists: a config file or an enroll body
		// naming `k8s` must be refused at the edge, not persisted as a row.
		expect(isFleetEnrollableNodeKind('k8s')).toBe(false);
	});

	it('stays in lockstep with FLEET_ENROLLABLE_NODE_KINDS', () => {
		for (const kind of FLEET_NODE_KINDS) {
			expect(isFleetEnrollableNodeKind(kind)).toBe(
				(FLEET_ENROLLABLE_NODE_KINDS as readonly string[]).includes(kind)
			);
		}
	});

	it.each([
		['the empty string', ''],
		['a leading-space kind', ' node'],
		['a trailing-space kind', 'node '],
		['a capitalised kind', 'Node'],
		['an upper-cased kind', 'NODE'],
		['an underscored kind', 'desktop_node'],
		['a space-separated kind', 'desktop node'],
		['a squashed kind', 'desktopnode'],
		['an invented kind', 'worker'],
		['null', null],
		['undefined', undefined],
		['zero', 0],
		['one', 1],
		['true', true],
		['an object', {}],
		['an empty array', []],
		['an array wrapping the kind', ['node']]
	] as Array<[string, unknown]>)('rejects %s', (_label, value) => {
		expect(isFleetEnrollableNodeKind(value)).toBe(false);
	});

	it('rejects a boxed String even though its value matches', () => {
		// `typeof new String('node') === 'object'`, so the typeof check is what
		// refuses it — dropping that guard for a bare `.includes()` would not.
		expect(isFleetEnrollableNodeKind(new String('node'))).toBe(false);
	});
});

describe('FLEET_NODE_STATUSES', () => {
	it('lists the five lifecycle states', () => {
		expect(FLEET_NODE_STATUSES).toEqual(['enrolling', 'online', 'offline', 'paused', 'disabled']);
	});

	it('has exactly five unique members', () => {
		expect(FLEET_NODE_STATUSES).toHaveLength(5);
		expect(new Set(FLEET_NODE_STATUSES).size).toBe(5);
	});

	it('includes paused', () => {
		// Explicit regression guard, per this file's own history: `paused` was
		// once MISSING from this canonical list while being a fully supported
		// FleetNodeStatus, so status filters and legend rendering — anything
		// iterating the list — silently skipped a real state.
		expect(FLEET_NODE_STATUSES).toContain('paused');
	});
});

describe('FLEET_NODE_NON_LEASABLE_STATUSES', () => {
	it('lists the three statuses that refuse new work', () => {
		expect(FLEET_NODE_NON_LEASABLE_STATUSES).toEqual(['enrolling', 'paused', 'disabled']);
	});

	it('has exactly three unique members', () => {
		expect(FLEET_NODE_NON_LEASABLE_STATUSES).toHaveLength(3);
		expect(new Set(FLEET_NODE_NON_LEASABLE_STATUSES).size).toBe(3);
	});

	it('is a subset of FLEET_NODE_STATUSES', () => {
		for (const status of FLEET_NODE_NON_LEASABLE_STATUSES) {
			expect(FLEET_NODE_STATUSES).toContain(status);
		}
	});

	it('leaves online AND offline leasable', () => {
		// Today `offline` is NOT in the non-leasable list: a node that is out of
		// heartbeat can still be handed queued work, which it picks up when it
		// returns. Pinned so that treating offline as non-leasable becomes a
		// deliberate decision rather than a silent drift — the same class of
		// omission this file's doc block describes for `paused`.
		const leasable = FLEET_NODE_STATUSES.filter(
			(status) => !(FLEET_NODE_NON_LEASABLE_STATUSES as readonly string[]).includes(status)
		);
		expect(leasable).toEqual(['online', 'offline']);
	});
});

describe('runtime mutability of the node vocabularies', () => {
	it.each([
		['FLEET_NODE_KINDS', FLEET_NODE_KINDS],
		['FLEET_ENROLLABLE_NODE_KINDS', FLEET_ENROLLABLE_NODE_KINDS],
		['FLEET_NODE_STATUSES', FLEET_NODE_STATUSES],
		['FLEET_NODE_NON_LEASABLE_STATUSES', FLEET_NODE_NON_LEASABLE_STATUSES]
	] as Array<[string, readonly string[]]>)('leaves %s UNFROZEN at runtime', (_name, vocabulary) => {
		// MEASURED, not assumed. All four are plain array literals: the
		// `readonly FleetNodeKind[]` / `readonly FleetNodeStatus[]` annotations
		// are TYPE-SYSTEM guarantees only, so at runtime each list is an
		// ordinary mutable array shared by the platform API and every node app.
		//
		// It matters most HERE, because these particular lists gate enrollment
		// and leasing: nothing at runtime stops a caster from pushing 'k8s' into
		// FLEET_ENROLLABLE_NODE_KINDS. Pinned as CURRENT reality, the way the
		// policy and kb specs pin `Object.isFrozen` for their vocabularies, so
		// adding or removing an `Object.freeze` is a deliberate, visible change.
		expect(Object.isFrozen(vocabulary)).toBe(false);
	});
});

describe('protocol bounds', () => {
	const BOUNDS: Array<[string, number, number]> = [
		['FLEET_MAX_PLATFORM_LENGTH', FLEET_MAX_PLATFORM_LENGTH, 64],
		['FLEET_MAX_VERSION_LENGTH', FLEET_MAX_VERSION_LENGTH, 32],
		['FLEET_MAX_CLI_VERSION_LENGTH', FLEET_MAX_CLI_VERSION_LENGTH, 64],
		['FLEET_MIN_NODE_NAME_LENGTH', FLEET_MIN_NODE_NAME_LENGTH, 1],
		['FLEET_MAX_NODE_NAME_LENGTH', FLEET_MAX_NODE_NAME_LENGTH, 200],
		['FLEET_CREDENTIAL_MIN_LENGTH', FLEET_CREDENTIAL_MIN_LENGTH, 16],
		['FLEET_CREDENTIAL_MAX_LENGTH', FLEET_CREDENTIAL_MAX_LENGTH, 256]
	];

	it.each(BOUNDS)('pins %s', (_name, actual, expected) => {
		// The node app truncates to these same numbers before sending; the
		// literal is the shared contract, so it is asserted rather than derived.
		expect(actual).toBe(expected);
	});

	it('pins FLEET_MAX_DISK_FREE_BYTES at 2 ** 60', () => {
		expect(FLEET_MAX_DISK_FREE_BYTES).toBe(2 ** 60);
		expect(FLEET_MAX_DISK_FREE_BYTES).toBe(1152921504606846976);
	});

	it('leaves FLEET_MAX_DISK_FREE_BYTES OUTSIDE the safe-integer range', () => {
		// 2 ** 60 exceeds Number.MAX_SAFE_INTEGER, so every comparison against
		// it is a float comparison. Pinned so nobody "fixes" the value into a
		// safe integer and quietly changes the accepted range.
		expect(Number.isSafeInteger(FLEET_MAX_DISK_FREE_BYTES)).toBe(false);
		expect(FLEET_MAX_DISK_FREE_BYTES).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
	});
});

describe('operator-tunable defaults and ceilings', () => {
	const TUNABLES: Array<[string, number, number]> = [
		['FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS', FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS, 900000],
		['FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS', FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS, 300000],
		['FLEET_DEFAULT_MAX_CAPABILITY_TAGS', FLEET_DEFAULT_MAX_CAPABILITY_TAGS, 16],
		['FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH', FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH, 32],
		['FLEET_MAX_CAPABILITY_TAGS_CEILING', FLEET_MAX_CAPABILITY_TAGS_CEILING, 64],
		['FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING', FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING, 128],
		['FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS', FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS, 30000],
		['FLEET_MIN_NODE_OFFLINE_AFTER_MS', FLEET_MIN_NODE_OFFLINE_AFTER_MS, 30000]
	];

	it.each(TUNABLES)('pins %s', (_name, actual, expected) => {
		// These are the values a node assumes when it cannot ask the server, so
		// changing one silently desynchronises every offline daemon.
		expect(actual).toBe(expected);
	});

	it('expresses the token TTL default as 15 minutes', () => {
		expect(FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS).toBe(15 * 60_000);
	});

	it('expresses the offline window default as 5 minutes', () => {
		expect(FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS).toBe(5 * 60_000);
	});

	it.each([...BOUNDS_AND_TUNABLES()])('keeps %s a finite positive number', (_name, actual) => {
		expect(Number.isFinite(actual)).toBe(true);
		expect(actual).toBeGreaterThan(0);
	});
});

describe('relational invariants a careless retune would break silently', () => {
	it('keeps the node-name window non-empty', () => {
		expect(FLEET_MIN_NODE_NAME_LENGTH).toBeLessThan(FLEET_MAX_NODE_NAME_LENGTH);
	});

	it('keeps the credential window non-empty', () => {
		expect(FLEET_CREDENTIAL_MIN_LENGTH).toBeLessThan(FLEET_CREDENTIAL_MAX_LENGTH);
	});

	it('admits the credential width the platform actually mints', () => {
		// Enrollment tokens and node secrets are 32 random bytes base64url —
		// 43 characters. The window exists to refuse an obviously malformed
		// credential before a DB round-trip, so it must not exclude the real one.
		const REAL_CREDENTIAL_LENGTH = 43;
		expect(REAL_CREDENTIAL_LENGTH).toBeGreaterThan(FLEET_CREDENTIAL_MIN_LENGTH);
		expect(REAL_CREDENTIAL_LENGTH).toBeLessThan(FLEET_CREDENTIAL_MAX_LENGTH);
	});

	it('keeps the capability-tag default under its ceiling', () => {
		expect(FLEET_DEFAULT_MAX_CAPABILITY_TAGS).toBeLessThanOrEqual(FLEET_MAX_CAPABILITY_TAGS_CEILING);
	});

	it('keeps the tag-length default under its ceiling', () => {
		expect(FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH).toBeLessThanOrEqual(FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING);
	});

	it('keeps the enrollment-token floor below its default', () => {
		// A zero-TTL token cannot be redeemed at all, so the floor has to leave
		// room under the shipped default.
		expect(FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS).toBeLessThan(FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS);
	});

	it('keeps the offline-sweep floor below its default', () => {
		// Below the node's own heartbeat cadence, every healthy node would flap
		// to `offline` between beats.
		expect(FLEET_MIN_NODE_OFFLINE_AFTER_MS).toBeLessThan(FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS);
	});

	it('allows a wider CLI version than a daemon version', () => {
		// An agent CLI commonly reports `1.2.3 (Claude Code)`, not a bare semver.
		expect(FLEET_MAX_CLI_VERSION_LENGTH).toBeGreaterThan(FLEET_MAX_VERSION_LENGTH);
	});
});
