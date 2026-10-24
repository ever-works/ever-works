import { isFleetPortNumber, type FleetPortDiscoveryTool } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { encodePowerShell } from '../../../health-probe';

/**
 * Servers and ports (FL-10, plan §3) — what the machine is listening on.
 *
 * One read per OS, TCP only (spec §8):
 *
 *  - **Linux** `ss -tlnpH` — the process column needs permission to see
 *    another user's sockets; when `ss` refuses `-p` (or prints no process
 *    for a socket) the listener is kept with its PID unknown, never dropped
 *    and never retried with `sudo`;
 *  - **macOS** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` — the field output, one
 *    `p`/`c` pair per process followed by its `n` names;
 *  - **Windows** `Get-NetTCPConnection -State Listen` joined to
 *    `Get-Process` in one PowerShell start, printed as JSON (sent with
 *    `-EncodedCommand`, because the node's runner spawns through the shell).
 *
 * The parsers are pure and exported; the fixtures in the specs are real
 * outputs of each tool.
 */

/** One listening socket, before classification. */
export interface RawListener {
	port: number;
	/** The bind address without brackets or an interface suffix (`0.0.0.0`, `::`, `127.0.0.1`, `::1`). */
	bind: string;
	pid: number | null;
	/** The process name the tool printed (`node`, `sshd`, `svchost`), when it printed one. */
	program: string | null;
	/** Windows only: the executable's path, which gives the program's folder. */
	path?: string | null;
}

export type DiscoveryOutcome =
	| { ok: true; tool: FleetPortDiscoveryTool; listeners: RawListener[] }
	| { ok: false; reason: 'missing' | 'failed'; tool: FleetPortDiscoveryTool; detail: string };

/** How long one discovery run may take. */
export const PORT_DISCOVERY_TIMEOUT_MS = 8_000;

/** The PowerShell script: listeners and their processes as one JSON array. */
export const WINDOWS_PORTS_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$ProgressPreference = 'SilentlyContinue'",
	'[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
	'$names = @{}',
	'foreach ($p in Get-Process) {',
	'  $path = $null',
	'  try { $path = $p.Path } catch {}',
	'  $names[[int]$p.Id] = @{ n = $p.ProcessName; path = $path }',
	'}',
	'$rows = @(Get-NetTCPConnection -State Listen | ForEach-Object {',
	'  $info = $names[[int]$_.OwningProcess]',
	'  [pscustomobject]@{ a = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; name = $info.n; path = $info.path }',
	'})',
	'ConvertTo-Json -InputObject $rows -Compress'
].join('\n');

/** `[::]:22` → `{ bind: '::', port: 22 }`; `127.0.0.53%lo:53` → `127.0.0.53`; `*:80` → `0.0.0.0`. */
export function splitHostPort(value: string): { bind: string; port: number } | null {
	const trimmed = value.trim();
	const colon = trimmed.lastIndexOf(':');
	if (colon <= 0) return null;
	const port = Number(trimmed.slice(colon + 1));
	if (!isFleetPortNumber(port)) return null;
	let bind = trimmed.slice(0, colon);
	if (bind.startsWith('[') && bind.endsWith(']')) bind = bind.slice(1, -1);
	const percent = bind.indexOf('%');
	if (percent >= 0) bind = bind.slice(0, percent);
	if (bind === '*' || bind === '') bind = '0.0.0.0';
	return { bind, port };
}

/**
 * `ss -tlnpH` / `ss -tlnH` lines:
 * `LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))`.
 * The fourth column is the local address; the process is the first
 * `("name",pid=N` of the `users:` column, when present.
 */
export function parseSsListeners(stdout: string): RawListener[] {
	const out: RawListener[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('State')) continue;
		const columns = trimmed.split(/\s+/);
		if (columns.length < 4) continue;
		const local = splitHostPort(columns[3]);
		if (!local) continue;
		const users = /users:\(\("([^"]{1,200})",pid=(\d{1,10})/.exec(trimmed);
		const pid = users ? Number(users[2]) : null;
		out.push({
			port: local.port,
			bind: local.bind,
			pid: pid !== null && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
			program: users ? users[1] : null
		});
	}
	return dedupe(out);
}

/** `lsof -F pcn` field output: `p4812` / `cnode` / `f21` / `n*:3000`. */
export function parseLsofListeners(stdout: string): RawListener[] {
	const out: RawListener[] = [];
	let pid: number | null = null;
	let program: string | null = null;
	for (const line of stdout.split(/\r?\n/)) {
		if (line.length < 2) continue;
		const field = line[0];
		const value = line.slice(1);
		if (field === 'p') {
			const parsed = Number(value);
			pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
			program = null;
		} else if (field === 'c') {
			program = value.slice(0, 200) || null;
		} else if (field === 'n') {
			// `n*:3000`, `n127.0.0.1:9000`, `n[::1]:5432`; a connected name has `->`.
			if (value.includes('->')) continue;
			const local = splitHostPort(value);
			if (local) out.push({ port: local.port, bind: local.bind, pid, program });
		}
	}
	return dedupe(out);
}

