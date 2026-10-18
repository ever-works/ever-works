import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner, CommandRunOptions } from './capabilities';
import {
	countSystemdFailedUnits,
	createHealthProbe,
	encodePowerShell,
	LINUX_DEBIAN_RELEASE_PATH,
	LINUX_REBOOT_REQUIRED_PATH,
	parseWindowsHealth,
	refreshInBackground,
	WINDOWS_HEALTH_SCRIPT,
	withDeadline,
	type HealthProbeIo
} from './health-probe';
import type { DiskVolumeReading } from './telemetry-probe';

/**
 * Computer health (FL-03) — the per-beat snapshot.
 *
 * Every OS branch runs here against fake IO; nothing reads this host's real
 * numbers. The rules under test are the module's: every fact is its own
 * probe with its own budget, a fact that fails is ABSENT (never zero, never
 * guessed), and nothing ever rejects.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

type Answer = { code: number | null; stdout?: string; stderr?: string; timedOut?: boolean; spawnError?: string };
type Handler = (args: string[], options?: CommandRunOptions) => Answer | Promise<Answer>;

interface Call {
	command: string;
	args: string[];
	options?: CommandRunOptions;
}

/**
 * Runner that answers the commands it is given and "not found"s the rest
 * EXACTLY as the real `execFile` runner does (`node-io.ts`): it resolves,
 * with exit code 1 and `spawnError: 'ENOENT'` — it never throws. A fake
 * that threw here is how "tool missing" once read as "reboot needed".
 */
function runnerFor(handlers: Record<string, Handler>): CommandRunner & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		run: async (command, args, options) => {
			calls.push({ command, args, options });
			const handler = handlers[command];
			if (!handler) return { code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' };
			const answer = await handler(args, options);
			return { stdout: '', stderr: '', ...answer };
		}
	};
}

function io(overrides: Partial<HealthProbeIo> & { runner: CommandRunner; platform: string }): HealthProbeIo {
	const volume: DiskVolumeReading = { totalBytes: 200 * GIB, freeBytes: 125 * GIB, availableBytes: 118 * GIB };
	return {
		resourceProbe: { sample: () => ({ cpuPercent: 31.25, usedMemoryMb: 9523, totalMemoryMb: 16384 }) },
		host: { loadAvg1: () => 1.934, uptimeSec: () => 273600.4, cores: () => 4 },
		disk: { freeBytes: () => volume.availableBytes, volume: () => volume },
		pathExists: async () => false,
		...overrides
	};
}

const WORKSPACE = tmpdir();

const NVIDIA_TWO = 'NVIDIA GeForce RTX 4070, 12, 2048, 8188\nNVIDIA RTX A2000, 0, 5, 6138\n';

afterEach(() => {
	vi.useRealTimers();
});

