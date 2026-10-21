/**
 * Fleet computer health (FL-03, second phase) — the HISTORY read
 * (`GET /api/fleet/nodes/:id/health/history`, spec FR-20, FR-21, U10).
 *
 * The samples table holds one `raw` row per sampled beat (7 days) and one
 * `hourly` roll-up per node per hour (90 days, CONTRACTS §4.5). A range picks
 * its resolution — 1 h and 24 h from raw samples, 7 d and 90 d from roll-ups
 * — and the answer is at most {@link FLEET_HEALTH_MAX_HISTORY_POINTS} points,
 * averaged into equal buckets.
 *
 * ## Gaps are breaks, never zeros
 *
 * A computer that was offline has no samples, and the chart must show that
 * as a break in the line, not as a dive to 0%. The answer carries an explicit
 * gap point (every value null) wherever two consecutive samples are further
 * apart than the series' gap threshold; the chart draws nulls as breaks.
 * Bucket emptiness alone is not a gap: a one-minute beat jitters across
 * one-minute buckets.
 */

import {
	FLEET_HEALTH_MAX_HISTORY_POINTS,
	type FleetNodeHealthRange,
	type FleetNodeHealthResolution
} from './fleet-node-health.types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How far back each range reaches. */
export const FLEET_HEALTH_RANGE_MS: Readonly<Record<FleetNodeHealthRange, number>> = {
	'1h': HOUR_MS,
	'24h': DAY_MS,
	'7d': 7 * DAY_MS,
	'90d': 90 * DAY_MS
};

/** The resolution each range is answered from (FR-20). */
export const FLEET_HEALTH_RANGE_RESOLUTION: Readonly<Record<FleetNodeHealthRange, FleetNodeHealthResolution>> = {
	'1h': 'raw',
	'24h': 'raw',
	'7d': 'hourly',
	'90d': 'hourly'
};

/** The spacing a resolution's rows nominally have (a beat a minute; one roll-up an hour). */
export const FLEET_HEALTH_RESOLUTION_STEP_MS: Readonly<Record<FleetNodeHealthResolution, number>> = {
	raw: MINUTE_MS,
	hourly: HOUR_MS
};

/** The default range the chart opens on. */
export const FLEET_HEALTH_DEFAULT_RANGE: FleetNodeHealthRange = '24h';

export function isFleetNodeHealthRange(value: unknown): value is FleetNodeHealthRange {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FLEET_HEALTH_RANGE_MS, value);
}

/** One point of the chart: bucket means (percent, 0–100) and the bucket's peaks. Null = not reported; all null = a gap. */
export interface FleetNodeHealthHistoryPoint {
	/** The bucket's start (ISO). */
	at: string;
	cpu: number | null;
	mem: number | null;
	disk: number | null;
	cpuMax: number | null;
	memMax: number | null;
	diskMax: number | null;
}

/** The history answer: switched off on this deployment, or the points. */
export type FleetNodeHealthHistory =
	| { nodeId: string; range: FleetNodeHealthRange; disabled: true }
	| {
			nodeId: string;
			range: FleetNodeHealthRange;
			disabled: false;
			resolution: FleetNodeHealthResolution;
			/** The window the points cover (ISO). */
			from: string;
			to: string;
			/** Width of one bucket, in ms. */
			bucketMs: number;
			points: FleetNodeHealthHistoryPoint[];
	  };

/** One stored row, as the bucketing reads it (a structural subset of the sample entity). */
export interface FleetHealthHistorySample {
	at: string | Date | number;
	cpuPercent?: number | string | null;
	memPercent?: number | string | null;
	diskPercent?: number | string | null;
	cpuMax?: number | string | null;
	memMax?: number | string | null;
	diskMax?: number | string | null;
}

function toMs(value: string | Date | number): number {
	if (typeof value === 'number') return value;
	if (value instanceof Date) return value.getTime();
	return Date.parse(value);
}

