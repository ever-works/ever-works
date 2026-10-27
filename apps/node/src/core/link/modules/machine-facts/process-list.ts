import {
	FLEET_PROCESS_COMMAND_MAX,
	FLEET_PROCESS_LIST_MAX,
	redactSecrets,
	type FleetProcessSort,
	type FleetProcessView
} from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { firstLine } from './exec';
import { jsonScript, parseJsonList, POWERSHELL, powerShellArgs } from './powershell';

/**
 * Machine facts (FL-09, plan §3, spec FR-9, FR-10) — the busiest processes.
 *
 *  - Linux: `ps -eo pid=,ppid=,user:32=,%cpu=,rss=,etimes=,args=`;
 *  - macOS: `ps -axo pid=,ppid=,user=,%cpu=,rss=,etime=,args=` (no `etimes`);
 *  - Windows: one PowerShell script — two CPU samples a second apart (so the
 *    percentage is "now", not since start), memory, start time, parent and
 *    command line from CIM, the owner when the node is elevated.
 *
 * CPU is a percentage of ONE core. A command line is run through the shared
 * secret scanner BEFORE it is cut to 200 characters (a cut could split a
 * token the scanner would otherwise have caught) and only then leaves the
 * machine (FR-10).
 */

/** A process as parsed, before protection marks and the top-300 cut. */
export type ParsedProcess = Omit<FleetProcessView, 'protected'>;

/** The scanned, cut command line of FR-10. */
export function safeCommandLine(command: string): string {
	const cleaned = redactSecrets(command.replace(/[\r\n\t]+/g, ' ')).cleaned.trim();
	return cleaned.length > FLEET_PROCESS_COMMAND_MAX ? `${cleaned.slice(0, FLEET_PROCESS_COMMAND_MAX - 1)}…` : cleaned;
}

/** A process's short name from its command line: `[kthreadd]` → `kthreadd`, `/usr/bin/node x` → `node`. */
export function nameFromCommand(command: string): string {
	const trimmed = command.trim();
	const kernel = /^\[([^\]]+)\]$/.exec(trimmed);
	if (kernel) return kernel[1];
	const first = trimmed.split(/\s+/, 1)[0] ?? '';
	const base = first.split(/[\\/]/).pop() ?? first;
	return base.replace(/:$/, '') || trimmed.slice(0, 32);
}