describe('createHealthProbe — Linux', () => {
	it('reports every fact, from the admission sampler, statfs, os and the vendor tools', async () => {
		const runner = runnerFor({
			'nvidia-smi': () => ({ code: 0, stdout: NVIDIA_TWO }),
			systemctl: () => ({
				code: 0,
				stdout: 'nginx.service loaded failed failed nginx\nfoo.service loaded failed failed foo\n'
			})
		});
		const probe = createHealthProbe(
			io({ platform: 'linux', runner, pathExists: async (path) => path === LINUX_REBOOT_REQUIRED_PATH }),
			{ workspacePath: WORKSPACE }
		);

		expect(await probe()).toEqual({
			cpuPercent: 31.3,
			memPercent: 58.1,
			memTotalMiB: 16384,
			memUsedMiB: 9523,
			// df-style: used (200 - 125) over used + available (75 + 118).
			diskPercent: 38.9,
			diskFreeMiB: 118 * 1024,
			diskTotalMiB: 200 * 1024,
			loadAvg1: 1.93,
			cpuCores: 4,
			uptimeSec: 273600,
			gpu: [
				{
					vendor: 'nvidia',
					name: 'NVIDIA GeForce RTX 4070',
					utilPercent: 12,
					memUsedMiB: 2048,
					memTotalMiB: 8188
				},
				{ vendor: 'nvidia', name: 'NVIDIA RTX A2000', utilPercent: 0, memUsedMiB: 5, memTotalMiB: 6138 }
			],
			pendingReboot: true,
			failedServices: 2
		});
	});

	it('passes the per-fact budget to the runner as the kill deadline', async () => {
		const runner = runnerFor({
			'nvidia-smi': () => ({ code: 0, stdout: NVIDIA_TWO }),
			systemctl: () => ({ code: 0 })
		});
		await createHealthProbe(io({ platform: 'linux', runner }), { workspacePath: WORKSPACE, timeoutMs: 1500 })();
		expect(runner.calls.find((call) => call.command === 'nvidia-smi')?.options).toEqual({ timeoutMs: 1500 });
		// Slow facts run with their own, longer, background deadline.
		expect(runner.calls.find((call) => call.command === 'systemctl')?.options).toEqual({ timeoutMs: 15_000 });
	});

	it('on the Debian family the reboot marker is the authority: no marker, no reboot', async () => {
		const runner = runnerFor({ systemctl: () => ({ code: 0 }) });
		const snapshot = await createHealthProbe(
			io({ platform: 'linux', runner, pathExists: async (path) => path === LINUX_DEBIAN_RELEASE_PATH }),
			{ workspacePath: WORKSPACE }
		)();
		expect(snapshot?.pendingReboot).toBe(false);
		expect(runner.calls.some((call) => call.command === 'needs-restarting')).toBe(false);
	});

	const REBOOT_REQUIRED = [
		'Core libraries or services have been updated since boot-up:',
		'  * kernel',
		'',
		'Reboot is required to fully utilize these updates.',
		''
	].join('\n');
	const NO_REBOOT = [
		'No core libraries or services have been updated since boot-up.',
		'Reboot should not be necessary.',
		''
	].join('\n');

	it.each([
		[1, REBOOT_REQUIRED, true],
		[0, NO_REBOOT, false],
		[2, '', undefined],
		// Exit 1 WITHOUT the sentence is a failure of the tool, not its answer.
		[1, '', undefined]
	])('elsewhere `needs-restarting -r` exiting %s (%j) reads as pendingReboot %s', async (code, stdout, expected) => {
		const runner = runnerFor({ 'needs-restarting': () => ({ code, stdout }), systemctl: () => ({ code: 0 }) });
		const snapshot = await createHealthProbe(io({ platform: 'linux', runner }), { workspacePath: WORKSPACE })();
		expect(snapshot?.pendingReboot).toBe(expected);
	});

	it('a needs-restarting that is not installed is "could not ask" — never "reboot needed" (Alpine, Arch, minimal images)', async () => {
		// What the real runner resolves for ENOENT: exit 1 and the spawn error.
		const runner = runnerFor({ systemctl: () => ({ code: 0 }) });
		const snapshot = await createHealthProbe(io({ platform: 'linux', runner }), { workspacePath: WORKSPACE })();
		expect(runner.calls.some((call) => call.command === 'needs-restarting')).toBe(true);
		expect(snapshot).not.toHaveProperty('pendingReboot');
		// Even with the sentence on stdout, a spawn error is not an answer.
		const odd = runnerFor({
			'needs-restarting': () => ({ code: 1, stdout: REBOOT_REQUIRED, spawnError: 'EACCES' }),
			systemctl: () => ({ code: 0 })
		});
		expect(
			await createHealthProbe(io({ platform: 'linux', runner: odd }), { workspacePath: WORKSPACE })()
		).not.toHaveProperty('pendingReboot');
	});

	it('a runner that throws (another runner shape) is "could not ask" too, and the beat still answers', async () => {
		const throwing: CommandRunner = {
			run: async (command) => {
				throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
			}
		};
		const snapshot = await createHealthProbe(io({ platform: 'linux', runner: throwing }), {
			workspacePath: WORKSPACE
		})();
		expect(snapshot).not.toHaveProperty('pendingReboot');
		expect(snapshot).not.toHaveProperty('failedServices');
		expect(snapshot?.cpuPercent).toBe(31.3);
	});

	it('leaves pending reboot and failed services ABSENT when neither tool exists — never false, never 0', async () => {
		const snapshot = await createHealthProbe(io({ platform: 'linux', runner: runnerFor({}) }), {
			workspacePath: WORKSPACE
		})();
		expect(snapshot).not.toHaveProperty('pendingReboot');
		expect(snapshot).not.toHaveProperty('failedServices');
		expect(snapshot?.cpuPercent).toBe(31.3);
	});

	it('reads a machine not booted with systemd as "could not ask", not as zero failures', async () => {
		const runner = runnerFor({ systemctl: () => ({ code: 1, stderr: 'System has not been booted with systemd' }) });
		expect(
			await createHealthProbe(io({ platform: 'linux', runner }), { workspacePath: WORKSPACE })()
		).not.toHaveProperty('failedServices');
	});

	it('an AMD card reports its use and VRAM through rocm-smi', async () => {
		const runner = runnerFor({
			lspci: () => ({ code: 0, stdout: '03:00.0 VGA compatible controller: AMD Radeon RX 6800\n' }),
			'rocm-smi': () => ({
				code: 0,
				stdout: JSON.stringify({
					card0: {
						'GPU use (%)': '7',
						'VRAM Total Memory (B)': String(16 * GIB),
						'VRAM Total Used Memory (B)': String(GIB)
					}
				})
			})
		});
		const snapshot = await createHealthProbe(io({ platform: 'linux', runner }), { workspacePath: WORKSPACE })();
		expect(snapshot?.gpu).toEqual([
			{
				vendor: 'amd',
				name: '03:00.0 VGA compatible controller: AMD Radeon RX 6800',
				utilPercent: 7,
				memUsedMiB: 1024,
				memTotalMiB: 16 * 1024
			}
		]);
	});

	it('says "no GPU" only when a listing tool ANSWERED without one; says nothing when it could not ask', async () => {
		const answered = runnerFor({ lspci: () => ({ code: 0, stdout: '00:1f.3 Audio device: Intel\n' }) });
		expect(
			(await createHealthProbe(io({ platform: 'linux', runner: answered }), { workspacePath: WORKSPACE })())?.gpu
		).toBeNull();
		const unknown = await createHealthProbe(io({ platform: 'linux', runner: runnerFor({}) }), {
			workspacePath: WORKSPACE
		})();
		expect(unknown).not.toHaveProperty('gpu');
	});
});

