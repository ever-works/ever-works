import { classifyLogLevel, FLEET_LOGS_READ_TIMEOUT_MS } from '@ever-works/contracts';
import { collectChild, firstLine, LogReadError, type LogIo, type RawLogLine } from './log-io';
import type { LogBatch, LogFollowSink, LogReader } from './log-reader';

/**
 * Logs on computers (FL-08) — one Docker container's log, through the Docker
 * CLI only (`docker logs --timestamps`), never the daemon socket (spec FR-8,
 * README D8). A container writes to stdout AND stderr, and `docker logs`
 * replays both on its own two streams, so both are lines here; the
 * `--timestamps` prefix orders them and lets the follow resume after the last
 * line of the batch (`--since`, lines at or before it skipped).
 *
 * The name has passed the contracts' pattern (no leading `-`, no shell
 * character) and is argv. When the follow ends, `docker inspect` says whether
 * the container is gone (removed — U10) or merely stopped. Container logs are
 * bounded by the Docker log driver: no "earlier" (FR-37).
 */

const NO_SUCH = /no such (container|object)/i;

/** `2026-10-21T09:41:02.123456789Z message` → a raw line (the stamp trimmed to milliseconds). */
export function parseDockerLine(line: string): RawLogLine | null {
	if (line.length === 0) return null;
	const space = line.indexOf(' ');
	const stamp = space > 0 ? line.slice(0, space) : '';
	const parsed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(stamp)
		? Date.parse(stamp.replace(/(\.\d{3})\d+/, '$1'))
		: Number.NaN;
	const text = Number.isNaN(parsed) ? line : line.slice(space + 1);
	return {
		ts: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
		level: classifyLogLevel(null, text),
		text
	};
}

/** Exact stamp kept for `--since` (Docker takes nanoseconds). */
function stampOf(line: string): string | null {
	const space = line.indexOf(' ');
	const stamp = space > 0 ? line.slice(0, space) : '';
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(stamp) ? stamp : null;
}

export function createContainerReader(io: LogIo, container: string, nodeName: string): LogReader {
	let since: string | null = null;

	return {
		supportsEarlier: false,
		async tail(lines): Promise<LogBatch> {
			let lastStamp: string | null = null;
			const result = await collectChild(io, 'docker', ['logs', '--tail', String(lines), '--timestamps', container], {
				max: lines,
				parse: (line) => {
					const stamp = stampOf(line);
					if (stamp && (!lastStamp || stamp > lastStamp)) lastStamp = stamp;
					return parseDockerLine(line);
				},
				stderrIsData: true,
				timeoutMs: FLEET_LOGS_READ_TIMEOUT_MS
			});
			if (result.spawnError) {
				throw new LogReadError('unsupported_on_node', `Docker is not installed on ${nodeName}`);
			}
			if (result.timedOut) {
				throw new LogReadError('operation_failed', `docker logs did not answer within ${FLEET_LOGS_READ_TIMEOUT_MS / 1000} seconds`);
			}
			if (result.code !== 0) {
				const detail = firstLine(result.stderr.join('\n'));
				if (NO_SUCH.test(detail)) throw new LogReadError('not_found', `${container} is gone`);
				throw new LogReadError('operation_failed', `docker logs exited ${result.code ?? 'early'}${detail ? `: "${detail}"` : ''}`);
			}
			since = lastStamp;
			// stdout and stderr arrive on two pipes: put them back in time order.
			const ordered = [...result.entries].sort((a, b) => (a.ts && b.ts ? a.ts.localeCompare(b.ts) : 0));
			return { lines: ordered };
		},
		follow(sink: LogFollowSink) {
			const boundary = since;
			const args = ['logs', '--follow', '--timestamps', ...(boundary ? ['--since', boundary] : ['--tail', '0']), container];
			const child = io.spawn('docker', args);
			let stopped = false;
			child.onLine((line) => {
				const stamp = stampOf(line);
				if (boundary && stamp && stamp <= boundary) return; // already in the batch
				if (stamp) since = stamp;
				const parsed = parseDockerLine(line);
				if (parsed) sink.line(parsed);
			});
			child.onExit(() => {
				if (stopped) return;
				void io.runner
					.run('docker', ['inspect', '--format', '{{.State.Status}}', container], { timeoutMs: 5_000 })
					.then((result) => {
						if (stopped) return;
						const detail = `${result.stdout}\n${result.stderr}`;
						if (result.code !== 0 && NO_SUCH.test(detail)) sink.notice('gone', `${container} is gone`);
						else sink.notice('stopped', `${container} is ${firstLine(result.stdout) || 'not running'}`);
						sink.ended();
					})
					.catch(() => {
						if (stopped) return;
						sink.notice('stopped', `${container} stopped`);
						sink.ended();
					});
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