/** `[[dd-]hh:]mm:ss` (BSD `etime`) → seconds. */
export function parseElapsed(value: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
	if (!match) return null;
	const [, days, hours, minutes, seconds] = match;
	return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** Parse Linux / macOS `ps` rows: PID PPID USER %CPU RSS(KiB) ELAPSED ARGS… */
export function parsePsRows(stdout: string, platform: string): ParsedProcess[] {
	const out: ParsedProcess[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const [, pid, ppid, user, cpu, rss, elapsed, args] = match;
		const runtimeSec =
			platform === 'darwin'
				? parseElapsed(elapsed)
				: /^\d+$/.test(elapsed)
					? Number(elapsed)
					: parseElapsed(elapsed);
		out.push({
			pid: Number(pid),
			ppid: Number(ppid) || null,
			name: nameFromCommand(args),
			cpuPercent: Math.max(0, Number(cpu.replace(',', '.')) || 0),
			memBytes: Number(rss) * 1024,
			owner: user,
			runtimeSec,
			command: safeCommandLine(args)
		});
	}
	return out;
}

const WINDOWS_SCRIPT = jsonScript(
	[
		'$first = @{}',
		'foreach ($p in Get-Process) { $first[$p.Id] = $p.CPU }',
		'Start-Sleep -Milliseconds 1000',
		'$cim = @{}',
		'foreach ($c in Get-CimInstance -ClassName Win32_Process) { $cim[[int]$c.ProcessId] = $c }',
		'$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
		'$procs = if ($admin) { Get-Process -IncludeUserName } else { Get-Process }',
		'$rows = foreach ($p in $procs) {',
		'  $before = $first[$p.Id]',
		'  $cpu = 0',
		'  if ($null -ne $before -and $null -ne $p.CPU) { $cpu = [math]::Round(($p.CPU - $before) * 100, 1) }',
		'  $c = $cim[[int]$p.Id]',
		'  $start = $null',
		'  try { if ($p.StartTime) { $start = $p.StartTime.ToUniversalTime().ToString("o") } } catch { }',
		'  [pscustomobject]@{',
		'    Id = $p.Id',
		'    ParentId = if ($c) { [int]$c.ParentProcessId } else { $null }',
		'    Name = $p.ProcessName',
		'    Cpu = $cpu',
		'    Mem = $p.WorkingSet64',
		'    User = if ($admin) { $p.UserName } else { $null }',
		'    Start = $start',
		'    CommandLine = if ($c) { $c.CommandLine } else { $null }',
		'  }',
		'}',
		'$rows | ConvertTo-Json -Compress -Depth 2'
	].join('\n')
);

export function parseWindowsProcesses(stdout: string, now: number = Date.now()): ParsedProcess[] {
	const out: ParsedProcess[] = [];
	for (const raw of parseJsonList(stdout)) {
		if (typeof raw.Id !== 'number' || raw.Id <= 0) continue;
		const name = typeof raw.Name === 'string' && raw.Name ? raw.Name : `pid ${raw.Id}`;
		const started = typeof raw.Start === 'string' ? Date.parse(raw.Start) : Number.NaN;
		const command = typeof raw.CommandLine === 'string' && raw.CommandLine.trim() ? raw.CommandLine : name;
		out.push({
			pid: raw.Id,
			ppid: typeof raw.ParentId === 'number' && raw.ParentId > 0 ? raw.ParentId : null,
			name,
			cpuPercent: typeof raw.Cpu === 'number' && raw.Cpu > 0 ? raw.Cpu : 0,
			memBytes: typeof raw.Mem === 'number' ? raw.Mem : null,
			owner: typeof raw.User === 'string' && raw.User ? raw.User : null,
			runtimeSec: Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 1000)) : null,
			command: safeCommandLine(command)
		});
	}
	return out;
}

/** Every process on the machine, unsorted, or the first line the tool printed when it failed. */
export async function readProcesses(
	runner: CommandRunner,
	platform: string
): Promise<{ processes: ParsedProcess[] } | { error: string }> {
	if (platform === 'win32') {
		const result = await runner.run(POWERSHELL, powerShellArgs(WINDOWS_SCRIPT), { timeoutMs: 20_000 });
		if (result.code !== 0) return { error: firstLine(result.stderr, `PowerShell exited ${result.code ?? 1}`) };
		return { processes: parseWindowsProcesses(result.stdout) };
	}
	const args =
		platform === 'darwin'
			? ['-axo', 'pid=,ppid=,user=,%cpu=,rss=,etime=,args=']
			: ['-eo', 'pid=,ppid=,user:32=,%cpu=,rss=,etimes=,args='];
	const result = await runner.run('ps', args, { timeoutMs: 10_000 });
	if (result.code !== 0 && !result.stdout)
		return { error: firstLine(result.stderr, `ps exited ${result.code ?? 1}`) };
	return { processes: parsePsRows(result.stdout, platform) };
}

/** Busiest first (CPU, then memory), or largest first by memory; at most `limit`. */
export function topProcesses(
	processes: readonly ParsedProcess[],
	sort: FleetProcessSort = 'cpu',
	limit: number = FLEET_PROCESS_LIST_MAX
): ParsedProcess[] {
	const byMem = (a: ParsedProcess, b: ParsedProcess) => (b.memBytes ?? 0) - (a.memBytes ?? 0);
	const sorted = [...processes].sort((a, b) =>
		sort === 'mem' ? byMem(a, b) || a.pid - b.pid : b.cpuPercent - a.cpuPercent || byMem(a, b) || a.pid - b.pid
	);
	return sorted.slice(0, Math.max(0, limit));
}

/** CPU and memory of a few pids (the Services tab's running rows), from one full read. */
export function statsByPid(
	processes: readonly ParsedProcess[]
): Map<number, { cpuPercent: number; memBytes: number | null }> {
	const out = new Map<number, { cpuPercent: number; memBytes: number | null }>();
	for (const process of processes)
		out.set(process.pid, { cpuPercent: process.cpuPercent, memBytes: process.memBytes });
	return out;
}
