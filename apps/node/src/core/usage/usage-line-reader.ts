import type { UsageReadHandle } from './usage-fs';

/**
 * Usage & cost on the fleet (FL-20, plan §6, NFR performance) — read the
 * COMPLETE lines of one record file from a byte offset, in fixed chunks, with
 * constant memory (the pattern of `executors/model-transcript.ts`).
 *
 *  - only whole lines are handed out: a line still being written (no newline
 *    yet) is left for the next scan, and the returned offset points at it;
 *  - a line longer than `maxLineBytes` is skipped WITHOUT being buffered or
 *    parsed (counted in `oversize`) — a CLI record that large is a tool output
 *    or a file body, never a usage line we could read safely;
 *  - reading stops at `budgetBytes` (the scan's per-file share), at the last
 *    complete line before it; the rest is the next scan's (spec U11).
 *
 * Lines are split on the newline BYTE, so a multi-byte character is never cut.
 */

export interface UsageLineReadResult {
	/** The offset of the first byte NOT consumed (the start of an incomplete line, or EOF). */
	nextOffset: number;
	lines: number;
	oversize: number;
	/** Bytes consumed (nextOffset - start offset). */
	bytesRead: number;
	/**
	 * The read stopped in the middle of an over-long line: `nextOffset` is past
	 * what was read of it, and the next call must pass `startSkipping` so the
	 * rest of that line is discarded too (a line longer than the budget would
	 * otherwise never be passed).
	 */
	skipping: boolean;
}

export interface UsageLineReadOptions {
	/** Most bytes to consume in this call. */
	budgetBytes: number;
	/** Lines longer than this are skipped unparsed. */
	maxLineBytes: number;
	/** Chunk size per read. */
	chunkBytes?: number;
	/** Stop early (the job was aborted). */
	signal?: AbortSignal;
	/** The previous call stopped inside an over-long line: discard up to the next newline first. */
	startSkipping?: boolean;
}

/** One MiB: no usage line is anywhere near it; a longer line is a tool output. */
export const USAGE_MAX_LINE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export async function readUsageLines(
	handle: UsageReadHandle,
	start: number,
	size: number,
	options: UsageLineReadOptions,
	onLine: (line: string) => void
): Promise<UsageLineReadResult> {
	const chunkBytes = options.chunkBytes ?? 64 * 1024;
	const end = Math.min(size, start + Math.max(0, options.budgetBytes));
	let position = start;
	/** Offset just past the last newline consumed. */
	let committed = start;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let skipping = options.startSkipping === true;
	let lines = 0;
	let oversize = 0;
	while (position < end) {
		if (options.signal?.aborted) break;
		const chunk = await handle.read(Math.min(chunkBytes, end - position), position);
		if (chunk.length === 0) break;
		let from = 0;
		while (from < chunk.length) {
			const newline = chunk.indexOf(NEWLINE, from);
			if (newline === -1) {
				const rest = chunk.subarray(from);
				if (!skipping) {
					if (pendingBytes + rest.length > options.maxLineBytes) {
						skipping = true;
						pending = [];
						pendingBytes = 0;
					} else {
						pending.push(Buffer.from(rest));
						pendingBytes += rest.length;
					}
				}
				break;
			}
			const piece = chunk.subarray(from, newline);
			if (skipping || pendingBytes + piece.length > options.maxLineBytes) {
				oversize += 1;
			} else {
				const line =
					pending.length > 0 ? Buffer.concat([...pending, piece]).toString('utf8') : piece.toString('utf8');
				if (line.trim().length > 0) {
					lines += 1;
					onLine(line);
				}
			}
			skipping = false;
			pending = [];
			pendingBytes = 0;
			from = newline + 1;
			committed = position + newline + 1;
		}
		position += chunk.length;
	}
	if (skipping) {
		// Inside an over-long line: what was read of it is consumed, never parsed.
		committed = Math.max(committed, position);
		return { nextOffset: committed, lines, oversize, bytesRead: committed - start, skipping: true };
	}
	return { nextOffset: committed, lines, oversize, bytesRead: committed - start, skipping: false };
}
