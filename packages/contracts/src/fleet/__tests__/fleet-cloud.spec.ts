import { describe, expect, it } from 'vitest';

import {
	FLEET_CLOUD_ACTION_CLASS,
	FLEET_CLOUD_DEFAULT_IDLE_POLICY,
	FLEET_CLOUD_DEFAULT_SOFTWARE,
	FLEET_CLOUD_IDLE_REQUESTER,
	FLEET_CLOUD_MAX_PER_OWNER,
	clampFleetCloudIdleHours,
	fleetCloudBilledIntervals,
	fleetCloudCost,
	fleetCloudCreateSummary,
	fleetCloudDestroySummary,
	fleetCloudIdleAttentionKey,
	fleetCloudIdleHours,
	fleetCloudNodeIdFromTags,
	fleetCloudNodeTag,
	fleetCloudPowerOffSummary,
	fleetCloudPriceSentence,
	fleetCloudRemovable,
	formatFleetCloudMoney,
	isFleetCloudName,
	normalizeFleetCloudIdlePolicy,
	normalizeFleetCloudSoftware,
	type FleetCloudMeta
} from '../fleet-cloud.types.js';

const HOUR = 60 * 60 * 1000;

function meta(overrides: Partial<FleetCloudMeta> = {}): FleetCloudMeta {
	return {
		providerName: 'Provider',
		regionId: 'nyc3',
		regionLabel: 'New York 3',
		sizeId: 's-2vcpu-4gb',
		sizeLabel: '2 CPU · 4 GB · 80 GB',
		vcpus: 2,
		memoryMiB: 4096,
		diskGiB: 80,
		hourlyRateCents: 3.6,
		monthlyPriceCents: 2400,
		currency: 'USD',
		billsWhileOff: true,
		createdAt: '2026-10-15T00:00:00.000Z',
		machineCreatedAt: '2026-10-15T00:00:00.000Z',
		phase: 'online',
		phaseAt: '2026-10-15T00:05:00.000Z',
		powerState: 'running',
		powerStateAt: '2026-10-15T00:05:00.000Z',
		pending: null,
		powerTimeline: [{ state: 'running', at: '2026-10-15T00:05:00.000Z' }],
		error: null,
		idlePolicy: { mode: 'tell-me', afterHours: 3 },
		software: ['docker', 'node'],
		tags: ['ever-works'],
		...overrides
	};
}

describe('cloud computer names and limits (FR-12, FR-13)', () => {
	it('accepts the spec pattern only', () => {
		expect(isFleetCloudName('nyc-ops')).toBe(true);
		expect(isFleetCloudName('a')).toBe(false);
		expect(isFleetCloudName('-ops')).toBe(false);
		expect(isFleetCloudName('NYC')).toBe(false);
		expect(isFleetCloudName('x'.repeat(40))).toBe(false);
		expect(FLEET_CLOUD_MAX_PER_OWNER).toBe(10);
	});
});

describe('software presets (FR-3)', () => {
	it('defaults to Docker, Node.js, Claude Code and Codex', () => {
		expect([...FLEET_CLOUD_DEFAULT_SOFTWARE]).toEqual(['docker', 'node', 'claude-code', 'codex']);
		expect(normalizeFleetCloudSoftware(undefined)).toEqual(['docker', 'node', 'claude-code', 'codex']);
		expect(normalizeFleetCloudSoftware(['codex', 'docker', 'codex', 'nope'])).toEqual(['docker', 'codex']);
		expect(normalizeFleetCloudSoftware([])).toEqual([]);
	});
});

describe('idle policy (FR-25)', () => {
	it('defaults to tell me after 3 hours and clamps to 1–72', () => {
		expect(FLEET_CLOUD_DEFAULT_IDLE_POLICY).toEqual({ mode: 'tell-me', afterHours: 3 });
		expect(clampFleetCloudIdleHours(0)).toBe(1);
		expect(clampFleetCloudIdleHours(500)).toBe(72);
		expect(clampFleetCloudIdleHours('6')).toBe(6);
		expect(clampFleetCloudIdleHours('x')).toBe(3);
		expect(normalizeFleetCloudIdlePolicy({ mode: 'power-off', afterHours: 2 })).toEqual({ mode: 'power-off', afterHours: 2 });
		expect(normalizeFleetCloudIdlePolicy({ mode: 'destroy', afterHours: 2 })).toEqual({ mode: 'tell-me', afterHours: 2 });
		expect(normalizeFleetCloudIdlePolicy(null)).toEqual({ mode: 'tell-me', afterHours: 3 });
	});
});

