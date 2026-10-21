import {
	FLEET_HEALTH_PROBE_TIMEOUT_MS,
	sanitizeFleetNodeHealthSnapshot,
	type FleetNodeGpuHealth,
	type FleetNodeHealthSnapshot
} from '@ever-works/contracts';
import type { CommandRunner } from './capabilities';
import {
	classifyGpuVendor,
	detectGpuWithEvidence,
	IOREG_GPU_ARGS,
	NVIDIA_SMI_HEALTH_ARGS,
	parseIoregGpuUtil,
	parseNvidiaSmiHealth,
	parseRocmSmiHealth,
	ROCM_SMI_HEALTH_ARGS,
	type GpuInfo
} from './gpu-probe';
import type { ResourceProbe } from './resource-limits';
import type { DiskProbeIo, DiskVolumeReading } from './telemetry-probe';
import { nearestExistingPath } from './workspaces/disk-headroom';

/**
 * Computer health (FL-03) — the snapshot every heartbeat carries.
 *
 * Before this the node reported that it was alive, what its worker was
 * doing and how much disk was left. It already SAMPLED CPU and memory —
 * for its own admission gate (`resource-limits.ts`) — and never said what
 * it saw. This module reports those readings, and the handful of other
 * facts an owner asks about a machine: how full the disk is, the load,
 * how long it has been up, the GPU, whether it is waiting for a reboot,
 * how many services have failed.
 *
 * ## The rules (each one tested)
 *
 *  1. **Report, never obey.** The snapshot goes up; nothing comes back down
 *     and nothing here changes what the node does.
 *  2. **A probe never fails the beat.** Every fact is its own probe, all run
 *     at once, each with a {@link FLEET_HEALTH_PROBE_TIMEOUT_MS} budget. A
 *     fact that throws, exits non-zero, cannot be parsed or misses its
 *     budget is ABSENT for that beat. The worst case is a beat with no
 *     snapshot at all — never a beat that is late or missing.
 *  3. **Absent is not zero, and nothing is inferred.** A fact that does not
 *     exist on an operating system is absent there, not guessed: no load
 *     average on Windows (it always reads 0), no pending-reboot or
 *     failed-service count on macOS (neither is cheaply and honestly
 *     knowable). Every number passes the shared sanitiser before it leaves.
 *  4. **Slow facts run off the beat.** Pending reboot, failed services and
 *     the GPU's identity change rarely and can cost a second or more to
 *     ask (a PowerShell start, a package-database read). They are cached
 *     for a few minutes and refreshed in the background with a longer
 *     deadline; a beat waits for them only up to its own budget, so a
 *     refresh that runs long lands on the NEXT beat instead of delaying
 *     this one.
 *  5. **No names cross the wire.** No hostname, user, address or process
 *     name is collected; the GPU model string is bounded and stripped.
 */

/** Host facts read from the runtime itself (`node:os` in production, fakes in tests). */
export interface HostFacts {
	/** The one-minute load average as the OS reports it (Windows reports 0). */
	loadAvg1(): number | null;
	/** Seconds since boot. */
	uptimeSec(): number | null;
	/** Logical cores available to this process. */
	cores(): number | null;
}

/** Everything the health probe touches, injected so every OS branch runs in a test. */
export interface HealthProbeIo {
	/** `process.platform` — linux / darwin / win32 / … */
	platform: string;
	runner: CommandRunner;
	/**
	 * CPU and memory — an instance of the admission gate's own sampler
	 * (`createResourceProbe`), so there is one way the node measures load.
	 * Its own instance: a shared one would split each delta with the gate.
	 */
	resourceProbe: ResourceProbe;
	host: HostFacts;
	/** The workspace volume. Without `volume`, the snapshot carries no disk figures. */
	disk?: DiskProbeIo;
	/** Does this path exist (the pending-reboot marker files)? */
	pathExists(path: string): Promise<boolean>;
}

export interface HealthProbeOptions {
	/** Path whose volume the disk figures describe — the node's workspace root. */
	workspacePath: string;
	/** Per-fact budget. Defaults to {@link FLEET_HEALTH_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** How long a slow fact's answer is reused. Defaults to 5 minutes. */
	slowFactTtlMs?: number;
	/** Deadline for one background refresh of a slow fact. Defaults to 15 s. */
	slowFactDeadlineMs?: number;
	/** Injectable clock for the slow-fact caches. */
	now?: () => number;
}

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_SLOW_FACT_TTL_MS = 5 * 60_000;
const DEFAULT_SLOW_FACT_DEADLINE_MS = 15_000;
/** The GPU's identity changes when someone opens the case. */
const GPU_IDENTITY_TTL_MS = 10 * 60_000;

