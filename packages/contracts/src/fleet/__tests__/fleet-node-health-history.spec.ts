import { describe, expect, it } from 'vitest';

import {
	buildFleetHealthHistoryPoints,
	FLEET_HEALTH_RANGE_MS,
	FLEET_HEALTH_RANGE_RESOLUTION,
	isFleetNodeHealthRange,
	summarizeFleetHealthHistory
} from '../fleet-node-health-history.types.js';

/** Computer health (FL-03, second phase) — the history read (spec FR-20, FR-21). */

const FROM = Date.parse('2026-10-21T09:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('ranges', () => {
	it('answers 1 h and 24 h from raw samples, 7 d and 90 d from roll-ups', () => {
		expect(FLEET_HEALTH_RANGE_RESOLUTION).toEqual({ '1h': 'raw', '24h': 'raw', '7d': 'hourly', '90d': 'hourly' });
		expect(FLEET_HEALTH_RANGE_MS['24h']).toBe(24 * HOUR);
	});

	it('recognises only the four ranges', () => {
		expect(isFleetNodeHealthRange('7d')).toBe(true);
		expect(isFleetNodeHealthRange('1y')).toBe(false);
		expect(isFleetNodeHealthRange('toString')).toBe(false);
	});
});

describe('buildFleetHealthHistoryPoints', () => {
	it('keeps one point a minute for an hour of raw samples', () => {
		const samples = Array.from({ length: 60 }, (_, index) => ({
			at: FROM + index * MINUTE + 5_000,
			cpuPercent: index,
			memPercent: 50,
			diskPercent: 40
		}));
		const { bucketMs, points } = buildFleetHealthHistoryPoints(samples, {
			from: FROM,
			to: FROM + HOUR,
			resolution: 'raw'
		});
		expect(bucketMs).toBe(MINUTE);
		expect(points).toHaveLength(60);
		expect(points[3]).toMatchObject({ cpu: 3, mem: 50, disk: 40, cpuMax: 3 });
	});

	it('never answers more than the point limit', () => {
		const samples = Array.from({ length: 24 * 60 }, (_, index) => ({ at: FROM + index * MINUTE, cpuPercent: 10 }));
		const { points, bucketMs } = buildFleetHealthHistoryPoints(samples, {
			from: FROM,
			to: FROM + 24 * HOUR,
			resolution: 'raw',
			maxPoints: 500
		});
		expect(points.length).toBeLessThanOrEqual(500);
		expect(bucketMs).toBeGreaterThanOrEqual(Math.ceil((24 * HOUR) / 500));
	});

	it('breaks the line where the computer was offline, never a zero', () => {
		const before = Array.from({ length: 10 }, (_, index) => ({ at: FROM + index * MINUTE, cpuPercent: 20 }));
		const after = Array.from({ length: 10 }, (_, index) => ({ at: FROM + (30 + index) * MINUTE, cpuPercent: 30 }));
		const { points } = buildFleetHealthHistoryPoints([...before, ...after], {
			from: FROM,
			to: FROM + HOUR,
			resolution: 'raw'
		});
		const gaps = points.filter((point) => point.cpu === null && point.mem === null && point.disk === null);
		expect(gaps).toHaveLength(1);
		expect(points.some((point) => point.cpu === 0)).toBe(false);
	});

	it('does not invent a gap out of beat jitter', () => {
		// Beats 55-65 s apart land unevenly in one-minute buckets.
		const samples = [0, 65, 120, 175, 240, 305].map((sec) => ({ at: FROM + sec * 1000, cpuPercent: 5 }));
		const { points } = buildFleetHealthHistoryPoints(samples, { from: FROM, to: FROM + HOUR, resolution: 'raw' });
		expect(points.every((point) => point.cpu === 5)).toBe(true);
	});

	it('carries a roll-up peak through as the bucket peak', () => {
		const { points } = buildFleetHealthHistoryPoints(
			[{ at: FROM, cpuPercent: 20, cpuMax: 91 }],
			{ from: FROM, to: FROM + 7 * 24 * HOUR, resolution: 'hourly' }
		);
		expect(points[0]).toMatchObject({ cpu: 20, cpuMax: 91 });
	});

	it('ignores rows outside the window and values outside 0-100', () => {
		const { points } = buildFleetHealthHistoryPoints(
			[
				{ at: FROM - MINUTE, cpuPercent: 10 },
				{ at: FROM + MINUTE, cpuPercent: 120, memPercent: '42' }
			],
			{ from: FROM, to: FROM + HOUR, resolution: 'raw' }
		);
		expect(points).toHaveLength(1);
		expect(points[0]).toMatchObject({ cpu: null, mem: 42 });
	});
});

describe('summarizeFleetHealthHistory', () => {
	it('answers the mean and the peak with its instant, skipping gaps', () => {
		const points = [
			{ at: 'a', cpu: 20, mem: null, disk: null, cpuMax: 30, memMax: null, diskMax: null },
			{ at: 'gap', cpu: null, mem: null, disk: null, cpuMax: null, memMax: null, diskMax: null },
			{ at: 'b', cpu: 40, mem: null, disk: null, cpuMax: 78, memMax: null, diskMax: null }
		];
		expect(summarizeFleetHealthHistory(points, 'cpu')).toEqual({ mean: 30, peak: 78, peakAt: 'b' });
		expect(summarizeFleetHealthHistory(points, 'mem')).toEqual({ mean: null, peak: null, peakAt: null });
	});
});
