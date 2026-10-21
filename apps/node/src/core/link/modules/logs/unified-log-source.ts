import {
	classifyLogLevel,
	FLEET_LOGS_READ_TIMEOUT_MS,
	leadingFleetLogTimestamp
} from '@ever-works/contracts';
import { collectChild, firstLine, LogReadError, type LogIo, type RawLogLine } from './log-io';
import type { LogBatch, LogFollowSink, LogReader } from './log-reader';

/**
 * Logs on computers (FL-08) — the macOS unified log (`log show` / `log
 * stream --style ndjson`, plan §3). Each record carries its `messageType`
 * (Default, Info, Debug, Error, Fault — the level) and the image of the
 * process that wrote it (the "sshd: …" prefix).
 *
 * `log show` has no "last N lines": the batch reads a bounded window
 * (`--last 2m` for the whole log, `--last 1h` for one process) and keeps the
 * newest `lines`; on a very busy machine it stops at the read timeout with
 * what it has rather than failing. A service's lines are the records of its
 * process (`--predicate 'process == "<name>"'`); the name has passed the
 * contracts' pattern, which admits no quote.
 */

export interface UnifiedLogReaderOptions {
	/** Only this process's records (a launchd service). */
	process?: string;
}

/** One `log show|stream --style ndjson` line → a raw line; null for anything else (headers, the summary). */
export function parseUnifiedLogLine(line: string): RawLogLine | null {
	if (!line.startsWith('{')) return null;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (typeof record.eventMessage !== 'string') return null;
	const image = typeof record.processImagePath === 'string' ? record.processImagePath : '';
	const process = image ? image.slice(image.lastIndexOf('/') + 1) : '';
	const ts = typeof record.timestamp === 'string' ? leadingFleetLogTimestamp(record.timestamp) : null;
	const message = record.eventMessage;
	return {
		ts,
		level: classifyLogLevel(typeof record.messageType === 'string' ? record.messageType : null, message),
		text: process ? `${process}: ${message}` : message
	};
}

function predicateArgs(options: UnifiedLogReaderOptions): string[] {
	return options.process ? ['--predicate', `process == "${options.process}"`] : [];
}

export function createUnifiedLogReader(io: LogIo, options: UnifiedLogReaderOptions = {}): LogReader {
	return {
		supportsEarlier: false,
		async tail(lines): Promise<LogBatch> {
			const window = options.process ? '1h' : '2m';
			const result = await collectChild(
				io,
				'log',
				['show', '--style', 'ndjson', '--last', window, ...predicateArgs(options)],
				{ max: lines, parse: parseUnifiedLogLine, timeoutMs: FLEET_LOGS_READ_TIMEOUT_MS, partialOnTimeout: true }
			);
			if (result.spawnError) {
				throw new LogReadError('unsupported_on_node', 'the unified log (log) is not available on this computer');
			}
			if (result.timedOut && result.entries.length === 0) {
				throw new LogReadError('operation_failed', `log show did not answer within ${FLEET_LOGS_READ_TIMEOUT_MS / 1000} seconds`);
			}
			if (!result.timedOut && result.code !== 0 && result.entries.length === 0) {
				const detail = firstLine(result.stderr.join('\n'));
				throw new LogReadError('operation_failed', `log show exited ${result.code ?? 'early'}${detail ? `: "${detail}"` : ''}`);
			}
			return { lines: result.entries };
		},
		follow(sink: LogFollowSink) {
			const child = io.spawn('log', ['stream', '--style', 'ndjson', ...predicateArgs(options)]);
			let stopped = false;
			child.onLine((line, stream) => {
				if (stream !== 'stdout') return;
				const parsed = parseUnifiedLogLine(line);
				if (parsed) sink.line(parsed);
			});
			child.onExit((code) => {
				if (stopped) return;
				sink.notice('error', `log stream stopped (exit ${code ?? 'signal'})`);
				sink.ended();
			});
			return {
				stop: () => {
					stopped = true;
					child.kill();
				}
			};
		}
	};
}
