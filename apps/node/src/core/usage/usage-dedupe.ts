import { createHash } from 'node:crypto';
import type { FleetUsageTokens } from '@ever-works/contracts';
import type { UsageRecord } from './usage-record';

/**
 * Usage & cost on the fleet (FL-20, plan §3, T-10, spec FR-4, U4, U5) — each
 * provider record is counted ONCE across scans, files and resumed sessions.
 *
 * The scan remembers, per record identity (a hash of the provider's own ids —
 * never content), the tokens it has already counted. A record seen again adds
 * only its per-class GROWTH (Claude Code writes one line per content block of
 * a response, and a later line may carry the final output count); the same
 * record seen with the same or smaller counts adds nothing. Deleting a record
 * file subtracts nothing: what was counted stays counted.
 *
 * Bounded: an entry is kept while its record's hour is within
 * {@link USAGE_DEDUPE_RETENTION_MS}. A record older than that which is read
 * again (a file copied back, a lost offset) re-enters a fresh bucket, and the
 * platform's field-wise MAXIMUM keeps the larger figure it already stored — so
 * an expired entry can make a figure lag, never double it.
 */

/** How long a record identity is remembered (by the record's own hour). */
export const USAGE_DEDUPE_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

/** What is remembered per record: tokens counted (in, out, cacheRead, cacheWrite) and its hour. */
export interface UsageSeenEntry {
	t: [number, number, number, number];
	h: number;
}

export interface UsageAdmission {
	/** The tokens to add to the record's bucket (per-class growth over what was counted). */
	delta: FleetUsageTokens;
	/** First time this record is seen — it counts as one request. */
	isNew: boolean;
}

/** A short, stable identity for a record key (sha256, 20 hex characters). */
export function usageRecordHash(key: string): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 20);
}

export class UsageDedupe {
	constructor(private readonly seen: Record<string, UsageSeenEntry>) {}

	/**
	 * Admit one record: null when it adds nothing (seen, not grown); else the
	 * growth to count and whether it is a new request.
	 */
	admit(record: UsageRecord, hour: number): UsageAdmission | null {
		const id = usageRecordHash(record.key);
		const entry = this.seen[id];
		const now: [number, number, number, number] = [
			record.tokens.in,
			record.tokens.out,
			record.tokens.cacheRead,
			record.tokens.cacheWrite
		];
		if (!entry) {
			this.seen[id] = { t: now, h: hour };
			return { delta: { ...record.tokens }, isNew: true };
		}
		const grown: [number, number, number, number] = [
			Math.max(0, now[0] - entry.t[0]),
			Math.max(0, now[1] - entry.t[1]),
			Math.max(0, now[2] - entry.t[2]),
			Math.max(0, now[3] - entry.t[3])
		];
		if (grown[0] + grown[1] + grown[2] + grown[3] === 0) return null;
		entry.t = [
			Math.max(now[0], entry.t[0]),
			Math.max(now[1], entry.t[1]),
			Math.max(now[2], entry.t[2]),
			Math.max(now[3], entry.t[3])
		];
		return { delta: { in: grown[0], out: grown[1], cacheRead: grown[2], cacheWrite: grown[3] }, isNew: false };
	}

	/** Forget identities whose hour is before `beforeHour`; answers how many were dropped. */
	prune(beforeHour: number): number {
		let dropped = 0;
		for (const [id, entry] of Object.entries(this.seen)) {
			if (!entry || typeof entry.h !== 'number' || entry.h < beforeHour) {
				delete this.seen[id];
				dropped += 1;
			}
		}
		return dropped;
	}

	get size(): number {
		return Object.keys(this.seen).length;
	}
}
