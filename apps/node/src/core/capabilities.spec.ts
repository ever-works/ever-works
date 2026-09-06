import { describe, expect, it } from 'vitest';
import {
	describePlatform,
	describeSelf,
	detectCapabilities,
	detectDisplay,
	nodeMajor,
	normalizeCapabilities,
	readEnvironment,
	type CapabilityEnvironment,
	type CommandRunner
} from './capabilities';
import { MAX_CAPABILITY_TAG_LENGTH, MAX_CAPABILITY_TAGS } from './types';

/** Runner whose `--version` probes succeed only for the listed tools. */
function runnerWith(available: string[], failures: string[] = []): CommandRunner {
	return {
		run: async (command) => {
			if (failures.includes(command)) {
				throw new Error(`spawn ${command} ENOENT`);
			}
			return available.includes(command)
				? { code: 0, stdout: `${command} version 1.2.3`, stderr: '' }
				: { code: 127, stdout: '', stderr: 'not found' };
		}
	};
}

function environment(overrides: Partial<CapabilityEnvironment> = {}): CapabilityEnvironment {
	return { platform: 'linux', arch: 'x64', nodeVersion: 'v22.11.0', hasDisplay: false, ...overrides };
}

describe('nodeMajor / describePlatform', () => {
	it('parses the major from process.version shapes and rejects junk', () => {
		expect(nodeMajor('v22.11.0')).toBe(22);
		expect(nodeMajor('24.0.0')).toBe(24);
		expect(nodeMajor(' v20.1.0 ')).toBe(20);
		expect(nodeMajor('not-a-version')).toBeNull();
		expect(nodeMajor('')).toBeNull();
	});

	it('reports os/arch and stays inside the server platform cap', () => {
		expect(describePlatform(environment())).toBe('linux/x64');
		expect(describePlatform(environment({ platform: 'win32', arch: 'arm64' }))).toBe('win32/arm64');
		expect(describePlatform(environment({ platform: 'x'.repeat(200) })).length).toBeLessThanOrEqual(64);
	});
});

