import {
	FLEET_LOGS_MAX_FILES_PER_ROOT,
	FLEET_LOGS_MAX_LISTED_SOURCES,
	fleetLogSourceId,
	isFleetLogContainerKey,
	isFleetLogServiceKey,
	type FleetLogSource,
	type FleetLogSourceList,
	type FleetLogSystemSource
} from '@ever-works/contracts';
import { isInsideRoot, type AllowedRoot } from '../../allowed-roots';
import { powershellArgs } from './event-log-source';
import type { LogDirEntry, LogIo } from './log-io';

/**
 * Logs on computers (FL-08) — what this machine can show (`logs.sources`,
 * FR-1 … FR-11): four groups, re-listed every time the tab asks.
 *
 *  - **System** — Linux journal + kernel ring, macOS unified log, Windows
 *    System + Application (+ Security for an administrator; listed as
 *    `needs-admin` otherwise, U7). A Linux user outside the journal groups
 *    still opens the journal, marked `group-membership` with the exact
 *    command (U5).
 *  - **Files** — regular files under the standard log directories (every
 *    text file) and under every allowed root (files that look like logs:
 *    `*.log`, `*.out`, `*.err`, rotated `*.log.N`, anything in a `logs/`
 *    folder), newest first, {@link FLEET_LOGS_MAX_FILES_PER_ROOT} per root.
 *    A file this user cannot read is listed `root-only` and cannot be opened
 *    (U6). Symlinked folders are not walked; a symlinked file is listed only
 *    when it resolves inside its root. The home directory is never a root.
 *  - **Containers** — every container `docker ps -a` reports, running first.
 *  - **Services** — running and failed services, failed first.
 *
 * A group whose tool is missing (no Docker, no systemd) is simply empty.
 */

export interface ListLogSourcesInput {
	io: LogIo;
	roots: readonly AllowedRoot[];
	nodeName: string;
	signal?: AbortSignal;
}

const SYSTEM_LABELS: Readonly<Record<FleetLogSystemSource, string>> = {
	journal: 'System journal',
	kernel: 'Kernel',
	unified: 'Unified log',
	'event-system': 'System',
	'event-application': 'Application',
	'event-security': 'Security'
};

const JOURNAL_GROUPS = ['systemd-journal', 'adm', 'wheel', 'root'];

/** Not text, or not a log anyone reads in a viewer. */
const BINARY_FILE = /\.(?:gz|xz|bz2|zst|lz4|zip|tgz|7z|journal|journal~|db|sqlite|pid|lock|sock)$/i;
const BINARY_NAMES = new Set(['wtmp', 'btmp', 'lastlog', 'faillog', 'utmp']);
const LOG_FILE = /\.(?:log|out|err)$|\.log\.\d+$/i;
const LOG_DIR = /^(?:logs?|var-log)$/i;
const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.hg',
	'.svn',
	'.venv',
	'venv',
	'__pycache__',
	'.next',
	'.turbo',
	'.cache',
	'bower_components',
	'journal'
]);

const MAX_DEPTH_LOG_DIR = 4;
const MAX_DEPTH_ROOT = 6;
/** Directory entries visited per root, so a huge tree never stalls the listing. */
const MAX_VISITS_PER_ROOT = 5_000;
const MAX_SERVICES = 300;

function tildeLabel(path: string, homedir: string, platform: string): string {
	if (!homedir) return path;
	const same = platform === 'win32' ? path.toLowerCase().startsWith(homedir.toLowerCase()) : path.startsWith(homedir);
	if (!same) return path;
	const rest = path.slice(homedir.length);
	return rest.length === 0 ? '~' : /^[\\/]/.test(rest) ? `~${rest}` : path;
}