describe('createHealthProbe — Windows', () => {
	const windowsRunner = (stdout: string, code = 0) =>
		runnerFor({ powershell: () => ({ code, stdout }), 'nvidia-smi': () => ({ code: 9009 }) });

	it('asks pending reboot, failed services and the adapters in ONE encoded PowerShell start', async () => {
		const runner = windowsRunner('reboot=True\r\nfailed=2\r\nadapters=1\r\ngpu=Intel(R) UHD Graphics 630\r\n');
		const snapshot = await createHealthProbe(io({ platform: 'win32', runner }), { workspacePath: WORKSPACE })();

		expect(snapshot?.pendingReboot).toBe(true);
		expect(snapshot?.failedServices).toBe(2);
		expect(snapshot?.gpu).toEqual([{ vendor: 'intel', name: 'Intel(R) UHD Graphics 630' }]);
		const calls = runner.calls.filter((call) => call.command === 'powershell');
		// Memoised: the GPU and the services facts share the one start.
		expect(calls).toHaveLength(1);
		expect(calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
		// Nothing the Windows shell would split at — the script travels as base64 only.
		expect(calls[0].args[3]).toMatch(/^[A-Za-z0-9+/=]+$/);
		expect(Buffer.from(calls[0].args[3], 'base64').toString('utf16le')).toBe(WINDOWS_HEALTH_SCRIPT);
	});

	it('drops the load average Windows always reports as 0 — a number, and a lie', async () => {
		const runner = windowsRunner('reboot=False\nfailed=0\nadapters=0\n');
		const snapshot = await createHealthProbe(
			io({ platform: 'win32', runner, host: { loadAvg1: () => 0, uptimeSec: () => 60, cores: () => 8 } }),
			{ workspacePath: WORKSPACE }
		)();
		expect(snapshot).not.toHaveProperty('loadAvg1');
		expect(snapshot).toMatchObject({
			uptimeSec: 60,
			cpuCores: 8,
			pendingReboot: false,
			failedServices: 0,
			gpu: null
		});
	});

	it('a failed or empty PowerShell answer leaves those facts absent', async () => {
		const failed = await createHealthProbe(io({ platform: 'win32', runner: windowsRunner('', 1) }), {
			workspacePath: WORKSPACE
		})();
		expect(failed).not.toHaveProperty('pendingReboot');
		expect(failed).not.toHaveProperty('failedServices');
		expect(failed).not.toHaveProperty('gpu');
	});

	it('an NVIDIA card is read by nvidia-smi even on Windows, without waiting for PowerShell', async () => {
		const runner = runnerFor({
			'nvidia-smi': () => ({ code: 0, stdout: NVIDIA_TWO }),
			powershell: () => ({ code: 0 })
		});
		const snapshot = await createHealthProbe(io({ platform: 'win32', runner }), { workspacePath: WORKSPACE })();
		expect(snapshot?.gpu).toHaveLength(2);
	});
});

describe('createHealthProbe — macOS', () => {
	it('reads an Apple GPU’s utilisation from ioreg and reports no reboot or service facts', async () => {
		const runner = runnerFor({
			system_profiler: () => ({
				code: 0,
				stdout: 'Graphics/Displays:\n    Apple M2:\n      Chipset Model: Apple M2\n'
			}),
			ioreg: () => ({
				code: 0,
				stdout: '"PerformanceStatistics" = {"Device Utilization %"=12,"In use system memory"=1}'
			})
		});
		const snapshot = await createHealthProbe(io({ platform: 'darwin', runner }), { workspacePath: WORKSPACE })();
		expect(snapshot?.gpu).toEqual([{ vendor: 'apple', name: 'Apple M2', utilPercent: 12 }]);
		expect(snapshot).not.toHaveProperty('pendingReboot');
		expect(snapshot).not.toHaveProperty('failedServices');
		expect(snapshot?.loadAvg1).toBe(1.93);
		expect(runner.calls.some((call) => call.command === 'systemctl' || call.command === 'powershell')).toBe(false);
	});
});

describe('createHealthProbe — never fails the beat (FR-6)', () => {
	it('drops a fact that hangs past its 2 s budget and keeps every other (ACC-FL03-01)', async () => {
		vi.useFakeTimers();
		const runner = runnerFor({
			// nvidia-smi hangs for 3 s — longer than its budget.
			'nvidia-smi': () =>
				new Promise<Answer>((resolve) => setTimeout(() => resolve({ code: 0, stdout: NVIDIA_TWO }), 3_000)),
			systemctl: () => ({ code: 0, stdout: 'a.service\n' })
		});
		const pending = createHealthProbe(io({ platform: 'linux', runner }), { workspacePath: WORKSPACE })();
		await vi.advanceTimersByTimeAsync(2_000);
		const snapshot = await pending;
		expect(snapshot).not.toHaveProperty('gpu');
		expect(snapshot).toMatchObject({ cpuPercent: 31.3, failedServices: 1, cpuCores: 4 });
	});

	it('a slow fact that misses one beat lands on the next, without a second spawn', async () => {
		vi.useFakeTimers();
		let spawns = 0;
		const runner = runnerFor({
			systemctl: () => {
				spawns += 1;
				return new Promise<Answer>((resolve) =>
					setTimeout(() => resolve({ code: 0, stdout: 'a.service\nb.service\n' }), 5_000)
				);
			}
		});
		const probe = createHealthProbe(io({ platform: 'linux', runner }), { workspacePath: WORKSPACE });
		const first = probe();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await first).not.toHaveProperty('failedServices');
		await vi.advanceTimersByTimeAsync(3_000);
		expect((await probe())?.failedServices).toBe(2);
		expect(spawns).toBe(1);
	});

	it('re-asks a slow fact once its cache expires — serving the last answer while it does', async () => {
		let now = 0;
		let failed = 1;
		const runner = runnerFor({ systemctl: () => ({ code: 0, stdout: 'x\n'.repeat(failed) }) });
		const probe = createHealthProbe(io({ platform: 'linux', runner }), {
			workspacePath: WORKSPACE,
			now: () => now,
			slowFactTtlMs: 60_000
		});
		expect((await probe())?.failedServices).toBe(1);
		failed = 3;
		now = 30_000;
		expect((await probe())?.failedServices).toBe(1);
		now = 61_000;
		// Expired: this beat gets the answer in hand, and the refresh starts.
		expect((await probe())?.failedServices).toBe(1);
		// The refresh has landed by the next beat.
		expect((await probe())?.failedServices).toBe(3);
	});

	it('a slow refresh at expiry never blinks the fact to "—" (stale-while-revalidate)', async () => {
		vi.useFakeTimers();
		let now = 0;
		let calls = 0;
		const runner = runnerFor({
			systemctl: () => {
				calls += 1;
				// The first answer is quick; the refresh takes 10 s — longer than a beat's 2 s.
				const delay = calls === 1 ? 0 : 10_000;
				const stdout = calls === 1 ? 'a\n' : 'a\nb\n';
				return new Promise<Answer>((resolve) => setTimeout(() => resolve({ code: 0, stdout }), delay));
			}
		});
		const probe = createHealthProbe(io({ platform: 'linux', runner }), {
			workspacePath: WORKSPACE,
			now: () => now,
			slowFactTtlMs: 60_000
		});
		const first = probe();
		await vi.advanceTimersByTimeAsync(0);
		expect((await first)?.failedServices).toBe(1);
		now = 61_000;
		const atExpiry = probe();
		await vi.advanceTimersByTimeAsync(0);
		// Answered at once, with the last value — not after the 2 s budget, not absent.
		expect((await atExpiry)?.failedServices).toBe(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await probe())?.failedServices).toBe(2);
		expect(calls).toBe(2);
	});

	it('a sampler that throws costs CPU and memory only', async () => {
		const snapshot = await createHealthProbe(
			io({
				platform: 'linux',
				runner: runnerFor({}),
				resourceProbe: {
					sample: () => {
						throw new Error('os.cpus failed');
					}
				}
			}),
			{ workspacePath: WORKSPACE }
		)();
		expect(snapshot).not.toHaveProperty('cpuPercent');
		expect(snapshot).not.toHaveProperty('memPercent');
		expect(snapshot?.diskFreeMiB).toBe(118 * 1024);
	});

	it('answers null — never rejects — when no fact answers at all', async () => {
		const snapshot = await createHealthProbe(
			{
				platform: 'linux',
				runner: runnerFor({}),
				resourceProbe: { sample: () => Promise.reject(new Error('nope')) },
				host: { loadAvg1: () => Number.NaN, uptimeSec: () => null, cores: () => null },
				pathExists: () => Promise.reject(new Error('fs gone'))
			},
			{ workspacePath: WORKSPACE }
		)();
		expect(snapshot).toBeNull();
	});
});

