import { StringDecoder } from 'string_decoder';
import { classifyLogLevel, FLEET_LOGS_FILE_SCAN_MAX_BYTES, leadingFleetLogTimestamp } from '@ever-works/contracts';
import { LogReadError, type LogIo, type RawLogLine } from './log-io';
import type { LogBatch, LogFollowSink, LogReader } from './log-reader';

/**
 * Logs on computers (FL-08) — one file, tailed by the node itself (no tail
 * binary, plan §3):
 *
 *  - **the last lines** — read backwards from the end in
 *    {@link FILE_SCAN_CHUNK_BYTES} chunks until enough newlines are found, at
 *    most {@link FLEET_LOGS_FILE_SCAN_MAX_BYTES}; fewer lines than asked
 *    because of that bound says so (`scanLimited`);
 *  - **following** — polled every {@link FILE_POLL_MS}: new bytes are read
 *    from the last offset; a file whose identity changed (rotated: a new
 *    inode at the same path) or whose size went DOWN (truncated) is read again
 *    from its start, so the follow survives rotation without a reopen (FR-20);
 *    a file that stays missing for {@link FILE_GONE_AFTER_MS} is `gone` (U10);
 *    a log growing far faster than it can be read skips ahead rather than
 *    falling behind forever;
 *  - **earlier** (P2) — the same backward scan from the oldest line handed out.
 *
 * The path was canonicalised and proved to sit under an allowed root before
 * this reader was built (`allowed-roots.ts`); lines are split on `\n` with a
 * trailing `\r` stripped (CRLF), decoded as UTF-8 across chunk boundaries.
 */

export const FILE_SCAN_CHUNK_BYTES = 64 * 1024;
export const FILE_POLL_MS = 500;
export const FILE_GONE_AFTER_MS = 5_000;
/** Bytes read per poll. */
export const FILE_READ_PER_POLL_BYTES = 1024 * 1024;
/** A backlog past this is skipped (only the newest {@link FILE_READ_PER_POLL_BYTES} are read). */
export const FILE_MAX_BACKLOG_BYTES = 8 * 1024 * 1024;

