import {
	classifyLogLevel,
	FLEET_LOGS_READ_TIMEOUT_MS,
	fleetLogLevelFromSyslogPriority
} from '@ever-works/contracts';
import { collectChild, firstLine, LogReadError, type LogIo, type RawLogLine } from './log-io';
import type { LogBatch, LogFollowSink, LogReader } from './log-reader';

/**
 * Logs on computers (FL-08) — the Linux system journal (`journalctl`, plan §3).
 *
 * JSON output (`-o json`) gives each entry its `PRIORITY` (the level), its
 * identifier and pid (the "sshd[812]" prefix) and its `__CURSOR`, so the
 * follow resumes EXACTLY after the last line of the batch
 * (`--after-cursor`) and an older page starts before the first
 * (`--until` + cursor de-duplication). Three shapes:
 *
 *  - the whole journal (`system:journal`);
 *  - the kernel ring (`system:kernel`, `-k`);
 *  - one unit (`service:<unit>`, `-u <unit>`), for the Services group.
 *
 * Every argument is argv, never a shell string; a unit name has already
 * passed the contracts' pattern. When the node's user is not in a journal
 * group, `journalctl` says so on stderr ("not seeing messages from other
 * users"): the batch still answers with what is readable and a
 * `group-membership` notice carrying the exact command (U5) — nothing is run
 * for the person.
 */

export interface JournalReaderOptions {
	kernel?: boolean;
	unit?: string;
}

interface JournalEntry extends RawLogLine {
	cursor: string | null;
	/** Microseconds since the epoch, for `--until` on an older page. */
	realtimeUs: number | null;
}

const NOT_ALL_USERS = /not seeing messages from other users/i;

function decodeMessage(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((byte) => typeof byte === 'number')) {
		return Buffer.from(value as number[]).toString('utf8');
	}
	return value === null || value === undefined ? '' : String(value);
}

/** One `journalctl -o json` line → an entry; null for a line that is not one. */
export function parseJournalLine(line: string): JournalEntry | null {
	if (!line.startsWith('{')) return null;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	const message = decodeMessage(record.MESSAGE).replace(/\r?\n$/, '');
	const ident =
		(typeof record.SYSLOG_IDENTIFIER === 'string' && record.SYSLOG_IDENTIFIER) ||
		(typeof record._COMM === 'string' && record._COMM) ||
		(record._TRANSPORT === 'kernel' ? 'kernel' : '');
	const pid = typeof record._PID === 'string' && /^\d+$/.test(record._PID) ? `[${record._PID}]` : '';
	const realtime = typeof record.__REALTIME_TIMESTAMP === 'string' ? Number(record.__REALTIME_TIMESTAMP) : Number.NaN;
	const ts = Number.isFinite(realtime) ? new Date(Math.floor(realtime / 1000)).toISOString() : null;
	const level = fleetLogLevelFromSyslogPriority(record.PRIORITY) ?? classifyLogLevel(null, message);
	return {
		ts,
		level,
		text: ident ? `${ident}${pid}: ${message}` : message,
		cursor: typeof record.__CURSOR === 'string' && record.__CURSOR.length <= 512 ? record.__CURSOR : null,
		realtimeUs: Number.isFinite(realtime) ? realtime : null
	};
}

function filterArgs(options: JournalReaderOptions): string[] {
	if (options.kernel) return ['-k'];
	if (options.unit) return ['-u', options.unit];
	return [];
}

function strip(entry: JournalEntry): RawLogLine {
	return { ts: entry.ts, level: entry.level, text: entry.text };
}

export function createJournalReader(io: LogIo, options: JournalReaderOptions = {}): LogReader {
	let lastCursor: string | null = null;
	let oldest: { cursor: string | null; realtimeUs: number | null } | null = null;

	const run = async (args: string[], max: number) => {
		const result = await collectChild(io, 'journalctl', ['-o', 'json', '--no-pager', ...args, ...filterArgs(options)], {
			max,
			parse: parseJournalLine,
			timeoutMs: FLEET_LOGS_READ_TIMEOUT_MS
		});
		if (result.spawnError) {
			throw new LogReadError('unsupported_on_node', 'the system journal (journalctl) is not available on this computer');
		}
		if (result.timedOut) {
			throw new LogReadError('operation_failed', `journalctl did not answer within ${FLEET_LOGS_READ_TIMEOUT_MS / 1000} seconds`);
		}
		if (result.code !== 0 && result.entries.length === 0) {
			const detail = firstLine(result.stderr.join('\n'));
			throw new LogReadError('operation_failed', `journalctl exited ${result.code ?? 'early'}${detail ? `: "${detail}"` : ''}`);
		}
		return result;
	};

	return {
		supportsEarlier: true,
		async tail(lines): Promise<LogBatch> {
			const result = await run(['-n', String(lines)], lines);
			const entries = result.entries;
			lastCursor = entries.length > 0 ? entries[entries.length - 1]!.cursor : null;
			oldest = entries.length > 0 ? { cursor: entries[0]!.cursor, realtimeUs: entries[0]!.realtimeUs } : null;
			const batch: LogBatch = { lines: entries.map(strip) };
			if (result.stderr.some((line) => NOT_ALL_USERS.test(line))) {
				batch.notice = {
					kind: 'group-membership',
					hint: `sudo usermod -aG systemd-journal ${io.user}`
				};
			}
			return batch;
		},
		follow(sink: LogFollowSink) {
			const args = ['-o', 'json', '--no-pager', '-f', ...(lastCursor ? [`--after-cursor=${lastCursor}`] : ['-n', '0'])];
			const child = io.spawn('journalctl', [...args, ...filterArgs(options)]);
			let stopped = false;
			child.onLine((line, stream) => {
				if (stream !== 'stdout') return;
				const entry = parseJournalLine(line);
				if (!entry) return;
				if (entry.cursor) lastCursor = entry.cursor;
				sink.line(strip(entry));
			});
			child.onExit((code, spawnError) => {
				if (stopped) return;
				sink.notice('error', spawnError ? 'journalctl could not be started' : `journalctl stopped (exit ${code ?? 'signal'})`);
				sink.ended();
			});
			return {
				stop: () => {
					stopped = true;
					child.kill();
				}
			};
		},
		async earlier(lines) {
			if (!oldest || oldest.realtimeUs === null) return { lines: [], hasMore: false };
			// `--until` is inclusive and second-granular: ask for a few more and
			// drop everything at or after the oldest line already handed out.
			const untilSec = Math.ceil(oldest.realtimeUs / 1_000_000);
			const result = await run(['-n', String(lines + 50), `--until=@${untilSec}`], lines + 50);
			const boundary = oldest;
			const older = result.entries.filter(
				(entry) =>
					entry.realtimeUs !== null &&
					boundary.realtimeUs !== null &&
					entry.realtimeUs <= boundary.realtimeUs &&
					entry.cursor !== boundary.cursor
			);
			// Entries sharing the boundary's microsecond but not its cursor are
			// kept; anything at or after it in the same second that we already
			// sent has a later realtime and was filtered above.
			const page = older.slice(-lines);
			if (page.length > 0) oldest = { cursor: page[0]!.cursor, realtimeUs: page[0]!.realtimeUs };
			return { lines: page.map(strip), hasMore: older.length >= lines };
		}
	};
}