function join(dir: string, name: string, platform: string): string {
	const sep = platform === 'win32' ? '\\' : '/';
	return dir.endsWith(sep) || dir.endsWith('/') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

async function systemSources(io: LogIo): Promise<FleetLogSource[]> {
	const source = (key: FleetLogSystemSource, extra: Partial<FleetLogSource> = {}): FleetLogSource => ({
		id: fleetLogSourceId('system', key),
		kind: 'system',
		label: SYSTEM_LABELS[key],
		group: '',
		readable: true,
		supportsEarlier: key === 'journal' || key === 'kernel',
		...extra
	});
	switch (io.platform) {
		case 'linux': {
			const version = await io.runner.run('journalctl', ['--version'], { timeoutMs: 3_000 }).catch(() => null);
			if (!version || version.code !== 0) return [];
			let whole = await io.isElevated();
			if (!whole) {
				const groups = await io.runner.run('id', ['-Gn'], { timeoutMs: 3_000 }).catch(() => null);
				whole = Boolean(groups && groups.code === 0 && groups.stdout.split(/\s+/).some((group) => JOURNAL_GROUPS.includes(group)));
			}
			const partial: Partial<FleetLogSource> = whole
				? {}
				: { unreadableReason: 'group-membership', hint: `sudo usermod -aG systemd-journal ${io.user}` };
			return [source('journal', partial), source('kernel', partial)];
		}
		case 'darwin':
			return [source('unified')];
		case 'win32': {
			const admin = await io.isElevated();
			return [
				source('event-system'),
				source('event-application'),
				source(
					'event-security',
					admin
						? {}
						: {
								readable: false,
								unreadableReason: 'needs-admin',
								hint: 'Run the node service as an administrator to read the Security log'
							}
				)
			];
		}
		default:
			return [];
	}
}

interface FoundFile {
	path: string;
	mtimeMs: number;
	size: number;
}

async function walkRoot(io: LogIo, root: AllowedRoot, signal?: AbortSignal): Promise<FoundFile[]> {
	const found: FoundFile[] = [];
	const logDir = root.kind === 'log-dir';
	const maxDepth = logDir ? MAX_DEPTH_LOG_DIR : MAX_DEPTH_ROOT;
	let visits = 0;
	const queue: Array<{ dir: string; depth: number; inLogDir: boolean }> = [{ dir: root.path, depth: 0, inLogDir: logDir }];
	while (queue.length > 0 && visits < MAX_VISITS_PER_ROOT) {
		if (signal?.aborted) break;
		const { dir, depth, inLogDir } = queue.shift()!;
		let entries: LogDirEntry[];
		try {
			entries = await io.fs.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			visits += 1;
			if (visits > MAX_VISITS_PER_ROOT) break;
			const path = join(dir, entry.name, io.platform);
			if (entry.isDirectory && !entry.isSymbolicLink) {
				if (depth + 1 <= maxDepth && !SKIP_DIRS.has(entry.name)) {
					queue.push({ dir: path, depth: depth + 1, inLogDir: inLogDir || LOG_DIR.test(entry.name) });
				}
				continue;
			}
			if (!entry.isFile && !entry.isSymbolicLink) continue;
			if (BINARY_FILE.test(entry.name) || BINARY_NAMES.has(entry.name)) continue;
			if (!inLogDir && !LOG_FILE.test(entry.name)) continue;
			let target = path;
			if (entry.isSymbolicLink) {
				try {
					target = await io.fs.realpath(path);
				} catch {
					continue;
				}
				if (!isInsideRoot(target, root.path, io.platform)) continue;
			}
			try {
				const stat = await io.fs.stat(target);
				if (!stat.isFile) continue;
				found.push({ path: target, mtimeMs: stat.mtimeMs, size: stat.size });
			} catch {
				// vanished between the listing and the stat
			}
		}
	}
	return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, FLEET_LOGS_MAX_FILES_PER_ROOT);
}

async function fileSources(io: LogIo, roots: readonly AllowedRoot[], signal?: AbortSignal): Promise<FleetLogSource[]> {
	const out: FleetLogSource[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		const files = await walkRoot(io, root, signal);
		const group = tildeLabel(root.path, io.homedir, io.platform);
		for (const file of files) {
			const key = io.platform === 'win32' ? file.path.toLowerCase() : file.path;
			if (seen.has(key)) continue;
			seen.add(key);
			const readable = await io.fs.canRead(file.path);
			out.push({
				id: fleetLogSourceId('file', file.path),
				kind: 'file',
				label: tildeLabel(file.path, io.homedir, io.platform),
				group,
				readable,
				...(readable
					? {}
					: {
							unreadableReason: 'root-only' as const,
							hint: io.platform === 'win32' ? 'Readable by an administrator only' : 'Readable by root only'
						}),
				lastWrittenAt: new Date(file.mtimeMs).toISOString(),
				sizeBytes: file.size,
				supportsEarlier: true
			});
		}
	}
	return out;
}

/** `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}'` → sources, running first. */
export function parseDockerPs(stdout: string): FleetLogSource[] {
	const out: FleetLogSource[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const [names, state, status] = line.split('\t');
		const name = (names ?? '').split(',')[0]?.trim() ?? '';
		if (!isFleetLogContainerKey(name)) continue;
		const exit = /Exited \((-?\d+)\)/i.exec(status ?? '');
		const label = state === 'exited' && exit ? `exited (${exit[1]})` : (state ?? '').trim() || 'unknown';
		out.push({
			id: fleetLogSourceId('container', name),
			kind: 'container',
			label: name,
			group: '',
			readable: true,
			state: label,
			supportsEarlier: false
		});
	}
	return out.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.label.localeCompare(b.label));
}

