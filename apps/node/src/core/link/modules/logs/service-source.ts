import { createEventLogReader } from './event-log-source';
import { createFileReader } from './file-source';
import { createJournalReader } from './journal-source';
import { firstLine, LogReadError, type LogIo } from './log-io';
import type { LogReader } from './log-reader';
import { createUnifiedLogReader } from './unified-log-source';

/**
 * Logs on computers (FL-08) — a running service's lines, as its service
 * manager attributes them (FR-9, plan §3 "each service manager has one honest
 * attribution"):
 *
 *  - **Linux (systemd)** — the journal for the unit (`journalctl -u`).
 *  - **macOS (launchd)** — the file the job's `StandardOutPath` (else
 *    `StandardErrorPath`) names, read from `launchctl print`, when it exists
 *    and is readable; otherwise the unified log records of the job's process
 *    (the label's last segment).
 *  - **Windows** — the System and Application event logs filtered to the
 *    service's provider name.
 *
 * The key has passed the contracts' service pattern before it gets here.
 */

/** `stdout path = /usr/local/var/log/nginx.log` lines of `launchctl print`. */
export function parseLaunchctlLogPaths(output: string): { stdout: string | null; stderr: string | null } {
	const read = (name: string): string | null => {
		const match = new RegExp(`^\\s*${name} path = (.+)$`, 'm').exec(output);
		const value = match?.[1]?.trim() ?? '';
		return value.startsWith('/') && !value.includes('\0') ? value : null;
	};
	return { stdout: read('stdout'), stderr: read('stderr') };
}

async function launchdLogFile(io: LogIo, label: string): Promise<string | null> {
	const uid = await io.runner.run('id', ['-u'], { timeoutMs: 3_000 }).catch(() => null);
	const domains = [`system/${label}`, ...(uid && uid.code === 0 ? [`gui/${firstLine(uid.stdout)}/${label}`] : [])];
	for (const domain of domains) {
		const result = await io.runner.run('launchctl', ['print', domain], { timeoutMs: 5_000 }).catch(() => null);
		if (!result || result.code !== 0) continue;
		const paths = parseLaunchctlLogPaths(result.stdout);
		for (const candidate of [paths.stdout, paths.stderr]) {
			if (!candidate) continue;
			try {
				const stat = await io.fs.stat(candidate);
				if (stat.isFile && (await io.fs.canRead(candidate))) return candidate;
			} catch {
				// not there: try the next
			}
		}
	}
	return null;
}

export async function createServiceReader(io: LogIo, service: string): Promise<LogReader> {
	switch (io.platform) {
		case 'linux':
			return createJournalReader(io, { unit: service });
		case 'darwin': {
			const file = await launchdLogFile(io, service);
			if (file) return createFileReader(io, await io.fs.realpath(file).catch(() => file));
			const process = service.slice(service.lastIndexOf('.') + 1) || service;
			return createUnifiedLogReader(io, { process });
		}
		case 'win32':
			return createEventLogReader(io, { logs: ['System', 'Application'], provider: service });
		default:
			throw new LogReadError('unsupported_on_node', `service logs are not available on ${io.platform}`);
	}
}
