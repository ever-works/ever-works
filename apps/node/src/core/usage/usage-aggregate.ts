import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import {
	FLEET_USAGE_OTHER_FOLDER_PREFIX,
	FLEET_USAGE_REPORT_MAX_BYTES,
	FLEET_USAGE_REPORT_MAX_ROWS,
	fleetUsageHourStart,
	type FleetUsageRow,
	type FleetUsageTokens
} from '@ever-works/contracts';
import type { UsageAdmission } from './usage-dedupe';
import type { UsageRecord } from './usage-record';
import type { UsageBucket, UsageScanState } from './usage-watermark';

/**
 * Usage & cost on the fleet (FL-20, plan §3 "Report shape" / "Folder bucket",
 * T-11, spec FR-3) — the node's CUMULATIVE buckets and the report built from
 * them.
 *
 * A bucket is provider × provider session × model × hour × folder bucket, and
 * holds the running total of every record counted into it — not the increment
 * since the last scan. Each change stamps the bucket with a fresh revision;
 * a report carries the buckets changed after the platform's acknowledged
 * watermark, oldest revision first, so a truncated report is always a prefix
 * and the next one continues exactly where it stopped.
 *
 * Folder bucket (FR-3): the working folder leaves the machine only as the
 * known checkout or allowed root that contains it (the longest one); any other
 * folder is an opaque `other:<sha256 prefix 8>`; no folder is null.
 */

/** A bucket the platform acknowledged and nobody touched for this long is dropped (its total is stored there). */
export const USAGE_BUCKET_IDLE_PRUNE_MS = 2 * 24 * 60 * 60 * 1000;
/** …and only once its hour is this old. */
export const USAGE_BUCKET_AGE_PRUNE_MS = 35 * 24 * 60 * 60 * 1000;

function pathApi(platform: string) {
	return platform === 'win32' ? win32 : posix;
}

function comparable(path: string, platform: string): string {
	const api = pathApi(platform);
	const resolved = api.resolve(path);
	return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The folder bucket a working folder reports as (see the module comment). */
export function usageFolderBucket(cwd: string | null, roots: readonly string[], platform: string): string | null {
	if (!cwd) return null;
	const api = pathApi(platform);
	if (!api.isAbsolute(cwd)) return null;
	const target = comparable(cwd, platform);
	let best: string | null = null;
	for (const root of roots) {
		if (!root || !api.isAbsolute(root)) continue;
		const base = comparable(root, platform);
		const inside = target === base || target.startsWith(base.endsWith(api.sep) ? base : base + api.sep);
		if (inside && (!best || base.length > comparable(best, platform).length)) best = api.resolve(root);
	}
	if (best) return best;
	return `${FLEET_USAGE_OTHER_FOLDER_PREFIX}${createHash('sha256').update(target).digest('hex').slice(0, 8)}`;
}

export function usageBucketKey(
	record: Pick<UsageRecord, 'provider' | 'sessionId' | 'model'>,
	hour: number,
	folder: string | null
): string {
	return [record.provider, record.sessionId ?? '', record.model, String(hour), folder ?? ''].join('\u0000');
}

/** Count one admitted record into its bucket; answers true when the bucket changed. */
export function addToUsageBucket(
	state: UsageScanState,
	record: UsageRecord,
	admission: UsageAdmission,
	folder: string | null,
	now: number
): boolean {
	const hour = fleetUsageHourStart(record.at);
	const key = usageBucketKey(record, hour, folder);
	const delta = admission.delta;
	const grows = delta.in + delta.out + delta.cacheRead + delta.cacheWrite > 0 || admission.isNew;
	if (!grows) return false;
	const bucket: UsageBucket = state.buckets[key] ?? {
		p: record.provider,
		s: record.sessionId,
		m: record.model,
		h: hour,
		f: folder,
		t: [0, 0, 0, 0],
		r: 0,
		a: record.at,
		z: record.at,
		v: 0,
		u: now
	};
	bucket.t = [bucket.t[0] + delta.in, bucket.t[1] + delta.out, bucket.t[2] + delta.cacheRead, bucket.t[3] + delta.cacheWrite];
	if (admission.isNew) bucket.r += 1;
	bucket.a = Math.min(bucket.a, record.at);
	bucket.z = Math.max(bucket.z, record.at);
	state.rev += 1;
	bucket.v = state.rev;
	bucket.u = now;
	state.buckets[key] = bucket;
	return true;
}

export function usageBucketRow(bucket: UsageBucket): FleetUsageRow {
	const tokens: FleetUsageTokens = { in: bucket.t[0], out: bucket.t[1], cacheRead: bucket.t[2], cacheWrite: bucket.t[3] };
	return {
		provider: bucket.p,
		providerSessionId: bucket.s,
		model: bucket.m,
		bucketStart: new Date(bucket.h).toISOString(),
		folderBucket: bucket.f,
		tokens,
		requests: bucket.r,
		firstAt: new Date(bucket.a).toISOString(),
		lastAt: new Date(bucket.z).toISOString()
	};
}

export interface UsageReportSlice {
	rows: FleetUsageRow[];
	/** The highest revision carried, or `from` when nothing changed. */
	watermark: number;
	/** More changed buckets wait than this report carries. */
	truncated: boolean;
}

/** The buckets changed after `from`, oldest revision first, within the row and byte caps. */
export function buildUsageReportSlice(
	state: UsageScanState,
	from: number,
	limits: { maxRows?: number; maxBytes?: number } = {}
): UsageReportSlice {
	const maxRows = limits.maxRows ?? FLEET_USAGE_REPORT_MAX_ROWS;
	const maxBytes = limits.maxBytes ?? FLEET_USAGE_REPORT_MAX_BYTES;
	const pending = Object.values(state.buckets)
		.filter((bucket) => bucket && bucket.v > from)
		.sort((a, b) => a.v - b.v);
	const rows: FleetUsageRow[] = [];
	let bytes = 2;
	let watermark = from;
	for (const bucket of pending) {
		if (rows.length >= maxRows) break;
		const row = usageBucketRow(bucket);
		const size = Buffer.byteLength(JSON.stringify(row)) + 1;
		if (rows.length > 0 && bytes + size > maxBytes) break;
		rows.push(row);
		bytes += size;
		watermark = bucket.v;
	}
	return { rows, watermark, truncated: rows.length < pending.length };
}

/**
 * Drop buckets the platform stored (revision ≤ `ackedRev`) that nobody touched
 * for {@link USAGE_BUCKET_IDLE_PRUNE_MS} and whose hour is older than
 * {@link USAGE_BUCKET_AGE_PRUNE_MS}. Answers how many were dropped.
 */
export function pruneUsageBuckets(state: UsageScanState, now: number): number {
	let dropped = 0;
	for (const [key, bucket] of Object.entries(state.buckets)) {
		if (
			!bucket ||
			(bucket.v <= state.ackedRev &&
				now - bucket.u > USAGE_BUCKET_IDLE_PRUNE_MS &&
				now - bucket.h > USAGE_BUCKET_AGE_PRUNE_MS)
		) {
			delete state.buckets[key];
			dropped += 1;
		}
	}
	return dropped;
}