async function containerSources(io: LogIo): Promise<FleetLogSource[]> {
	const result = await io.runner
		.run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'], { timeoutMs: 5_000 })
		.catch(() => null);
	if (!result || result.code !== 0) return [];
	return parseDockerPs(result.stdout);
}

function service(key: string, label: string, state: string, failed: boolean, supportsEarlier: boolean): FleetLogSource {
	return {
		id: fleetLogSourceId('service', key),
		kind: 'service',
		label,
		group: '',
		readable: true,
		state,
		failed,
		supportsEarlier
	};
}

/** `systemctl list-units --type=service --all --no-legend --plain` → running and failed units. */
export function parseSystemctlUnits(stdout: string): FleetLogSource[] {
	const out: FleetLogSource[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const [unit, load, active, sub] = line.trim().split(/\s+/);
		if (!unit || !isFleetLogServiceKey(unit) || load === 'not-found') continue;
		if (active === 'failed') out.push(service(unit, unit, 'failed', true, true));
		else if (active === 'active' && sub === 'running') out.push(service(unit, unit, 'running', false, true));
	}
	return out;
}

/** `launchctl list` → running jobs and third-party jobs whose last exit failed. */
export function parseLaunchctlList(stdout: string): FleetLogSource[] {
	const out: FleetLogSource[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const [pid, status, label] = line.trim().split('\t');
		if (!label || !isFleetLogServiceKey(label) || pid === 'PID') continue;
		if (/^\d+$/.test(pid ?? '')) out.push(service(label, label, 'running', false, false));
		else if (status && status !== '0' && !label.startsWith('com.apple.')) {
			out.push(service(label, label, `failed (exit ${status})`, true, false));
		}
	}
	return out;
}

/** `Name<TAB>DisplayName` lines of the running Windows services. */
export function parseWindowsServices(stdout: string): FleetLogSource[] {
	const out: FleetLogSource[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const [name, display] = line.split('\t');
		const key = (name ?? '').trim();
		if (!isFleetLogServiceKey(key)) continue;
		out.push(service(key, (display ?? '').trim() || key, 'running', false, false));
	}
	return out;
}

const WINDOWS_SERVICES_SCRIPT = [
	'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
	"Get-Service | Where-Object { $_.Status -eq 'Running' } | ForEach-Object { \"$($_.Name)`t$($_.DisplayName)\" }"
].join('\n');

async function serviceSources(io: LogIo): Promise<FleetLogSource[]> {
	let listed: FleetLogSource[] = [];
	switch (io.platform) {
		case 'linux': {
			const result = await io.runner
				.run('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'], {
					timeoutMs: 5_000
				})
				.catch(() => null);
			if (result && result.code === 0) listed = parseSystemctlUnits(result.stdout);
			break;
		}
		case 'darwin': {
			const result = await io.runner.run('launchctl', ['list'], { timeoutMs: 5_000 }).catch(() => null);
			if (result && result.code === 0) listed = parseLaunchctlList(result.stdout);
			break;
		}
		case 'win32': {
			const result = await io.runner
				.run('powershell.exe', powershellArgs(WINDOWS_SERVICES_SCRIPT), { timeoutMs: 10_000 })
				.catch(() => null);
			if (result && result.code === 0) listed = parseWindowsServices(result.stdout);
			break;
		}
		default:
			break;
	}
	return listed
		.sort((a, b) => Number(b.failed === true) - Number(a.failed === true) || a.label.localeCompare(b.label))
		.slice(0, MAX_SERVICES);
}

/** Everything this machine can show, in the tab's order (FR-1). Never throws: a failed group is empty. */
export async function listLogSources(input: ListLogSourcesInput): Promise<FleetLogSourceList> {
	const { io, roots, signal } = input;
	const settle = <T>(promise: Promise<T[]>): Promise<T[]> => promise.catch(() => []);
	const [system, files, containers, services] = await Promise.all([
		settle(systemSources(io)),
		settle(fileSources(io, roots, signal)),
		settle(containerSources(io)),
		settle(serviceSources(io))
	]);
	const all = [...system, ...files, ...containers, ...services];
	return {
		platform: io.platform,
		sources: all.slice(0, FLEET_LOGS_MAX_LISTED_SOURCES),
		roots: roots.map((root) => tildeLabel(root.path, io.homedir, io.platform)),
		truncated: all.length > FLEET_LOGS_MAX_LISTED_SOURCES,
		listedAt: new Date(io.now()).toISOString()
	};
}