/** A percentage off a row (`real` columns may come back as strings on some drivers), or null. */
function pct(value: number | string | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const number = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

interface Bucket {
	start: number;
	cpu: number[];
	mem: number[];
	disk: number[];
	cpuMax: number[];
	memMax: number[];
	diskMax: number[];
}

function meanOf(values: number[]): number | null {
	if (values.length === 0) return null;
	return round1(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function maxOf(values: number[]): number | null {
	return values.length === 0 ? null : round1(Math.max(...values));
}

function gapPoint(at: number): FleetNodeHealthHistoryPoint {
	return {
		at: new Date(at).toISOString(),
		cpu: null,
		mem: null,
		disk: null,
		cpuMax: null,
		memMax: null,
		diskMax: null
	};
}

/**
 * Bucket one node's rows of one resolution into at most `maxPoints` points
 * over `[from, to)`, with explicit gap points (see the module comment).
 *
 * - bucket width: the resolution's step, widened to fit `maxPoints`;
 * - a bucket's value: the mean of its rows; its peak: the highest `*Max` a
 *   roll-up carried, else the highest raw value;
 * - a gap: two consecutive non-empty buckets further apart than three steps
 *   (and at least two buckets) — one all-null point is placed right after
 *   the earlier one, which is what makes the line break.
 *
 * Rows outside the window, or without a usable instant, are ignored.
 */
export function buildFleetHealthHistoryPoints(
	samples: readonly FleetHealthHistorySample[],
	options: { from: number; to: number; resolution: FleetNodeHealthResolution; maxPoints?: number }
): { bucketMs: number; points: FleetNodeHealthHistoryPoint[] } {
	const maxPoints = Math.max(1, Math.floor(options.maxPoints ?? FLEET_HEALTH_MAX_HISTORY_POINTS));
	const span = Math.max(1, options.to - options.from);
	const step = FLEET_HEALTH_RESOLUTION_STEP_MS[options.resolution];
	const bucketMs = Math.max(step, Math.ceil(span / maxPoints));
	const bucketCount = Math.max(1, Math.ceil(span / bucketMs));
	const gapAfterMs = Math.max(3 * step, 2 * bucketMs);

	const buckets = new Map<number, Bucket>();
	for (const sample of samples) {
		const at = toMs(sample.at);
		if (!Number.isFinite(at) || at < options.from || at >= options.to) continue;
		const index = Math.min(bucketCount - 1, Math.floor((at - options.from) / bucketMs));
		let bucket = buckets.get(index);
		if (!bucket) {
			bucket = {
				start: options.from + index * bucketMs,
				cpu: [],
				mem: [],
				disk: [],
				cpuMax: [],
				memMax: [],
				diskMax: []
			};
			buckets.set(index, bucket);
		}
		const cpu = pct(sample.cpuPercent);
		const mem = pct(sample.memPercent);
		const disk = pct(sample.diskPercent);
		if (cpu !== null) bucket.cpu.push(cpu);
		if (mem !== null) bucket.mem.push(mem);
		if (disk !== null) bucket.disk.push(disk);
		const cpuMax = pct(sample.cpuMax) ?? cpu;
		const memMax = pct(sample.memMax) ?? mem;
		const diskMax = pct(sample.diskMax) ?? disk;
		if (cpuMax !== null) bucket.cpuMax.push(cpuMax);
		if (memMax !== null) bucket.memMax.push(memMax);
		if (diskMax !== null) bucket.diskMax.push(diskMax);
	}

	const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, bucket]) => bucket);
	const points: FleetNodeHealthHistoryPoint[] = [];
	let previousStart: number | null = null;
	for (const bucket of ordered) {
		if (previousStart !== null && bucket.start - previousStart > gapAfterMs) {
			points.push(gapPoint(previousStart + bucketMs));
		}
		points.push({
			at: new Date(bucket.start).toISOString(),
			cpu: meanOf(bucket.cpu),
			mem: meanOf(bucket.mem),
			disk: meanOf(bucket.disk),
			cpuMax: maxOf(bucket.cpuMax),
			memMax: maxOf(bucket.memMax),
			diskMax: maxOf(bucket.diskMax)
		});
		previousStart = bucket.start;
	}
	// A gap point always takes an empty bucket's place (gaps need two empty
	// buckets), so this never trims; it is the belt for the bound.
	return { bucketMs, points: points.length > maxPoints ? points.slice(points.length - maxPoints) : points };
}

/** One metric's mean and peak over the points (the chart's text summary, spec §5.8). */
export interface FleetHealthHistorySummary {
	mean: number | null;
	peak: number | null;
	peakAt: string | null;
}

/** Mean and peak of one metric across the points, ignoring gaps. */
export function summarizeFleetHealthHistory(
	points: readonly FleetNodeHealthHistoryPoint[],
	metric: 'cpu' | 'mem' | 'disk'
): FleetHealthHistorySummary {
	const peakKey = `${metric}Max` as const;
	let sum = 0;
	let count = 0;
	let peak: number | null = null;
	let peakAt: string | null = null;
	for (const point of points) {
		const value = point[metric];
		if (value !== null) {
			sum += value;
			count += 1;
		}
		const top = point[peakKey] ?? value;
		if (top !== null && (peak === null || top > peak)) {
			peak = top;
			peakAt = point.at;
		}
	}
	return { mean: count === 0 ? null : round1(sum / count), peak, peakAt };
}
