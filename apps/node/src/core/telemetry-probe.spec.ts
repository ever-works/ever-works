import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from './capabilities';
import { describeSelf } from './capabilities';
import { AGENT_CLI_CANDIDATES, detectAgentCliVersion, detectDiskFreeBytes, parseCliVersion } from './telemetry-probe';

/**
 * Node telemetry probes.
 *
 * The rule every case here defends: a probe never fails the beat. A
 * missing tool, an unreadable volume or a binary that throws must cost
 * one FIELD, never the heartbeat that carries the node's liveness and
 * every other capability.
 */

function runnerFor(responses: Record<string, { code: number; stdout?: string; stderr?: string }>): CommandRunner {
	return {
		run: vi.fn(async (command: string) => {
			const response = responses[command];
			if (!response) {
				return { code: 1, stdout: '', stderr: 'not found' };
			}
			return { code: response.code, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
		})
	};
}

describe('parseCliVersion', () => {
	it('extracts a bare semver', () => {
		expect(parseCliVersion('1.2.3')).toBe('1.2.3');
	});

	it('extracts the version out of a decorated banner', () => {
		expect(parseCliVersion('1.4.2 (Claude Code)')).toBe('1.4.2');
		expect(parseCliVersion('codex version 0.9\n')).toBe('0.9');
	});

	it('keeps a prerelease suffix', () => {
		expect(parseCliVersion('2.0.0-beta.1')).toBe('2.0.0-beta.1');
	});

	it('returns null when there is no dotted-numeric token', () => {
		// A banner is not a version; putting one in a column operators
		// scan for drift would be noise, not information.
		expect(parseCliVersion('Claude Code — the agentic CLI')).toBeNull();
		expect(parseCliVersion('')).toBeNull();
	});
});

describe('detectAgentCliVersion', () => {
	it('reports the first candidate that answers, prefixed with its name', async () => {
		const runner = runnerFor({ claude: { code: 0, stdout: '1.4.2 (Claude Code)' } });

		await expect(detectAgentCliVersion(runner)).resolves.toBe('claude 1.4.2');
	});

	it('falls through to the next candidate when the first is absent', async () => {
		const runner = runnerFor({ codex: { code: 0, stdout: '0.9.1' } });

		await expect(detectAgentCliVersion(runner)).resolves.toBe('codex 0.9.1');
	});

	it('respects the documented preference order', async () => {
		const runner = runnerFor({
			claude: { code: 0, stdout: '1.0.0' },
			codex: { code: 0, stdout: '2.0.0' }
		});

		await expect(detectAgentCliVersion(runner)).resolves.toBe('claude 1.0.0');
	});

	it('reads a version printed on stderr', async () => {
		const runner = runnerFor({ claude: { code: 0, stdout: '', stderr: '3.1.0' } });

		await expect(detectAgentCliVersion(runner)).resolves.toBe('claude 3.1.0');
	});

	it('skips a candidate that exits non-zero', async () => {
		const runner = runnerFor({ claude: { code: 127, stdout: '1.0.0' } });

		await expect(detectAgentCliVersion(runner)).resolves.toBeNull();
	});

	it('skips a candidate whose output has no parseable version', async () => {
		const runner = runnerFor({ claude: { code: 0, stdout: 'unknown' } });

		await expect(detectAgentCliVersion(runner)).resolves.toBeNull();
	});

	it('returns null (not a throw) when nothing is installed', async () => {
		await expect(detectAgentCliVersion(runnerFor({}))).resolves.toBeNull();
	});

	it('survives a runner that throws', async () => {
		const runner: CommandRunner = {
			run: vi.fn(async () => {
				throw new Error('spawn EACCES');
			})
		};

		await expect(detectAgentCliVersion(runner)).resolves.toBeNull();
	});

	it('probes only the documented candidates', async () => {
		const runner = runnerFor({});
		await detectAgentCliVersion(runner);

		const probed = (runner.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
		expect(probed).toEqual([...AGENT_CLI_CANDIDATES]);
	});

	it('caps the reported string at the contract length', async () => {
		const runner = runnerFor({ claude: { code: 0, stdout: `1.${'0'.repeat(200)}.3` } });

		const result = await detectAgentCliVersion(runner);
		expect((result ?? '').length).toBeLessThanOrEqual(64);
	});
});

describe('detectDiskFreeBytes', () => {
	it('reports a floored byte count', async () => {
		await expect(detectDiskFreeBytes({ freeBytes: () => 1024.9 }, '/srv')).resolves.toBe(1024);
	});

	it('passes the requested path through to the probe', async () => {
		const freeBytes = vi.fn(() => 10);
		await detectDiskFreeBytes({ freeBytes }, '/srv/ever-works');
		expect(freeBytes).toHaveBeenCalledWith('/srv/ever-works');
	});

	it.each([
		['null', null],
		['negative', -5],
		['non-finite', Number.NaN]
	])('reports %s as unknown rather than as a number', async (_label, value) => {
		await expect(detectDiskFreeBytes({ freeBytes: () => value as number }, '/srv')).resolves.toBeNull();
	});

	it('survives a probe that throws', async () => {
		await expect(
			detectDiskFreeBytes(
				{
					freeBytes: () => {
						throw new Error('ENOENT');
					}
				},
				'/gone'
			)
		).resolves.toBeNull();
	});
});

describe('describeSelf telemetry integration', () => {
	const environment = {
		platform: 'linux',
		arch: 'x64',
		nodeVersion: 'v22.11.0',
		hasDisplay: false
	};

	it('OMITS a telemetry field whose probe returns null', async () => {
		// Omission is load-bearing: the server reads an absent field as
		// "leave the stored value alone", so a transient probe failure
		// must not be sent as an explicit null that wipes a good reading.
		const description = await describeSelf(runnerFor({}), environment, '1.0.0', null, {
			cliVersion: () => null,
			diskFreeBytes: () => null
		});

		expect(description).not.toHaveProperty('cliVersion');
		expect(description).not.toHaveProperty('diskFreeBytes');
		// The original three fields are still always present.
		expect(description.platform).toBe('linux/x64');
		expect(description.version).toBe('1.0.0');
		expect(Array.isArray(description.capabilities)).toBe(true);
	});

	it('includes telemetry when the probes answer', async () => {
		const description = await describeSelf(runnerFor({}), environment, '1.0.0', null, {
			cliVersion: () => 'claude 1.4.2',
			diskFreeBytes: () => 900_000_000
		});

		expect(description.cliVersion).toBe('claude 1.4.2');
		expect(description.diskFreeBytes).toBe(900_000_000);
	});

	it('describes the node unchanged when no telemetry is supplied at all', async () => {
		const description = await describeSelf(runnerFor({}), environment, '1.0.0', null);

		expect(description).not.toHaveProperty('cliVersion');
		expect(description).not.toHaveProperty('diskFreeBytes');
	});

	it('does not let a THROWING probe fail the description', async () => {
		const description = await describeSelf(runnerFor({}), environment, '1.0.0', null, {
			cliVersion: () => {
				throw new Error('probe exploded');
			},
			diskFreeBytes: () => 5
		});

		expect(description).not.toHaveProperty('cliVersion');
		// The sibling probe still lands — one bad probe is one bad field.
		expect(description.diskFreeBytes).toBe(5);
	});
});
