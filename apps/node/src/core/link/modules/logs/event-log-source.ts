import {
	classifyLogLevel,
	FLEET_LOGS_INITIAL_LINES,
	FLEET_LOGS_READ_TIMEOUT_MS,
	fleetLogLevelFromWindowsEventLevel
} from '@ever-works/contracts';
import { collectChild, firstLine, LogReadError, type LogIo, type RawLogLine } from './log-io';
import type { LogBatch, LogFollowSink, LogReader } from './log-reader';

/**
 * Logs on computers (FL-08) — Windows event logs (`Get-WinEvent`, plan §3).
 *
 * PowerShell runs an ENCODED command (`-EncodedCommand`, UTF-16LE base64),
 * so no log or provider name is ever spliced into a command line a shell
 * parses; the names that reach the script have passed the contracts'
 * pattern (no quote) and are single-quoted again inside it. Event logs have
 * no native tail: the follow polls every {@link EVENT_LOG_POLL_MS} for events
 * newer than the last one seen, de-duplicated by log and record id.
 *
 * The Security log needs an administrator; without one the read is refused
 * `unsupported_on_node` with the spec's hint (U7).
 */

export const EVENT_LOG_POLL_MS = 2_000;

export interface EventLogReaderOptions {
	/** `System`, `Application`, `Security` — one or more. */
	logs: readonly string[];
	/** Only this provider's events (a Windows service). */
	provider?: string;
}

interface EventEntry extends RawLogLine {
	key: string;
}

function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** The PowerShell for one read: newest `max` events, oldest first, one JSON per line. */
export function eventLogScript(
	options: EventLogReaderOptions,
	max: number,
	after?: string | null,
	before?: string | null
): string {
	const conditions: string[] = [];
	// The provider passed the contracts' pattern (no quote); the whole XPath is
	// single-quoted for PowerShell below, which doubles its inner quotes.
	if (options.provider) conditions.push(`Provider[@Name='${options.provider}']`);
	if (after) conditions.push(`TimeCreated[@SystemTime>'${after}']`);
	// P2 (`logs.earlier`): the page before the oldest event handed out.
	if (before) conditions.push(`TimeCreated[@SystemTime<'${before}']`);
	const xpath = conditions.length > 0 ? ` -FilterXPath ${psQuote(`*[System[${conditions.join(' and ')}]]`)}` : '';
	return [
		"$ErrorActionPreference = 'Stop'",
		'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
		'try {',
		`  $events = @(Get-WinEvent -LogName ${options.logs.map(psQuote).join(',')} -MaxEvents ${max}${xpath})`,
		'} catch {',
		"  if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { exit 0 }",
		'  [Console]::Error.WriteLine($_.Exception.Message)',
		'  exit 1',
		'}',
		'$events | Sort-Object TimeCreated, RecordId | ForEach-Object {',
		"  [pscustomobject]@{ log = $_.LogName; id = $_.RecordId; ts = $_.TimeCreated.ToUniversalTime().ToString('o'); level = $_.Level; provider = $_.ProviderName; msg = $_.Message } | ConvertTo-Json -Compress",
		'}'
	].join('\n');
}

/** `powershell.exe` argv for a script: no profile, no prompt, encoded. */
export function powershellArgs(script: string): string[] {
	return [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		Buffer.from(script, 'utf16le').toString('base64')
	];
}