describe('createHealthProbe — disk and memory figures', () => {
	it('measures the nearest existing ancestor of a workspace root that does not exist yet', async () => {
		const seen: string[] = [];
		const volume: DiskVolumeReading = { totalBytes: 100 * GIB, freeBytes: 10 * GIB, availableBytes: 10 * GIB };
		await createHealthProbe(
			io({
				platform: 'linux',
				runner: runnerFor({}),
				disk: {
					freeBytes: () => null,
					volume: (path) => {
						seen.push(path);
						return volume;
					}
				}
			}),
			{ workspacePath: join(WORKSPACE, 'fl03-not-created-yet', 'fleet-workspaces') }
		)();
		expect(seen).toEqual([WORKSPACE]);
	});

	it('reports no disk figures from a probe without a volume reading', async () => {
		const snapshot = await createHealthProbe(
			io({ platform: 'linux', runner: runnerFor({}), disk: { freeBytes: () => 5 * GIB } }),
			{ workspacePath: WORKSPACE }
		)();
		expect(snapshot).not.toHaveProperty('diskPercent');
		expect(snapshot).not.toHaveProperty('diskFreeMiB');
	});

	it('reports no memory percentage without a total to divide by', async () => {
		const snapshot = await createHealthProbe(
			io({
				platform: 'linux',
				runner: runnerFor({}),
				resourceProbe: { sample: () => ({ cpuPercent: 5, usedMemoryMb: 100, totalMemoryMb: 0 }) }
			}),
			{ workspacePath: WORKSPACE }
		)();
		expect(snapshot).not.toHaveProperty('memPercent');
		expect(snapshot).not.toHaveProperty('memUsedMiB');
		expect(snapshot?.cpuPercent).toBe(5);
	});
});

