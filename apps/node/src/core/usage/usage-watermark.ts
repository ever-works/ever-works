import { posix, win32 } from 'node:path';
import type { FleetUsageProvider } from '@ever-works/contracts';
import type { CodexFileState } from './codex-records';
import type { UsageSeenEntry } from './usage-dedupe';
import type { UsageFs } from './usage-fs';

/**
 * Usage & cost on the fleet (FL-20, plan §6, T-10) — the scan's own state, in
 * ONE owner-only file beside the node config (`<config dir>/usage/state.json`):
 *
 *  - per record file: the byte offset read up to (a scan resumes there), the
 *    size and mtime it had, and — for a Codex rollout — the parser's carry-over;
 *  - the cumulative buckets (provider × session × model × hour × folder
 *    bucket), each with the revision it last changed at;
 *  - the record identities already counted (`usage-dedupe.ts`);
 *  - `rev` (the newest revision handed out) and `ackedRev` (the newest
 *    watermark the platform said it stored — the next job's `since`).
 *
 * Counts, ids and paths of THIS machine only; nothing here is content. A
 * missing or unreadable file is a fresh start: the platform's field-wise
 * maximum makes a full re-read safe (spec U4).
 */

export const USAGE_STATE_FILE = 'state.json';
export const USAGE_STATE_VERSION = 1;

export interface UsageFileOffset {
	/** Bytes consumed (the start of the next unread line). */
	o: number;
	/** Size and mtime when last read — a smaller size means the file was rewritten. */
	s: number;
	m: number;
	/** Mid-way through skipping an over-long line when the last scan stopped. */
	k?: true;
	provider: FleetUsageProvider;
	/** Codex: the parser's carry-over (session id, model, folder, previous totals). */
	codex?: CodexFileState;
}

/** One cumulative bucket (compact keys: the file is rewritten every scan). */
export interface UsageBucket {
	/** Provider. */
	p: FleetUsageProvider;
	/** Provider session id, or null. */
	s: string | null;
	/** Model id. */
	m: string;
	/** Hour start (ms). */
	h: number;
	/** Folder bucket: a known checkout / root path, `other:<hash8>`, or null. */
	f: string | null;
	/** Tokens: in, out, cacheRead, cacheWrite. */
	t: [number, number, number, number];
	/** Requests. */
	r: number;
	/** First and last record time (ms). */
	a: number;
	z: number;
	/** Revision it last changed at. */
	v: number;
	/** When this machine last changed it (ms) — for pruning. */
	u: number;
}

export interface UsageScanState {
	version: number;
	rev: number;
	ackedRev: number;
	files: Record<string, UsageFileOffset>;
	buckets: Record<string, UsageBucket>;
	seen: Record<string, UsageSeenEntry>;
}

export function emptyUsageScanState(): UsageScanState {
	return { version: USAGE_STATE_VERSION, rev: 0, ackedRev: 0, files: {}, buckets: {}, seen: {} };
}

function pathApi(platform: string) {
	return platform === 'win32' ? win32 : posix;
}

export function usageStatePath(dir: string, platform: string): string {
	return pathApi(platform).join(dir, USAGE_STATE_FILE);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonNegative(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Load the state; a missing, unreadable or foreign-version file is a fresh start. */
export async function loadUsageScanState(fs: UsageFs, dir: string, platform: string): Promise<UsageScanState> {
	let text: string | null = null;
	try {
		text = await fs.readFile(usageStatePath(dir, platform));
	} catch {
		return emptyUsageScanState();
	}
	if (!text) return emptyUsageScanState();
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return emptyUsageScanState();
	}
	if (!isObject(raw) || raw.version !== USAGE_STATE_VERSION) return emptyUsageScanState();
	return {
		version: USAGE_STATE_VERSION,
		rev: nonNegative(raw.rev),
		ackedRev: nonNegative(raw.ackedRev),
		files: isObject(raw.files) ? (raw.files as Record<string, UsageFileOffset>) : {},
		buckets: isObject(raw.buckets) ? (raw.buckets as Record<string, UsageBucket>) : {},
		seen: isObject(raw.seen) ? (raw.seen as Record<string, UsageSeenEntry>) : {}
	};
}

/** Persist the state atomically, owner-only. */
export async function saveUsageScanState(
	fs: UsageFs,
	dir: string,
	platform: string,
	state: UsageScanState
): Promise<void> {
	await fs.mkdir(dir);
	await fs.writeFileAtomic(usageStatePath(dir, platform), JSON.stringify(state));
}