/** {@link WINDOWS_PORTS_SCRIPT}'s JSON: an array (or, from an older PowerShell, a single object). */
export function parseWindowsListeners(stdout: string): RawListener[] {
	const text = stdout.trim();
	if (text.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const out: RawListener[] = [];
	for (const row of rows) {
		if (typeof row !== 'object' || row === null) continue;
		const record = row as Record<string, unknown>;
		const port = Number(record.port);
		if (!isFleetPortNumber(port)) continue;
		const bindRaw = typeof record.a === 'string' ? record.a.trim() : '';
		const bind = bindRaw.length === 0 ? '0.0.0.0' : bindRaw.split('%')[0];
		const pid = Number(record.pid);
		out.push({
			port,
			bind,
			// PID 0 / 4 are the kernel ("Idle", "System"): a real number, kept, never a person's program.
			pid: Number.isSafeInteger(pid) && pid >= 0 ? pid : null,
			program: typeof record.name === 'string' && record.name.length > 0 ? record.name.slice(0, 200) : null,
			path: typeof record.path === 'string' && record.path.length > 0 ? record.path.slice(0, 1024) : null
		});
	}
	return dedupe(out);
}

/** One row per (bind, port): `ss` lists a socket once per process that shares it. */
function dedupe(listeners: RawListener[]): RawListener[] {
	const seen = new Map<string, RawListener>();
	for (const listener of listeners) {
		const key = `${listener.bind}|${listener.port}`;
		const existing = seen.get(key);
		if (!existing) seen.set(key, listener);
		else if (existing.pid === null && listener.pid !== null) seen.set(key, listener);
	}
	return [...seen.values()];
}

function isMissing(result: { code: number | null; spawnError?: string; stderr: string }): boolean {
	if (result.spawnError === 'ENOENT') return true;
	// A shell that could not find the command answers 127 (POSIX) or 9009 (cmd.exe).
	return result.code === 127 || result.code === 9009 || /not (?:found|recognized)/i.test(result.stderr);
}

function firstLine(text: string): string {
	return (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '').trim().slice(0, 300);
}

/** Read the machine's listeners with its platform's tool. Never throws. */
export async function discoverListeners(runner: CommandRunner, platform: string): Promise<DiscoveryOutcome> {
	const options = { timeoutMs: PORT_DISCOVERY_TIMEOUT_MS };
	try {
		if (platform === 'win32') {
			const result = await runner.run(
				'powershell',
				['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_PORTS_SCRIPT)],
				options
			);
			if (isMissing(result)) {
				return { ok: false, reason: 'missing', tool: 'powershell', detail: 'PowerShell was not found' };
			}
			if (result.code !== 0 || result.timedOut) {
				return {
					ok: false,
					reason: 'failed',
					tool: 'powershell',
					detail: `Get-NetTCPConnection exited ${result.code ?? 'early'}: "${firstLine(result.stderr)}"`
				};
			}
			return { ok: true, tool: 'powershell', listeners: parseWindowsListeners(result.stdout) };
		}
		if (platform === 'darwin') {
			const result = await runner.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], options);
			if (isMissing(result)) return { ok: false, reason: 'missing', tool: 'lsof', detail: 'lsof was not found' };
			// lsof exits 1 when nothing matched: an empty list, not a failure.
			if ((result.code !== 0 && result.code !== 1) || result.timedOut) {
				return {
					ok: false,
					reason: 'failed',
					tool: 'lsof',
					detail: `lsof exited ${result.code ?? 'early'}: "${firstLine(result.stderr)}"`
				};
			}
			return { ok: true, tool: 'lsof', listeners: parseLsofListeners(result.stdout) };
		}
		const withProcesses = await runner.run('ss', ['-tlnpH'], options);
		if (isMissing(withProcesses)) return { ok: false, reason: 'missing', tool: 'ss', detail: 'ss was not found' };
		if (withProcesses.code === 0 && !withProcesses.timedOut) {
			return { ok: true, tool: 'ss', listeners: parseSsListeners(withProcesses.stdout) };
		}
		// `-p` refused (an old `ss`, a hardened kernel): the listeners without their processes.
		const without = await runner.run('ss', ['-tlnH'], options);
		if (without.code === 0 && !without.timedOut) {
			return { ok: true, tool: 'ss', listeners: parseSsListeners(without.stdout) };
		}
		return {
			ok: false,
			reason: 'failed',
			tool: 'ss',
			detail: `ss exited ${without.code ?? 'early'}: "${firstLine(without.stderr || withProcesses.stderr)}"`
		};
	} catch (error) {
		const tool: FleetPortDiscoveryTool = platform === 'win32' ? 'powershell' : platform === 'darwin' ? 'lsof' : 'ss';
		return { ok: false, reason: 'failed', tool, detail: error instanceof Error ? error.message : String(error) };
	}
}

/** The sentence a missing discovery tool is reported with (spec U5). */
export function discoveryToolMissingHint(tool: FleetPortDiscoveryTool, nodeName: string): string {
	switch (tool) {
		case 'lsof':
			return `lsof is missing on ${nodeName} — it ships with macOS; reinstall the command line tools there`;
		case 'powershell':
			return `PowerShell is missing on ${nodeName} — the node needs it to list ports on Windows`;
		case 'ss':
		default:
			return `Install iproute2 (\`ss\`) on ${nodeName} to list its ports`;
	}
}