describe('parsers', () => {
	it('parseWindowsHealth reads only lines it trusts, and an adapter count of 0 as "no GPU"', () => {
		expect(parseWindowsHealth('reboot=True\nfailed=3\nadapters=2\ngpu=A\ngpu=B\n')).toEqual({
			pendingReboot: true,
			failedServices: 3,
			adapters: ['A', 'B']
		});
		expect(parseWindowsHealth('adapters=0\n')).toEqual({ adapters: [] });
		expect(parseWindowsHealth('reboot=maybe\nfailed=-1\nnoise\n')).toEqual({});
	});

	it('countSystemdFailedUnits counts rows, not blank lines', () => {
		expect(countSystemdFailedUnits('')).toBe(0);
		expect(countSystemdFailedUnits('a.service loaded failed\n\nb.service loaded failed\n')).toBe(2);
	});

	it('encodePowerShell is UTF-16LE base64, as -EncodedCommand expects', () => {
		expect(Buffer.from(encodePowerShell('"a|b"'), 'base64').toString('utf16le')).toBe('"a|b"');
	});

	it('withDeadline resolves undefined on a rejection or a throw, and the value otherwise', async () => {
		expect(await withDeadline(() => 4, 100)).toBe(4);
		expect(await withDeadline(() => Promise.reject(new Error('x')), 100)).toBeUndefined();
		expect(
			await withDeadline(() => {
				throw new Error('sync');
			}, 100)
		).toBeUndefined();
	});
});

