import { describe, expect, it } from 'vitest';

import {
	buildFleetWakePacket,
	fleetWakeAnswered,
	fleetWakeBlocker,
	isFleetNodeAsleep,
	maskFleetMacAddress,
	normalizeFleetLanId,
	normalizeFleetMacAddress,
	selectFleetWakeSiblings,
	type FleetWakeCandidate
} from '../fleet-node-wake.types.js';

/** Computer health (FL-03, second phase) — wake vocabulary (spec FR-23 … FR-26). */

const NOW = Date.parse('2026-10-21T10:00:00.000Z');
const WINDOW = 5 * 60_000;
const LAN = 'a1b2c3d4e5f60718';

function candidate(overrides: Partial<FleetWakeCandidate> = {}): FleetWakeCandidate {
	return {
		id: 'sib-1',
		name: 'build-01',
		status: 'online',
		lastHeartbeatAt: new Date(NOW - 30_000).toISOString(),
		capabilities: ['wake', 'managed', 'git'],
		lanId: LAN,
		...overrides
	};
}

describe('normalizeFleetMacAddress', () => {
	it.each([
		['AA:BB:CC:DD:EE:F0', 'aa:bb:cc:dd:ee:f0'],
		['aa-bb-cc-dd-ee-f0', 'aa:bb:cc:dd:ee:f0'],
		['aabb.ccdd.eef0', 'aa:bb:cc:dd:ee:f0'],
		['aabbccddeef0', 'aa:bb:cc:dd:ee:f0']
	])('normalises %s', (input, expected) => {
		expect(normalizeFleetMacAddress(input)).toBe(expected);
	});

	it.each([
		['the all-zero placeholder', '00:00:00:00:00:00'],
		['the broadcast address', 'ff:ff:ff:ff:ff:ff'],
		['a multicast address', '01:00:5e:00:00:01'],
		['too short', 'aa:bb:cc:dd:ee'],
		['not hex', 'zz:bb:cc:dd:ee:ff'],
		['an over-long input', 'a'.repeat(64)]
	])('refuses %s', (_label, input) => {
		expect(normalizeFleetMacAddress(input)).toBeNull();
	});

	it('refuses non-strings', () => {
		expect(normalizeFleetMacAddress(42)).toBeNull();
		expect(normalizeFleetMacAddress(null)).toBeNull();
	});
});

describe('maskFleetMacAddress', () => {
	it('keeps the last two octets only', () => {
		expect(maskFleetMacAddress('aa:bb:cc:dd:3f:9a')).toBe('••:••:••:••:3f:9a');
	});

	it('answers null for an address it would refuse', () => {
		expect(maskFleetMacAddress('nope')).toBeNull();
	});
});

describe('buildFleetWakePacket', () => {
	it('is six 0xff bytes then the address sixteen times (102 bytes)', () => {
		const packet = buildFleetWakePacket('aa:bb:cc:dd:ee:f0');
		expect(packet).not.toBeNull();
		expect(packet!.length).toBe(102);
		expect([...packet!.slice(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
		for (let repeat = 0; repeat < 16; repeat += 1) {
			expect([...packet!.slice(6 + repeat * 6, 12 + repeat * 6)]).toEqual([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xf0]);
		}
	});

	it('answers null for a refused address', () => {
		expect(buildFleetWakePacket('ff:ff:ff:ff:ff:ff')).toBeNull();
	});
});

describe('normalizeFleetLanId', () => {
	it('accepts 16-64 hex characters, lowercased', () => {
		expect(normalizeFleetLanId('A1B2C3D4E5F60718')).toBe(LAN);
	});

	it('refuses anything else', () => {
		expect(normalizeFleetLanId('192.168.1.0/24')).toBeNull();
		expect(normalizeFleetLanId('abc')).toBeNull();
		expect(normalizeFleetLanId(undefined)).toBeNull();
	});
});

describe('isFleetNodeAsleep', () => {
	it('is true for an offline row and for a silent one', () => {
		expect(isFleetNodeAsleep({ status: 'offline', lastHeartbeatAt: null }, NOW, WINDOW)).toBe(true);
		expect(
			isFleetNodeAsleep({ status: 'online', lastHeartbeatAt: new Date(NOW - WINDOW - 1).toISOString() }, NOW, WINDOW)
		).toBe(true);
	});

	it('is false for a computer that beat recently, and for one still enrolling', () => {
		expect(isFleetNodeAsleep({ status: 'online', lastHeartbeatAt: new Date(NOW - 1_000) }, NOW, WINDOW)).toBe(false);
		expect(isFleetNodeAsleep({ status: 'enrolling', lastHeartbeatAt: null }, NOW, WINDOW)).toBe(false);
	});
});

describe('selectFleetWakeSiblings', () => {
	const options = { now: NOW, offlineAfterMs: WINDOW };
	const target = { id: 'target', lanId: LAN };

	it('keeps an online, recently-beating, same-network sibling with wake + managed', () => {
		expect(selectFleetWakeSiblings(target, [candidate()], options).map((node) => node.id)).toEqual(['sib-1']);
	});

	it.each([
		['the target itself', { id: 'target' }],
		['another network', { lanId: 'ffffffffffffffff' }],
		['no network identity', { lanId: null }],
		['an offline status', { status: 'offline' as const }],
		['a paused status', { status: 'paused' as const }],
		['a stale beat', { lastHeartbeatAt: new Date(NOW - WINDOW - 1).toISOString() }],
		['no wake tag', { capabilities: ['managed'] }],
		['no managed tag', { capabilities: ['wake'] }]
	])('drops %s', (_label, overrides) => {
		expect(selectFleetWakeSiblings(target, [candidate(overrides)], options)).toEqual([]);
	});

	it('answers nothing when the target has no network identity', () => {
		expect(selectFleetWakeSiblings({ id: 'target', lanId: null }, [candidate()], options)).toEqual([]);
	});

	it('orders by the most recent beat', () => {
		const older = candidate({ id: 'older', lastHeartbeatAt: new Date(NOW - 120_000).toISOString() });
		const newer = candidate({ id: 'newer', lastHeartbeatAt: new Date(NOW - 5_000).toISOString() });
		expect(selectFleetWakeSiblings(target, [older, newer], options).map((node) => node.id)).toEqual([
			'newer',
			'older'
		]);
	});
});

describe('fleetWakeBlocker', () => {
	const options = { now: NOW, offlineAfterMs: WINDOW };
	const asleep = { status: 'offline' as const, lastHeartbeatAt: null, hasHardwareAddress: true };

	it('names not-offline, then no-hardware-address, then no-sibling', () => {
		expect(
			fleetWakeBlocker({ ...asleep, status: 'online', lastHeartbeatAt: new Date(NOW).toISOString() }, [], options)
		).toBe('not-offline');
		expect(fleetWakeBlocker({ ...asleep, hasHardwareAddress: false }, [], options)).toBe('no-hardware-address');
		expect(fleetWakeBlocker(asleep, [], options)).toBe('no-sibling');
		expect(fleetWakeBlocker(asleep, [candidate()], options)).toBeNull();
	});
});

describe('fleetWakeAnswered', () => {
	it('is true only for a beat after the attempt', () => {
		expect(fleetWakeAnswered('2026-10-21T10:00:00Z', '2026-10-21T10:00:21Z')).toBe(true);
		expect(fleetWakeAnswered('2026-10-21T10:00:00Z', '2026-10-21T09:59:00Z')).toBe(false);
		expect(fleetWakeAnswered(null, '2026-10-21T10:00:21Z')).toBe(false);
	});
});