function toLine(text: string): RawLogLine {
	const clean = text.endsWith('\r') ? text.slice(0, -1) : text;
	return { ts: leadingFleetLogTimestamp(clean), level: classifyLogLevel(null, clean), text: clean };
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

const NEWLINE = 0x0a;

/**
 * The last `lines` complete lines that END at byte `end`, scanning back at
 * most `maxBytes`. Answers the lines (oldest first), the byte offset the
 * first one starts at, and whether the bound cut the scan short.
 */
export async function scanBackward(
	io: Pick<LogIo, 'fs'>,
	path: string,
	end: number,
	lines: number,
	maxBytes: number = FLEET_LOGS_FILE_SCAN_MAX_BYTES
): Promise<{ lines: string[]; startOffset: number; scanLimited: boolean }> {
	if (end <= 0 || lines <= 0) return { lines: [], startOffset: 0, scanLimited: false };
	const chunks: Uint8Array[] = [];
	let position = end;
	let newlines = 0;
	let scanned = 0;
	while (position > 0 && scanned < maxBytes && newlines <= lines) {
		const size = Math.min(FILE_SCAN_CHUNK_BYTES, position, maxBytes - scanned);
		position -= size;
		const chunk = await io.fs.read(path, position, size);
		chunks.unshift(chunk);
		scanned += chunk.byteLength;
		for (let i = 0; i < chunk.byteLength; i += 1) if (chunk[i] === NEWLINE) newlines += 1;
		if (chunk.byteLength < size) break; // the file shrank under us
	}
	let bytes = concat(chunks);
	let startOffset = position;
	// Not at the start of the file: the first piece is the tail of an older
	// line — drop it, up to and including its newline.
	if (position > 0) {
		const first = bytes.indexOf(NEWLINE);
		if (first < 0) return { lines: [], startOffset: end, scanLimited: true };
		bytes = bytes.subarray(first + 1);
		startOffset = position + first + 1;
	}
	const text = new TextDecoder('utf-8').decode(bytes);
	const parts = text.split('\n');
	if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
	const kept = parts.slice(-lines);
	// Bytes of the dropped leading lines move the start offset forward.
	const droppedText = parts
		.slice(0, parts.length - kept.length)
		.map((part) => `${part}\n`)
		.join('');
	startOffset += Buffer.byteLength(droppedText, 'utf8');
	const scanLimited = kept.length < lines && position > 0;
	return { lines: kept, startOffset, scanLimited };
}

export function createFileReader(io: LogIo, path: string): LogReader {
	let offset = 0;
	let identity = 0;
	let oldestOffset = 0;
	const label = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || path;

	const statOrNull = async () => {
		try {
			return await io.fs.stat(path);
		} catch {
			return null;
		}
	};

	return {
		supportsEarlier: true,
		async tail(lines): Promise<LogBatch> {
			const stat = await statOrNull();
			if (!stat) throw new LogReadError('not_found', `${label} is gone`);
			if (!stat.isFile) throw new LogReadError('invalid', `${label} is not a file`);
			if (!(await io.fs.canRead(path))) {
				throw new LogReadError(
					'unsupported_on_node',
					`${label} is readable by ${io.platform === 'win32' ? 'an administrator' : 'root'} only on this computer`
				);
			}
			const scan = await scanBackward(io, path, stat.size, lines);
			offset = stat.size;
			identity = stat.ino;
			oldestOffset = scan.startOffset;
			return { lines: scan.lines.map(toLine), scanLimited: scan.scanLimited };
		},
		follow(sink: LogFollowSink) {
			let stopped = false;
			let timer: unknown = null;
			let missingSince: number | null = null;
			let decoder = new StringDecoder('utf8');
			let carry = '';
			const restart = () => {
				offset = 0;
				carry = '';
				decoder = new StringDecoder('utf8');
			};
			const poll = async () => {
				if (stopped) return;
				const stat = await statOrNull();
				if (!stat) {
					missingSince ??= io.now();
					if (io.now() - missingSince >= FILE_GONE_AFTER_MS) {
						sink.notice('gone', `${label} is gone`);
						sink.ended();
						return;
					}
				} else {
					missingSince = null;
					if ((identity !== 0 && stat.ino !== 0 && stat.ino !== identity) || stat.size < offset) {
						// Rotated (a new file at this path) or truncated: read it from its start.
						identity = stat.ino;
						restart();
					}
					if (stat.size - offset > FILE_MAX_BACKLOG_BYTES) {
						sink.notice(
							'dropped',
							`skipped ${Math.round((stat.size - offset - FILE_READ_PER_POLL_BYTES) / (1024 * 1024))} MiB — the log is faster than the link`
						);
						offset = stat.size - FILE_READ_PER_POLL_BYTES;
						carry = '';
						decoder = new StringDecoder('utf8');
					}
					if (stat.size > offset) {
						try {
							const chunk = await io.fs.read(
								path,
								offset,
								Math.min(stat.size - offset, FILE_READ_PER_POLL_BYTES)
							);
							offset += chunk.byteLength;
							carry += decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
							const parts = carry.split('\n');
							carry = parts.pop() ?? '';
							for (const part of parts) if (!stopped) sink.line(toLine(part));
						} catch {
							// a read raced a rotation: the next poll sees the new file
						}
					}
				}
				if (!stopped) timer = io.setTimer(() => void poll(), FILE_POLL_MS);
			};
			timer = io.setTimer(() => void poll(), FILE_POLL_MS);
			return {
				stop: () => {
					stopped = true;
					if (timer !== null) io.clearTimer(timer);
				}
			};
		},
		async earlier(lines) {
			if (oldestOffset <= 0) return { lines: [], hasMore: false };
			const scan = await scanBackward(io, path, oldestOffset, lines);
			oldestOffset = scan.startOffset;
			return { lines: scan.lines.map(toLine), hasMore: oldestOffset > 0 };
		}
	};
}