describe('tags (FR-10)', () => {
	it('round-trips the Node id through the provider tag', () => {
		const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
		expect(fleetCloudNodeTag(id)).toBe(`ever-works-node:${id}`);
		expect(fleetCloudNodeIdFromTags(['ever-works', fleetCloudNodeTag(id)])).toBe(id);
		expect(fleetCloudNodeIdFromTags(['ever-works', 'ever-works-node:not-a-uuid'])).toBeNull();
		expect(fleetCloudNodeIdFromTags(undefined)).toBeNull();
	});
});

describe('money', () => {
	it('formats whole dollars, cents and hourly rates', () => {
		expect(formatFleetCloudMoney(2400)).toBe('$24');
		expect(formatFleetCloudMoney(284)).toBe('$2.84');
		expect(formatFleetCloudMoney(3.571, { perHour: true })).toBe('$0.036');
		expect(formatFleetCloudMoney(0)).toBe('$0.00');
	});
});

describe('cost model (FR-21, FR-22)', () => {
	it('accrues per second from the provider create', () => {
		const now = Date.parse('2026-10-18T07:00:00.000Z'); // 3 d 7 h after create
		const cost = fleetCloudCost(meta(), now);
		expect(cost.sinceCreatedCents).toBeCloseTo(79 * 3.6, 1);
		expect(cost.monthToDateCents).toBeCloseTo(79 * 3.6, 1);
		expect(cost.hourlyCents).toBe(3.6);
		// Projected: stays running to month end, capped at the monthly price.
		expect(cost.projectedMonthCents).toBeLessThanOrEqual(2400);
	});

	it('caps every calendar month at the monthly price', () => {
		const m = meta({ machineCreatedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z' });
		const now = Date.parse('2026-10-10T00:00:00.000Z');
		const cost = fleetCloudCost(m, now);
		// August + September capped at $24 each, October 9 days at 3.6 c/h.
		expect(cost.sinceCreatedCents).toBeCloseTo(2400 + 2400 + 9 * 24 * 3.6, 1);
		expect(cost.monthToDateCents).toBeCloseTo(9 * 24 * 3.6, 1);
	});

	it('stops at destruction and still counts the destroyed month', () => {
		const m = meta({ destroyedAt: '2026-10-15T10:00:00.000Z' });
		const cost = fleetCloudCost(m, Date.parse('2026-10-20T00:00:00.000Z'));
		expect(cost.sinceCreatedCents).toBeCloseTo(10 * 3.6, 1);
		expect(cost.monthToDateCents).toBeCloseTo(10 * 3.6, 1);
		expect(cost.hourlyCents).toBe(0);
		expect(cost.projectedMonthCents).toBeCloseTo(10 * 3.6, 1);
	});

	it('stops when the provider reports the machine gone', () => {
		const m = meta({ powerState: 'gone', goneAt: '2026-10-15T02:00:00.000Z' });
		expect(fleetCloudCost(m, Date.parse('2026-10-16T00:00:00.000Z')).sinceCreatedCents).toBeCloseTo(7.2, 1);
	});

	it('bills nothing before the provider accepted the create', () => {
		const m = meta({ machineCreatedAt: null, phase: 'failed' });
		expect(fleetCloudBilledIntervals(m, Date.now())).toEqual([]);
		expect(fleetCloudCost(m).sinceCreatedCents).toBe(0);
	});

	it('skips powered-off stretches only where the provider does not bill them', () => {
		const timeline = [
			{ state: 'running' as const, at: '2026-10-15T00:00:00.000Z' },
			{ state: 'off' as const, at: '2026-10-15T02:00:00.000Z' },
			{ state: 'running' as const, at: '2026-10-15T05:00:00.000Z' }
		];
		const now = Date.parse('2026-10-15T06:00:00.000Z');
		const billsOff = fleetCloudCost(meta({ powerTimeline: timeline }), now);
		const freeOff = fleetCloudCost(meta({ powerTimeline: timeline, billsWhileOff: false }), now);
		expect(billsOff.sinceCreatedCents).toBeCloseTo(6 * 3.6, 1);
		expect(freeOff.sinceCreatedCents).toBeCloseTo(3 * 3.6, 1);
	});

	it('splits a machine across the month boundary: this month counts only its own hours (P2, FR-22)', () => {
		const m = meta({ machineCreatedAt: '2026-09-30T20:00:00.000Z', createdAt: '2026-09-30T20:00:00.000Z' });
		const cost = fleetCloudCost(m, Date.parse('2026-10-01T06:00:00.000Z'));
		expect(cost.sinceCreatedCents).toBeCloseTo(10 * 3.6, 1);
		expect(cost.monthToDateCents).toBeCloseTo(6 * 3.6, 1);
	});

	it('projects a running machine to the monthly price, and a powered-off free machine to what it already cost', () => {
		const now = Date.parse('2026-10-18T07:00:00.000Z');
		expect(fleetCloudCost(meta({ machineCreatedAt: '2026-10-01T00:00:00.000Z' }), now).projectedMonthCents).toBe(2400);
		const off = meta({
			billsWhileOff: false,
			powerState: 'off',
			powerTimeline: [
				{ state: 'running', at: '2026-10-15T00:00:00.000Z' },
				{ state: 'off', at: '2026-10-15T10:00:00.000Z' }
			]
		});
		const cost = fleetCloudCost(off, now);
		expect(cost.hourlyCents).toBe(0);
		expect(cost.projectedMonthCents).toBeCloseTo(10 * 3.6, 1);
	});
});

describe('idle policy helpers (P2, FR-27)', () => {
	it('keys one window per node and start, and counts whole idle hours', () => {
		const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
		expect(fleetCloudIdleAttentionKey(id, '2026-10-21T09:00:00.000Z')).toBe(
			`fleet-node:${id}:cloud-idle:2026-10-21T09:00:00.000Z`
		);
		expect(fleetCloudIdleHours('2026-10-21T09:00:00.000Z', Date.parse('2026-10-21T12:59:00.000Z'))).toBe(3);
		expect(fleetCloudIdleHours(null)).toBeNull();
		expect(fleetCloudIdleHours('2026-10-21T09:00:00.000Z', Date.parse('2026-10-21T08:00:00.000Z'))).toBeNull();
		expect(FLEET_CLOUD_IDLE_REQUESTER).toBe('system:idle-policy');
		expect(FLEET_CLOUD_ACTION_CLASS['idle-policy']).toBe('plain');
	});
});

describe('Remove from Fleet (CONTRACTS R-36, FR-19)', () => {
	it('is refused while a machine exists, allowed once gone or never created', () => {
		expect(fleetCloudRemovable({ hasMachine: true, meta: { powerState: 'running', phase: 'online' } })).toBe(false);
		expect(fleetCloudRemovable({ hasMachine: true, meta: { powerState: 'off', phase: 'online' } })).toBe(false);
		expect(fleetCloudRemovable({ hasMachine: true, meta: { powerState: 'gone', phase: 'online' } })).toBe(true);
		expect(fleetCloudRemovable({ hasMachine: false, meta: { powerState: 'unknown', phase: 'failed' } })).toBe(true);
		// Still asking the provider: a machine may be appearing — not removable yet.
		expect(fleetCloudRemovable({ hasMachine: false, meta: { powerState: 'unknown', phase: 'asking-provider' } })).toBe(
			false
		);
	});
});

describe('confirmation copy (CONTRACTS §2.2, spec §0, §5.4)', () => {
	it('names the classes of spec §4.1', () => {
		expect(FLEET_CLOUD_ACTION_CLASS.create).toBe('confirm');
		expect(FLEET_CLOUD_ACTION_CLASS['power-off']).toBe('confirm');
		expect(FLEET_CLOUD_ACTION_CLASS.destroy).toBe('confirm-destructive');
		expect(FLEET_CLOUD_ACTION_CLASS['idle-policy']).toBe('plain');
	});

	it('states the price, the billing rule and that no key is kept', () => {
		const sentence = fleetCloudPriceSentence({
			providerName: 'Provider',
			monthlyPriceCents: 2400,
			hourlyRateCents: 3.571,
			billsWhileOff: true
		});
		expect(sentence).toContain('$24/month');
		expect(sentence).toContain('$0.036/hour');
		expect(sentence).toContain('also while powered off');
		expect(sentence).toContain('stores no password or key');
	});

	it('states size and price in the Agent summary, the cost so far on destroy, the billing on power-off', () => {
		expect(
			fleetCloudCreateSummary({
				name: 'nyc-ops',
				providerName: 'Provider',
				regionId: 'nyc3',
				vcpus: 2,
				memoryMiB: 4096,
				monthlyPriceCents: 2400,
				hourlyRateCents: 3.571,
				billsWhileOff: true
			})
		).toContain('2 CPU · 4 GB cloud computer at Provider (nyc3) for about $24/month');
		expect(
			fleetCloudDestroySummary({
				name: 'nyc-ops',
				providerName: 'Provider',
				costSoFarCents: 284,
				createdAt: '2026-10-15T00:00:00.000Z'
			})
		).toBe('Destroy nyc-ops? It has cost $2.84 since 2026-10-15. The machine and its disk are deleted at Provider; this cannot be undone.');
		expect(fleetCloudPowerOffSummary('nyc-ops', 'Provider', true)).toContain('still bills this size while it is off');
	});
});