/** `linux` marker files Debian / Ubuntu write when an update needs a reboot. */
export const LINUX_REBOOT_REQUIRED_PATH = '/var/run/reboot-required';
/** Present on the Debian family, where the marker file above is the authority. */
export const LINUX_DEBIAN_RELEASE_PATH = '/etc/debian_version';

/**
 * What `needs-restarting -r` prints when it exits 1 because a reboot IS
 * needed ("Reboot is required to fully utilize these updates." / "… to
 * ensure that your system benefits from these updates."). Exit 1 without it
 * is a failure, not an answer.
 */
export const NEEDS_RESTARTING_REBOOT_PATTERN = /reboot is required/i;

/**
 * The Windows facts in one PowerShell start (they are slow to start, so one
 * spawn answers all three): whether a reboot is pending (the two registry
 * keys servicing and Windows Update set), how many automatic services are
 * stopped with a failure exit code (1077 = "never started since boot" is a
 * delayed service that simply has not run yet, not a failure), and the
 * first display adapter's name. Each line is printed only when its query
 * succeeded, so a missing line is "could not ask", never a zero.
 *
 * Sent with `-EncodedCommand` because the node's runner spawns through the
 * Windows shell, which would otherwise split the script at its pipes.
 */
export const WINDOWS_HEALTH_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	'try {',
	"  $pending = (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')",
	'  "reboot=$pending"',
	'} catch {}',
	'try {',
	"  $failed = @(Get-CimInstance -ClassName Win32_Service -Filter \"StartMode='Auto' AND State='Stopped' AND ExitCode<>0 AND ExitCode<>1077\")",
	'  "failed=$($failed.Count)"',
	'} catch {}',
	'try {',
	'  $adapters = @(Get-CimInstance -ClassName Win32_VideoController)',
	'  "adapters=$($adapters.Count)"',
	'  foreach ($adapter in $adapters) { "gpu=$($adapter.Name)" }',
	'} catch {}'
].join('\n');

/** `powershell -EncodedCommand` takes the script as UTF-16LE base64. */
export function encodePowerShell(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64');
}

interface WindowsFacts {
	pendingReboot?: boolean;
	failedServices?: number;
	/** Adapter query answered: `[]` = none listed, else the adapters' names in order. */
	adapters?: string[];
}

