import {
	fleetUsageHourStart,
	normalizeFleetUsageScanPayload,
	type FleetJobView,
	type FleetUsageProvider,
	type FleetUsageReport,
	type FleetUsageScanStats
} from '@ever-works/contracts';
import { parseClaudeUsageLine } from './claude-records';
import { emptyCodexFileState, parseCodexUsageLine } from './codex-records';
import { addToUsageBucket, buildUsageReportSlice, pruneUsageBuckets, usageFolderBucket } from './usage-aggregate';
import { USAGE_DEDUPE_RETENTION_MS, UsageDedupe } from './usage-dedupe';
import type { UsageFs } from './usage-fs';
import { USAGE_MAX_LINE_BYTES, readUsageLines } from './usage-line-reader';
import type { UsageRecord } from './usage-record';
import { listUsageRecordFiles, resolveUsageRoots, type UsageRecordFile, type UsageRootsInput } from './usage-roots';
import { loadUsageScanState, saveUsageScanState, type UsageFileOffset, type UsageScanState } from './usage-watermark';

/**
 * Usage & cost on the fleet (FL-20, plan §6, T-11, CONTRACTS §12, R-34) — the
 * management lane's `usage-scan` executor.
 *
 * One job = one bounded pass over this machine's Claude Code and Codex
 * records:
 *
 *  1. refuse unless the machine's owner switched the scan on (`--usage-scan`,
 *     defence in depth: the lane only leases the kind under that consent);
 *  2. take the payload's `since` (the newest watermark the platform stored)
 *     — or this node's own record of it when the platform sends none;
 *  3. read every record file from its saved offset, oldest file first, within
 *     a byte and a time budget (a year of records drains over several scans,
 *     spec U11) — whole lines only, over-long lines skipped unparsed;
 *  4. keep the allow-listed fields only, count each record once
 *     (`usage-dedupe.ts`), add it to its cumulative bucket;
 *  5. persist the state, then answer the buckets changed after `since`,
 *     oldest first, ≤ 500 rows / 192 KiB (`truncated` says more wait) with
 *     `backlogPct` = the share of record bytes not read yet.
 *
 * What it never does: open a file outside the record folders, follow a link,
 * write to a record file, or put any string other than a model id, a provider
 * session id and a folder bucket into the report.
 */

/** Most record bytes one scan reads (the rest is the next scan's). */
export const USAGE_SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
/** Most wall time one scan spends reading (the NFR: ≤ 30 s). */
export const USAGE_SCAN_BUDGET_MS = 20_000;

export class UsageScanRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageScanRefusedError';
	}
}

export interface UsageScanDeps {
	/** The owner's local switch, read per job (`--usage-scan`). */
	enabled: () => boolean;
	/** `<config dir>/usage` — the scan's own state. */
	stateDir: string;
	platform: string;
	fs: UsageFs;
	/** Where the CLI homes are (environment, home directory, extra homes). */
	roots: () => UsageRootsInput;
	/** Known checkouts and allowed roots (a folder leaves the machine only as one of these). */
	allowedRoots: () => Promise<readonly string[]>;
	now?: () => number;
	budgetBytes?: number;
	budgetMs?: number;
	logger?: { warn(message: string): void; info?(message: string): void };
}

/** One scan, independent of the job wrapper (the specs drive it directly). */
export async function runUsageScan(
	deps: UsageScanDeps,
	since: number | null,
	signal?: AbortSignal
): Promise<FleetUsageReport> {
	if (!deps.enabled()) {
		throw new UsageScanRefusedError(
			'The usage scan is off on this computer — start the node with --usage-scan to switch it on'
		);
	}
	const now = deps.now ?? Date.now;
	const started = now();
	const state = await loadUsageScanState(deps.fs, deps.stateDir, deps.platform);
	const from = acknowledge(state, since);

	const roots = resolveUsageRoots(deps.roots());
	const files: UsageRecordFile[] = [];
	for (const root of roots) files.push(...(await listUsageRecordFiles(root, deps.fs, deps.platform)));
	files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
	const allowed = await deps.allowedRoots().catch(() => [] as readonly string[]);

	const stats: FleetUsageScanStats = {
		files: files.length,
		recordsScanned: 0,
		deduplicated: 0,
		skippedLines: 0,
		oversizeLines: 0,
		durationMs: 0
	};
	const dedupe = new UsageDedupe(state.seen);
	const budgetBytes = deps.budgetBytes ?? USAGE_SCAN_BUDGET_BYTES;
	const budgetMs = deps.budgetMs ?? USAGE_SCAN_BUDGET_MS;
	let spent = 0;
	let totalBytes = 0;
	let unreadBytes = 0;
	const present = new Set<string>();

	for (const file of files) {
		present.add(file.path);
		totalBytes += file.size;
		let offset: UsageFileOffset | undefined = state.files[file.path];
		if (offset && (file.size < offset.o || offset.provider !== file.provider)) {
			// Rewritten or truncated: read it again from the top (the dedupe keeps counts exact).
			offset = undefined;
		}
		const at = offset?.o ?? 0;
		if (at >= file.size) {
			if (offset) state.files[file.path] = { ...offset, s: file.size, m: file.mtimeMs };
			continue;
		}
		const outOfBudget = spent >= budgetBytes || now() - started >= budgetMs || signal?.aborted === true;
		if (outOfBudget) {
			unreadBytes += file.size - at;
			continue;
		}
		const next = await readFile(
			deps,
			file,
			offset ?? null,
			budgetBytes - spent,
			stats,
			dedupe,
			state,
			allowed,
			now,
			signal
		);
		state.files[file.path] = next;
		spent += next.o - at;
		unreadBytes += Math.max(0, file.size - next.o);
	}
	// Forget files that are gone (their counts stay — FR-4: never subtract).
	for (const path of Object.keys(state.files)) if (!present.has(path)) delete state.files[path];

	const clock = now();
	dedupe.prune(fleetUsageHourStart(clock - USAGE_DEDUPE_RETENTION_MS));
	pruneUsageBuckets(state, clock);
	const slice = buildUsageReportSlice(state, from);
	stats.durationMs = Math.max(0, now() - started);
	await saveUsageScanState(deps.fs, deps.stateDir, deps.platform, state);

	let backlogPct = totalBytes > 0 ? Math.round((unreadBytes / totalBytes) * 100) : 0;
	// Bytes all read but rows still waiting to be sent: not caught up yet.
	if (backlogPct === 0 && slice.truncated) backlogPct = 1;
	return {
		watermark: slice.watermark,
		rows: slice.rows,
		truncated: slice.truncated,
		backlogPct: Math.min(100, Math.max(0, backlogPct)),
		stats
	};
}