describe('detectDisplay', () => {
	it('assumes a display on Windows and macOS, and probes X11/Wayland elsewhere', () => {
		expect(detectDisplay('win32', {})).toBe(true);
		expect(detectDisplay('darwin', {})).toBe(true);
		expect(detectDisplay('linux', {})).toBe(false);
		expect(detectDisplay('linux', { DISPLAY: ':0' })).toBe(true);
		expect(detectDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
	});

	it('is wired through readEnvironment', () => {
		const env = readEnvironment({
			platform: 'linux',
			arch: 'arm64',
			version: 'v22.11.0',
			env: { DISPLAY: ':1' }
		});
		expect(env).toEqual({ platform: 'linux', arch: 'arm64', nodeVersion: 'v22.11.0', hasDisplay: true });
	});
});

describe('normalizeCapabilities (mirrors the server sanitizer)', () => {
	it('trims, drops empties, dedupes and preserves order', () => {
		expect(normalizeCapabilities([' docker ', 'git', 'docker', '', '   ', null, undefined, 'git'])).toEqual([
			'docker',
			'git'
		]);
	});

	it('truncates tags to 32 characters and caps the list at 16', () => {
		const long = 'x'.repeat(50);
		expect(normalizeCapabilities([long])[0]).toHaveLength(MAX_CAPABILITY_TAG_LENGTH);

		const many = Array.from({ length: 40 }, (_, index) => `tag-${index}`);
		expect(normalizeCapabilities(many)).toHaveLength(MAX_CAPABILITY_TAGS);
	});
});

describe('detectCapabilities matrix', () => {
	it('reports docker + git + display when everything is present', async () => {
		const tags = await detectCapabilities(
			runnerWith(['docker', 'git']),
			environment({ platform: 'darwin', arch: 'arm64', hasDisplay: true })
		);
		expect(tags).toEqual([
			'os:darwin',
			'arch:arm64',
			'node:22',
			'terminal',
			'workspace',
			'docker',
			'git',
			'display'
		]);
	});

	it('omits docker, git and display on a bare headless box', async () => {
		const tags = await detectCapabilities(runnerWith([]), environment());
		expect(tags).toEqual(['os:linux', 'arch:x64', 'node:22', 'terminal', 'workspace']);
		expect(tags).not.toContain('docker');
		expect(tags).not.toContain('git');
		expect(tags).not.toContain('display');
	});

	it('reports git without docker when only git is installed', async () => {
		const tags = await detectCapabilities(runnerWith(['git']), environment({ platform: 'win32' }));
		expect(tags).toContain('git');
		expect(tags).not.toContain('docker');
		expect(tags).toContain('os:win32');
	});

	it('treats a runner that throws (tool missing from PATH) as absent, not fatal', async () => {
		const tags = await detectCapabilities(runnerWith(['git'], ['docker']), environment());
		expect(tags).toContain('git');
		expect(tags).not.toContain('docker');
	});

	it('omits the node tag entirely when the version is unparseable', async () => {
		const tags = await detectCapabilities(runnerWith([]), environment({ nodeVersion: 'unknown' }));
		expect(tags.some((tag) => tag.startsWith('node:'))).toBe(false);
	});

	it('never exceeds the server capability caps', async () => {
		const tags = await detectCapabilities(
			runnerWith(['docker', 'git']),
			environment({ platform: 'darwin', hasDisplay: true })
		);
		expect(tags.length).toBeLessThanOrEqual(MAX_CAPABILITY_TAGS);
		for (const tag of tags) {
			expect(tag.length).toBeLessThanOrEqual(MAX_CAPABILITY_TAG_LENGTH);
		}
	});
});

describe('detectCapabilities — browser tag (audit A22/A26)', () => {
	it('advertises `browser` only when an executable was actually resolved', async () => {
		const withBrowser = await detectCapabilities(runnerWith([]), environment({ browserPath: '/usr/bin/chromium' }));
		expect(withBrowser).toContain('browser');

		// The tag is a promise the node has to be able to keep: without a
		// resolved binary there is nothing for `browser-check` to spawn.
		for (const absent of [null, undefined, '']) {
			const tags = await detectCapabilities(runnerWith([]), environment({ browserPath: absent }));
			expect(tags).not.toContain('browser');
		}
	});

	it('is independent of `display` — a headless box can still drive a headless browser', async () => {
		const tags = await detectCapabilities(
			runnerWith([]),
			environment({ hasDisplay: false, browserPath: '/usr/bin/chromium' })
		);
		expect(tags).toContain('browser');
		expect(tags).not.toContain('display');
	});
});

describe('detectCapabilities — gpu tag (audit A22)', () => {
	/** Runner that answers one GPU probe and 127s everything else. */
	function gpuRunner(command: string, stdout: string): CommandRunner {
		return {
			run: async (invoked) =>
				invoked === command ? { code: 0, stdout, stderr: '' } : { code: 127, stdout: '', stderr: 'not found' }
		};
	}

	it('reports `gpu` and the vendor when nvidia-smi answers', async () => {
		const tags = await detectCapabilities(gpuRunner('nvidia-smi', 'NVIDIA GeForce RTX 4090\n'), environment());
		expect(tags).toContain('gpu');
		expect(tags).toContain('gpu:nvidia');
	});

	it('classifies an AMD adapter from lspci on Linux', async () => {
		const lspci = [
			'00:1f.3 Audio device: Intel Corporation Cannon Lake PCH cAVS',
			'01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 21 [Radeon RX 6800]'
		].join('\n');
		const tags = await detectCapabilities(gpuRunner('lspci', lspci), environment());
		expect(tags).toContain('gpu:amd');
	});

	it('reports no gpu tags on a machine with no accelerator', async () => {
		const tags = await detectCapabilities(runnerWith([]), environment());
		expect(tags.some((tag) => tag.startsWith('gpu'))).toBe(false);
	});

	it('ignores lspci output with no display controller in it', async () => {
		const tags = await detectCapabilities(
			gpuRunner('lspci', '00:1f.3 Audio device: Intel Corporation Cannon Lake PCH cAVS'),
			environment()
		);
		expect(tags.some((tag) => tag.startsWith('gpu'))).toBe(false);
	});

	it('a probe that throws is a missing tag, never a failed heartbeat', async () => {
		const tags = await detectCapabilities(
			{
				run: async (command) => {
					if (command === 'nvidia-smi') throw new Error('spawn nvidia-smi ENOENT');
					if (command === 'git') return { code: 0, stdout: 'git version 2.43', stderr: '' };
					return { code: 127, stdout: '', stderr: '' };
				}
			},
			environment()
		);
		expect(tags).toContain('git');
		expect(tags.some((tag) => tag.startsWith('gpu'))).toBe(false);
	});

	it('stays inside the server capability caps with every tag present', async () => {
		const tags = await detectCapabilities(
			{
				run: async (command) => {
					if (command === 'nvidia-smi') {
						return { code: 0, stdout: 'NVIDIA RTX A6000', stderr: '' };
					}
					return ['docker', 'git'].includes(command)
						? { code: 0, stdout: 'v1', stderr: '' }
						: { code: 127, stdout: '', stderr: '' };
				}
			},
			environment({ platform: 'darwin', hasDisplay: true, browserPath: '/Applications/Chromium' })
		);
		expect(tags.length).toBeLessThanOrEqual(MAX_CAPABILITY_TAGS);
		for (const tag of tags) {
			expect(tag.length).toBeLessThanOrEqual(MAX_CAPABILITY_TAG_LENGTH);
		}
	});
});

describe('readEnvironment browser wiring', () => {
	it('records the resolved browser path so the tag and the executor agree', () => {
		const env = readEnvironment(
			{ platform: 'linux', arch: 'x64', version: 'v22.11.0', env: {} },
			() => '/usr/bin/google-chrome',
			{ fileExists: () => true }
		);
		expect(env.browserPath).toBe('/usr/bin/google-chrome');
	});

	it('leaves the path undefined when no probe is supplied (pure-logic callers)', () => {
		const env = readEnvironment({ platform: 'linux', arch: 'x64', version: 'v22.11.0', env: {} });
		expect(env.browserPath).toBeUndefined();
	});
});

describe('describeSelf', () => {
	it('bundles platform, version and capabilities, capping the version', async () => {
		const description = await describeSelf(runnerWith(['git']), environment(), '0.1.0');
		expect(description.platform).toBe('linux/x64');
		expect(description.version).toBe('0.1.0');
		expect(description.capabilities).toContain('git');

		const long = await describeSelf(runnerWith([]), environment(), 'v'.repeat(80));
		expect(long.version).toHaveLength(32);
	});

	/**
	 * Fleet health signals (EW-776) — the worker state joins the
	 * description through the same optional-probe seam as the telemetry,
	 * and inherits its whole contract: a probe that returns null or throws
	 * is an ABSENT field, never a failed beat and never a `null` on the
	 * wire (the server reads absent as "leave the stored value alone", so
	 * a momentary probe failure must not wipe a quarantine an operator is
	 * reading right now).
	 */
	describe('worker health', () => {
		it('carries the worker state and its reason', async () => {
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				workerHealth: () => ({ workerState: 'quarantined', workerStateReason: 'process tree unproven' })
			});

			expect(description.workerState).toBe('quarantined');
			expect(description.workerStateReason).toBe('process tree unproven');
		});

		it('omits the reason when the state carries none', async () => {
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				workerHealth: () => ({ workerState: 'idle' })
			});

			expect(description.workerState).toBe('idle');
			expect('workerStateReason' in description).toBe(false);
		});

		it('omits BOTH fields when there is no worker at all', async () => {
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				workerHealth: () => null
			});

			expect('workerState' in description).toBe(false);
			expect('workerStateReason' in description).toBe(false);
		});

		it('omits them when the probe throws, rather than failing the beat', async () => {
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				workerHealth: () => {
					throw new Error('worker loop is mid-restart');
				}
			});

			expect('workerState' in description).toBe(false);
			// Everything else still lands — one broken probe never costs the
			// node its whole description.
			expect(description.platform).toBe('linux/x64');
		});

		it('omits them when no probe is supplied at all', async () => {
			// Every existing caller, and every older build of this app.
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0');

			expect('workerState' in description).toBe(false);
		});
	});

	/**
	 * Node housekeeping (EW-803) — the disk floor this machine enforces on
	 * itself and what its reaper last reclaimed, joined through the same
	 * optional-probe seam and inheriting the same contract, with one
	 * documented exception: `minFreeDiskBytes` may legitimately travel as
	 * `null`, because "the operator switched the floor off" has no other
	 * way to be said.
	 */
	describe('housekeeping', () => {
		it('carries the floor and the last sweep', async () => {
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				housekeeping: () => ({
					minFreeDiskBytes: 2 * 1024 ** 3,
					workspaceCount: 12,
					workspaceBytes: 40 * 1024 ** 3,
					lastReclaimAt: '2026-09-05T09:30:00.000Z',
					lastReclaimFreedBytes: 3 * 1024 ** 3
				})
			});

			expect(description.minFreeDiskBytes).toBe(2 * 1024 ** 3);
			expect(description.workspaceCount).toBe(12);
			expect(description.workspaceBytes).toBe(40 * 1024 ** 3);
			expect(description.lastReclaimAt).toBe('2026-09-05T09:30:00.000Z');
			expect(description.lastReclaimFreedBytes).toBe(3 * 1024 ** 3);
		});

		it('forwards an explicit null floor, which is the one null this payload may carry', async () => {
			// Absent means "leave the stored value alone" server-side, so an
			// operator who turned the floor off needs the null to reach the
			// platform or Fleet keeps showing a floor that no longer exists.
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				housekeeping: () => ({ minFreeDiskBytes: null })
			});

			expect(description.minFreeDiskBytes).toBeNull();
			expect('minFreeDiskBytes' in description).toBe(true);
		});

		it('omits reclaim fields the report does not carry', async () => {
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				housekeeping: () => ({ minFreeDiskBytes: 2 * 1024 ** 3 })
			});

			expect('workspaceCount' in description).toBe(false);
			expect('lastReclaimAt' in description).toBe(false);
			expect('lastReclaimFreedBytes' in description).toBe(false);
		});

		it('never sends freed bytes without the instant they belong to', async () => {
			// A figure whose meaning depends entirely on "when" must not
			// reach the platform with the "when" missing.
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				housekeeping: () => ({ lastReclaimFreedBytes: 4 * 1024 ** 3 })
			});

			expect('lastReclaimFreedBytes' in description).toBe(false);
		});

		it('omits everything when the probe returns null or throws, rather than failing the beat', async () => {
			const none = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				housekeeping: () => null
			});
			expect('minFreeDiskBytes' in none).toBe(false);

			const thrown = await describeSelf(runnerWith([]), environment(), '0.1.0', null, {
				housekeeping: () => {
					throw new Error('reaper is mid-cycle');
				}
			});
			expect('minFreeDiskBytes' in thrown).toBe(false);
			// One broken probe never costs the node its whole description.
			expect(thrown.platform).toBe('linux/x64');
		});

		it('omits everything when no probe is supplied at all', async () => {
			// A visibility-only node, and every older build of this app.
			const description = await describeSelf(runnerWith([]), environment(), '0.1.0');

			expect('minFreeDiskBytes' in description).toBe(false);
			expect('workspaceBytes' in description).toBe(false);
		});
	});
});
