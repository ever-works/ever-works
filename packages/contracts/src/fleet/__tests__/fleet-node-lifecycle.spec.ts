import { describe, expect, it } from 'vitest';

import {
	FLEET_MAX_REPORTED_LIMIT_VALUE,
	FLEET_NODE_MAX_CONCURRENT_JOBS,
	FLEET_NODE_MAX_CPU_PERCENT,
	FLEET_NODE_MAX_MEMORY_MB,
	FLEET_NODE_MIN_CONCURRENT_JOBS,
	FLEET_NODE_MIN_CPU_PERCENT,
	FLEET_NODE_MIN_MEMORY_MB,
	compareFleetNodeVersions,
	FLEET_DEFAULT_MIN_NODE_VERSION,
	FLEET_MAX_CLI_VERSION_LENGTH,
	FLEET_MAX_CLI_VERSIONS,
	FLEET_NODE_UPGRADE_COMMAND,
	isFleetNodeVersionBelowFloor,
	normalizeFleetNodeVersionFloor
} from '../fleet-node.types.js';

/**
 * Node lifecycle (self-build slice AR) — the daemon version floor.
 *
 * Four places ask "is this machine too old?": the lease (which refuses it
 * new work), the heartbeat response (which tells it so), the Fleet drawer
 * (which shows the owner) and the node itself (`doctor`). They all call
 * {@link isFleetNodeVersionBelowFloor}, so its behaviour IS the policy and
 * is pinned here literally.
 */

describe('FLEET_DEFAULT_MIN_NODE_VERSION', () => {
	it('admits every ever-works-node release that has ever shipped', () => {
		// 0.1.0 was the first publish (Wave 12) and 0.2.0 the npm bundle. A
		// default that refused either would brick a machine nobody upgraded,
		// on the deploy that merely INTRODUCED the floor.
		for (const shipped of ['0.1.0', '0.2.0']) {
			expect(isFleetNodeVersionBelowFloor(shipped, FLEET_DEFAULT_MIN_NODE_VERSION)).toBe(false);
		}
		expect(FLEET_DEFAULT_MIN_NODE_VERSION).toBe('0.1.0');
	});

	it('normalizes to itself', () => {
		expect(normalizeFleetNodeVersionFloor(FLEET_DEFAULT_MIN_NODE_VERSION)).toBe(FLEET_DEFAULT_MIN_NODE_VERSION);
	});
});

describe('compareFleetNodeVersions', () => {
	it.each([
		['0.2.0', '0.3.0', -1],
		['0.3.0', '0.2.0', 1],
		['1.0.0', '1.0.0', 0],
		['1.2', '1.2.0', 0],
		['v1.2.3', '1.2.3', 0],
		['0.10.0', '0.9.9', 1],
		['2.0.0', '10.0.0', -1],
		['1.2.0-rc.1', '1.2.0', -1],
		['1.2.0', '1.2.0-rc.1', 1],
		['1.2.0-rc.2', '1.2.0-rc.10', -1],
		['1.2.0-alpha', '1.2.0-1', 1],
		['1.2.0-rc.1', '1.2.0-rc.1.1', -1],
		['1.2.3+build.7', '1.2.3', 0]
	] as const)('%s vs %s → %s', (a, b, expected) => {
		expect(compareFleetNodeVersions(a, b)).toBe(expected);
	});

	it.each([[''], ['dev'], ['1'], ['1.x.0'], ['latest'], [null], [undefined], [12]])(
		'answers null (not an error) for the unparseable %s',
		(value) => {
			expect(compareFleetNodeVersions(value, '1.0.0')).toBeNull();
			expect(compareFleetNodeVersions('1.0.0', value)).toBeNull();
		}
	);
});

describe('isFleetNodeVersionBelowFloor', () => {
	it('refuses a daemon strictly below the floor, and only that', () => {
		expect(isFleetNodeVersionBelowFloor('0.2.0', '0.3.0')).toBe(true);
		expect(isFleetNodeVersionBelowFloor('0.3.0', '0.3.0')).toBe(false);
		expect(isFleetNodeVersionBelowFloor('0.4.0', '0.3.0')).toBe(false);
		// A prerelease of the floor is below it — `0.3.0-rc.1` predates 0.3.0.
		expect(isFleetNodeVersionBelowFloor('0.3.0-rc.1', '0.3.0')).toBe(true);
	});

	it('fails OPEN on anything it cannot read — the floor is a compatibility gate, not a lock', () => {
		// A machine can report any version it likes, so refusing an
		// unreadable one buys no security and bricks honest dev builds.
		expect(isFleetNodeVersionBelowFloor(null, '9.9.9')).toBe(false);
		expect(isFleetNodeVersionBelowFloor(undefined, '9.9.9')).toBe(false);
		expect(isFleetNodeVersionBelowFloor('dev', '9.9.9')).toBe(false);
		expect(isFleetNodeVersionBelowFloor('0.0.1', 'not-a-version')).toBe(false);
	});
});

describe('normalizeFleetNodeVersionFloor', () => {
	it('accepts a version, trimmed and without a leading v', () => {
		expect(normalizeFleetNodeVersionFloor(' v0.3.0 ')).toBe('0.3.0');
		expect(normalizeFleetNodeVersionFloor('1.2.0-rc.1')).toBe('1.2.0-rc.1');
	});

	it('refuses anything that is not one, so the caller falls back to the default', () => {
		for (const value of ['', '   ', 'latest', '1', 'x'.repeat(40), null, undefined, 3]) {
			expect(normalizeFleetNodeVersionFloor(value)).toBeNull();
		}
	});
});

describe('the operator-facing constants', () => {
	it('prints one upgrade command everywhere — the npm package the installer installs', () => {
		expect(FLEET_NODE_UPGRADE_COMMAND).toBe('npm install -g ever-works-node@latest');
	});

	it('bounds per-provider CLI versions like the single cliVersion field', () => {
		expect(FLEET_MAX_CLI_VERSIONS).toBe(8);
		expect(FLEET_MAX_CLI_VERSION_LENGTH).toBe(64);
	});
});

describe('remote node limits (slice AS) — the bounds', () => {
	it('pins the literal bounds the node clamps its flags into', () => {
		// The node's own `MIN_/MAX_*` constants are pinned equal to these in
		// apps/node; a ceiling the platform accepted but the node rewrote
		// would be a setting that does not do what the owner typed.
		expect([FLEET_NODE_MIN_CONCURRENT_JOBS, FLEET_NODE_MAX_CONCURRENT_JOBS]).toEqual([1, 16]);
		expect([FLEET_NODE_MIN_CPU_PERCENT, FLEET_NODE_MAX_CPU_PERCENT]).toEqual([5, 100]);
		expect([FLEET_NODE_MIN_MEMORY_MB, FLEET_NODE_MAX_MEMORY_MB]).toEqual([256, 1_048_576]);
	});

	it('lets a reported limit be wider than the clamp, up to the int column', () => {
		expect(FLEET_MAX_REPORTED_LIMIT_VALUE).toBe(2 ** 31 - 1);
		expect(FLEET_MAX_REPORTED_LIMIT_VALUE).toBeGreaterThan(FLEET_NODE_MAX_MEMORY_MB);
	});
});