describe('refreshInBackground', () => {
	it('waits for the first answer, then serves the cached one until it expires', async () => {
		let now = 0;
		const probe = vi.fn(async () => 'v1');
		const cached = refreshInBackground(probe, 1_000, () => now);
		expect(await cached()).toBe('v1');
		now = 999;
		expect(await cached()).toBe('v1');
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('at expiry answers the old value at once and refreshes once in the background', async () => {
		let now = 0;
		let release: (value: string) => void = () => undefined;
		const probe = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce('v1')
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						release = resolve;
					})
			);
		const cached = refreshInBackground(probe, 1_000, () => now);
		expect(await cached()).toBe('v1');
		now = 1_001;
		expect(await cached()).toBe('v1');
		expect(await cached()).toBe('v1');
		// Two expired reads, ONE refresh.
		expect(probe).toHaveBeenCalledTimes(2);
		release('v2');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await cached()).toBe('v2');
	});

	it('a refresh that answers null ("could not ask") replaces the value — the fact is absent, not stale', async () => {
		let now = 0;
		const probe = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce('v1').mockResolvedValueOnce(null);
		const cached = refreshInBackground(probe, 1_000, () => now);
		expect(await cached()).toBe('v1');
		now = 1_001;
		await cached();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await cached()).toBeNull();
	});

	it('a probe that throws answers null and never rejects', async () => {
		const cached = refreshInBackground<string>(async () => {
			throw new Error('boom');
		}, 1_000);
		await expect(cached()).resolves.toBeNull();
	});
});