/**
 * The revision the report starts after. The platform's `since` wins when it
 * sends one (re-sending is harmless: it merges with a maximum); null — no
 * acknowledged scan, or job bodies purged — resumes from what this node last
 * heard. A `since` ahead of this node's revisions means this node lost its
 * state: every bucket it holds is stamped anew so none is skipped.
 */
function acknowledge(state: UsageScanState, since: number | null): number {
	if (since === null) return state.ackedRev;
	if (since > state.rev) {
		state.rev = since;
		for (const bucket of Object.values(state.buckets)) {
			state.rev += 1;
			bucket.v = state.rev;
		}
	}
	state.ackedRev = since;
	return since;
}

async function readFile(
	deps: UsageScanDeps,
	file: UsageRecordFile,
	offset: UsageFileOffset | null,
	budget: number,
	stats: FleetUsageScanStats,
	dedupe: UsageDedupe,
	state: UsageScanState,
	allowed: readonly string[],
	now: () => number,
	signal?: AbortSignal
): Promise<UsageFileOffset> {
	const start = offset?.o ?? 0;
	const codex = file.provider === 'codex' ? (offset?.codex ?? emptyCodexFileState()) : undefined;
	const base: UsageFileOffset = { o: start, s: file.size, m: file.mtimeMs, provider: file.provider };
	if (codex) base.codex = codex;
	let handle: Awaited<ReturnType<UsageFs['openRead']>>;
	try {
		handle = await deps.fs.openRead(file.path);
	} catch (error) {
		deps.logger?.warn(`usage scan: could not open a record file (${describe(error)}) — skipped`);
		return offset ?? base;
	}
	const clock = now();
	try {
		const result = await readUsageLines(
			handle,
			start,
			file.size,
			{ budgetBytes: budget, maxLineBytes: USAGE_MAX_LINE_BYTES, signal, startSkipping: offset?.k === true },
			(line) => {
				const record = parseLine(file.provider, line, codex);
				if (!record) {
					stats.skippedLines += 1;
					return;
				}
				stats.recordsScanned += 1;
				count(record, dedupe, state, allowed, deps.platform, clock, stats);
			}
		);
		stats.oversizeLines += result.oversize;
		const next: UsageFileOffset = { ...base, o: result.nextOffset };
		if (result.skipping) next.k = true;
		return next;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function parseLine(
	provider: FleetUsageProvider,
	line: string,
	codex: ReturnType<typeof emptyCodexFileState> | undefined
): UsageRecord | null {
	if (provider === 'claude-code') return parseClaudeUsageLine(line);
	return codex ? parseCodexUsageLine(line, codex) : null;
}

function count(
	record: UsageRecord,
	dedupe: UsageDedupe,
	state: UsageScanState,
	allowed: readonly string[],
	platform: string,
	now: number,
	stats: FleetUsageScanStats
): void {
	const hour = fleetUsageHourStart(record.at);
	const admission = dedupe.admit(record, hour);
	if (!admission) {
		stats.deduplicated += 1;
		return;
	}
	if (!admission.isNew) stats.deduplicated += 1;
	addToUsageBucket(state, record, admission, usageFolderBucket(record.cwd, allowed, platform), now);
}

function describe(error: unknown): string {
	const code = (error as NodeJS.ErrnoException)?.code;
	return typeof code === 'string' ? code : 'unreadable';
}

/** The management-lane executor: payload `{ nodeId, since }` → a `FleetUsageReport`. */
export function createUsageScanExecutor(deps: UsageScanDeps) {
	return async (job: FleetJobView, signal: AbortSignal): Promise<Record<string, unknown>> => {
		const { since } = normalizeFleetUsageScanPayload(job.payload);
		const report = await runUsageScan(deps, since, signal);
		return report as unknown as Record<string, unknown>;
	};
}