/** Parse {@link WINDOWS_HEALTH_SCRIPT}'s `key=value` lines. */
export function parseWindowsHealth(stdout: string): WindowsFacts {
	const facts: WindowsFacts = {};
	let adapterCount: number | null = null;
	const names: string[] = [];
	for (const raw of (stdout ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const key = line.slice(0, eq);
		const value = line.slice(eq + 1).trim();
		if (key === 'reboot' && /^(true|false)$/i.test(value)) facts.pendingReboot = /^true$/i.test(value);
		if (key === 'failed' && /^\d+$/.test(value)) facts.failedServices = Number(value);
		if (key === 'adapters' && /^\d+$/.test(value)) adapterCount = Number(value);
		if (key === 'gpu' && value) names.push(value);
	}
	if (adapterCount !== null) facts.adapters = adapterCount > 0 ? names : [];
	return facts;
}

/** Count `systemctl list-units --state=failed --no-legend --plain` rows. */
export function countSystemdFailedUnits(stdout: string): number {
	return (stdout ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * A slow fact's cache that never makes a beat wait for a REFRESH (rule 4).
 *
 * The first read waits for the probe (bounded by the caller's per-fact
 * deadline; a probe still running then lands on a later beat). Once a value
 * is in hand, an expired read serves it at once and starts one refresh in the
 * background; the refresh's answer — `null` ("could not ask") included —
 * replaces it when it lands. So a slow tool (`needs-restarting` on RHEL, a
 * cold PowerShell + CIM start, `system_profiler`) costs the beat nothing at
 * expiry, and the fact never blinks to "—" every TTL. One refresh at a time;
 * a probe that throws answers `null`.
 *
 * Unlike `cacheProbe` (model identity), which makes the reader wait at every
 * expiry, because there a stale answer would be the wrong account.
 */
export function refreshInBackground<T>(
	probe: () => Promise<T | null>,
	ttlMs: number,
	now: () => number = Date.now
): () => Promise<T | null> {
	let value: T | null = null;
	let answered = false;
	let expiresAt = Number.NEGATIVE_INFINITY;
	let inFlight: Promise<T | null> | null = null;
	const refresh = (): Promise<T | null> => {
		if (!inFlight) {
			inFlight = Promise.resolve()
				.then(probe)
				.catch(() => null)
				.then((fresh) => {
					value = fresh;
					answered = true;
					expiresAt = now() + ttlMs;
					return fresh;
				})
				.finally(() => {
					inFlight = null;
				});
		}
		return inFlight;
	};
	return async () => {
		if (now() < expiresAt) return value;
		const pending = refresh();
		return answered ? value : pending;
	};
}

/**
 * Resolve to the promise's value, or `undefined` once `ms` have passed or it
 * rejected. The timer never keeps the process alive.
 */
export function withDeadline<T>(work: () => Promise<T> | T, ms: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(undefined);
		}, ms);
		(timer as { unref?: () => void }).unref?.();
		const finish = (value: T | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		try {
			Promise.resolve(work()).then(finish, () => finish(undefined));
		} catch {
			finish(undefined);
		}
	});
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Build the per-beat health probe. Call once per process (the slow-fact
 * caches live in the closure) and invoke the result on every beat.
 *
 * Resolves to the sanitised snapshot, or null when no fact answered.
 * Never rejects.
 */
export function createHealthProbe(
	io: HealthProbeIo,
	options: HealthProbeOptions
): () => Promise<FleetNodeHealthSnapshot | null> {
	const budget = options.timeoutMs ?? FLEET_HEALTH_PROBE_TIMEOUT_MS;
	const slowTtl = options.slowFactTtlMs ?? DEFAULT_SLOW_FACT_TTL_MS;
	const slowDeadline = options.slowFactDeadlineMs ?? DEFAULT_SLOW_FACT_DEADLINE_MS;
	const now = options.now ?? Date.now;
	// A runner that throws (a tool that cannot be spawned) answers null, so a
	// slow fact's cache records "could not ask" instead of re-spawning each beat.
	const run = async (command: string, args: readonly string[], timeoutMs: number) => {
		try {
			return await io.runner.run(command, [...args], { timeoutMs });
		} catch {
			return null;
		}
	};

	const cpuAndMemory = async (): Promise<FleetNodeHealthSnapshot> => {
		const sample = await io.resourceProbe.sample();
		const out: FleetNodeHealthSnapshot = {};
		const cpu = finiteOrNull(sample.cpuPercent);
		if (cpu !== null) out.cpuPercent = cpu;
		const total = finiteOrNull(sample.totalMemoryMb);
		const used = finiteOrNull(sample.usedMemoryMb);
		if (total !== null && total > 0) {
			out.memTotalMiB = Math.floor(total);
			if (used !== null && used >= 0) {
				out.memUsedMiB = Math.round(used);
				out.memPercent = (used / total) * 100;
			}
		}
		return out;
	};

	const disk = async (): Promise<FleetNodeHealthSnapshot> => {
		const probe = io.disk;
		if (!probe?.volume) return {};
		const target = await nearestExistingPath(options.workspacePath);
		if (!target) return {};
		const reading: DiskVolumeReading | null = await probe.volume(target);
		if (!reading) return {};
		const used = Math.max(reading.totalBytes - reading.freeBytes, 0);
		const denominator = used + reading.availableBytes;
		const out: FleetNodeHealthSnapshot = {
			diskFreeMiB: Math.floor(reading.availableBytes / BYTES_PER_MIB),
			diskTotalMiB: Math.floor(reading.totalBytes / BYTES_PER_MIB)
		};
		if (denominator > 0) out.diskPercent = (used / denominator) * 100;
		return out;
	};

	const hostFacts = (): FleetNodeHealthSnapshot => {
		const out: FleetNodeHealthSnapshot = {};
		const cores = finiteOrNull(io.host.cores());
		if (cores !== null) out.cpuCores = cores;
		const uptime = finiteOrNull(io.host.uptimeSec());
		if (uptime !== null) out.uptimeSec = uptime;
		// Windows always answers [0, 0, 0]: a number, and a lie (rule 3).
		if (io.platform !== 'win32') {
			const load = finiteOrNull(io.host.loadAvg1());
			if (load !== null) out.loadAvg1 = load;
		}
		return out;
	};

	// ── Slow facts, cached and refreshed off the beat (rule 4) ──

	const windowsFacts = refreshInBackground<WindowsFacts>(
		async () => {
			const result = await run(
				'powershell',
				['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(WINDOWS_HEALTH_SCRIPT)],
				slowDeadline
			);
			return result && result.code === 0 && !result.timedOut ? parseWindowsHealth(result.stdout) : null;
		},
		slowTtl,
		now
	);

	const linuxPendingReboot = refreshInBackground<boolean>(
		async () => {
			if (await io.pathExists(LINUX_REBOOT_REQUIRED_PATH)) return true;
			// On the Debian family the marker IS the authority: no marker, no reboot.
			if (await io.pathExists(LINUX_DEBIAN_RELEASE_PATH)) return false;
			// The RHEL family: `needs-restarting -r` exits 1 when a reboot is needed
			// and SAYS so. Exit 1 alone is not enough: a runner reports a tool that
			// is not installed (Alpine, Arch, openSUSE, minimal images) as exit 1
			// too, and "not installed" is "could not ask", never "reboot needed".
			const result = await run('needs-restarting', ['-r'], slowDeadline);
			if (!result || result.timedOut || result.spawnError) return null;
			if (result.code === 0) return false;
			if (result.code === 1 && NEEDS_RESTARTING_REBOOT_PATTERN.test(result.stdout)) return true;
			return null;
		},
		slowTtl,
		now
	);

	const linuxFailedServices = refreshInBackground<number>(
		async () => {
			const result = await run(
				'systemctl',
				['list-units', '--state=failed', '--no-legend', '--plain', '--no-pager'],
				slowDeadline
			);
			// Non-zero covers "no systemctl" and "not booted with systemd" alike.
			return result && result.code === 0 && !result.timedOut ? countSystemdFailedUnits(result.stdout) : null;
		},
		slowTtl,
		now
	);

	const gpuIdentity = refreshInBackground<{ gpu: GpuInfo | null; answered: boolean }>(
		() => detectGpuWithEvidence(io.runner, io.platform),
		GPU_IDENTITY_TTL_MS,
		now
	);

	const pendingRebootAndServices = async (): Promise<FleetNodeHealthSnapshot> => {
		const out: FleetNodeHealthSnapshot = {};
		if (io.platform === 'win32') {
			const facts = await windowsFacts();
			if (facts?.pendingReboot !== undefined) out.pendingReboot = facts.pendingReboot;
			if (facts?.failedServices !== undefined) out.failedServices = facts.failedServices;
			return out;
		}
		if (io.platform === 'linux') {
			const [reboot, failed] = await Promise.all([
				withDeadline(linuxPendingReboot, budget),
				withDeadline(linuxFailedServices, budget)
			]);
			if (typeof reboot === 'boolean') out.pendingReboot = reboot;
			if (typeof failed === 'number') out.failedServices = failed;
		}
		// macOS: neither fact is exposed cheaply and honestly (rule 3).
		return out;
	};

	const gpu = async (): Promise<FleetNodeHealthSnapshot> => {
		// One spawn answers an NVIDIA card's name, utilisation and memory, on
		// every OS — and is fresh every beat, because utilisation is live.
		const nvidia = await run('nvidia-smi', NVIDIA_SMI_HEALTH_ARGS, budget);
		if (nvidia && nvidia.code === 0 && !nvidia.timedOut) {
			const parsed = parseNvidiaSmiHealth(nvidia.stdout);
			if (parsed.length > 0) return { gpu: parsed.map((gpu) => ({ vendor: 'nvidia' as const, ...gpu })) };
		}
		// No NVIDIA driver answered — fall through to the identity probes.

		if (io.platform === 'win32') {
			const facts = await windowsFacts();
			if (!facts || facts.adapters === undefined) return {};
			if (facts.adapters.length === 0) return { gpu: null };
			return { gpu: facts.adapters.map((name) => ({ vendor: classifyGpuVendor(name), name })) };
		}

		const identity = await gpuIdentity();
		if (!identity) return {};
		if (!identity.gpu) return identity.answered ? { gpu: null } : {};
		const found: FleetNodeGpuHealth = { vendor: identity.gpu.vendor, name: identity.gpu.model };
		if (identity.gpu.vendor === 'amd' && io.platform === 'linux') {
			const rocm = await run('rocm-smi', ROCM_SMI_HEALTH_ARGS, budget);
			const usage = rocm && rocm.code === 0 && !rocm.timedOut ? parseRocmSmiHealth(rocm.stdout) : null;
			if (usage) Object.assign(found, usage);
		}
		if (identity.gpu.vendor === 'apple' && io.platform === 'darwin') {
			const ioreg = await run('ioreg', IOREG_GPU_ARGS, budget);
			const util = ioreg && ioreg.code === 0 && !ioreg.timedOut ? parseIoregGpuUtil(ioreg.stdout) : null;
			if (util !== null) found.utilPercent = util;
		}
		return { gpu: [found] };
	};

	return async () => {
		try {
			const parts = await Promise.all([
				withDeadline(cpuAndMemory, budget),
				withDeadline(disk, budget),
				withDeadline(hostFacts, budget),
				withDeadline(pendingRebootAndServices, budget),
				withDeadline(gpu, budget)
			]);
			const merged: FleetNodeHealthSnapshot = {};
			for (const part of parts) {
				if (part) Object.assign(merged, part);
			}
			return sanitizeFleetNodeHealthSnapshot(merged);
		} catch {
			return null;
		}
	};
}