/** One JSON line the script wrote → an entry; null for anything else. */
export function parseEventLine(line: string): EventEntry | null {
	if (!line.startsWith('{')) return null;
	let record: Record<string, unknown>;
	try {
		record = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	const message = typeof record.msg === 'string' ? record.msg.replace(/\r\n/g, '\n').trimEnd() : '';
	const provider = typeof record.provider === 'string' ? record.provider : '';
	const ts =
		typeof record.ts === 'string' && !Number.isNaN(Date.parse(record.ts))
			? new Date(Date.parse(record.ts)).toISOString()
			: null;
	return {
		ts,
		level: fleetLogLevelFromWindowsEventLevel(record.level) ?? classifyLogLevel(null, message),
		text: provider ? `${provider}: ${message || `(event ${String(record.id ?? '')})`}` : message,
		key: `${String(record.log ?? '')}:${String(record.id ?? '')}`
	};
}

function strip(entry: EventEntry): RawLogLine {
	return { ts: entry.ts, level: entry.level, text: entry.text };
}

const UNAUTHORIZED = /unauthorized operation|access is denied/i;

export function createEventLogReader(io: LogIo, options: EventLogReaderOptions): LogReader {
	let newest: string | null = null;
	let oldest: string | null = null;
	const recent = new Set<string>();

	const read = async (max: number, after: string | null, before: string | null = null) => {
		const result = await collectChild(
			io,
			'powershell.exe',
			powershellArgs(eventLogScript(options, max, after, before)),
			{
				max,
				parse: parseEventLine,
				timeoutMs: FLEET_LOGS_READ_TIMEOUT_MS
			}
		);
		if (result.spawnError)
			throw new LogReadError('unsupported_on_node', 'PowerShell is not available on this computer');
		if (result.timedOut) {
			throw new LogReadError(
				'operation_failed',
				`Get-WinEvent did not answer within ${FLEET_LOGS_READ_TIMEOUT_MS / 1000} seconds`
			);
		}
		if (result.code !== 0) {
			const detail = firstLine(result.stderr.join('\n'));
			if (UNAUTHORIZED.test(detail)) {
				throw new LogReadError(
					'unsupported_on_node',
					`Run the node service as an administrator to read the ${options.logs.join(' and ')} log`
				);
			}
			throw new LogReadError('operation_failed', `Get-WinEvent failed${detail ? `: "${detail}"` : ''}`);
		}
		return result.entries;
	};

	const remember = (entries: EventEntry[]) => {
		for (const entry of entries) recent.add(entry.key);
		// The window only needs the last poll's worth of ids.
		while (recent.size > FLEET_LOGS_INITIAL_LINES * 2) {
			const first = recent.values().next().value;
			if (first === undefined) break;
			recent.delete(first);
		}
		const last = entries[entries.length - 1];
		if (last?.ts) newest = last.ts;
	};

	return {
		supportsEarlier: true,
		async tail(lines): Promise<LogBatch> {
			const entries = await read(lines, null);
			remember(entries);
			oldest = entries[0]?.ts ?? null;
			if (!newest) newest = new Date(io.now()).toISOString();
			return { lines: entries.map(strip) };
		},
		follow(sink: LogFollowSink) {
			let stopped = false;
			let timer: unknown = null;
			let failures = 0;
			const poll = async () => {
				if (stopped) return;
				try {
					const entries = await read(FLEET_LOGS_INITIAL_LINES, newest);
					failures = 0;
					const fresh = entries.filter((entry) => !recent.has(entry.key));
					remember(entries);
					for (const entry of fresh) if (!stopped) sink.line(strip(entry));
				} catch (error) {
					failures += 1;
					if (failures >= 3) {
						sink.notice(
							'error',
							error instanceof Error ? error.message : 'the event log could not be read'
						);
						sink.ended();
						return;
					}
				}
				if (!stopped) timer = io.setTimer(() => void poll(), EVENT_LOG_POLL_MS);
			};
			timer = io.setTimer(() => void poll(), EVENT_LOG_POLL_MS);
			return {
				stop: () => {
					stopped = true;
					if (timer !== null) io.clearTimer(timer);
				}
			};
		},
		async earlier(lines) {
			if (!oldest) return { lines: [], hasMore: false };
			const entries = await read(lines, null, oldest);
			if (entries.length > 0 && entries[0]!.ts) oldest = entries[0]!.ts;
			return { lines: entries.map(strip), hasMore: entries.length >= lines };
		}
	};
}
