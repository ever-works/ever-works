import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from './capabilities';
import { describeSelf } from './capabilities';
import {
	AGENT_CLI_CANDIDATES,
	cacheProbe,
	detectAgentCliVersion,
	detectDiskFreeBytes,
	detectModelIdentity,
	MODEL_IDENTITY_CACHE_TTL_MS,
	parseClaudeAuthStatus,
	parseCliVersion,
	parseCodexLoginStatus
} from './telemetry-probe';

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

describe('parseClaudeAuthStatus (fleet cost accounting, EW-777)', () => {
	it('builds the label from the whitelisted fields only', () => {
		const status = JSON.stringify({
			loggedIn: true,
			authMethod: 'claude.ai',
			apiProvider: 'firstParty',
			email: 'ops@example.com',
			orgId: 'org_123',
			orgName: 'Acme',
			subscriptionType: 'max',
			accessToken: 'sk-ant-oat-should-never-appear'
		});
		const label = parseClaudeAuthStatus(status);
		expect(label).toBe('claude-code: ops@example.com (Acme, max)');
		expect(label).not.toContain('sk-ant');
		expect(label).not.toContain('org_123');
	});

	it('says "not logged in" rather than nothing, so a logged-out seat is visible', () => {
		expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toBe('claude-code: not logged in');
	});

	it('falls back to the auth method when the email is absent', () => {
		expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'console' }))).toBe(
			'claude-code: console login'
		);
		expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true }))).toBe('claude-code: logged in');
	});

	it('flattens control characters out of the label', () => {
		expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, email: 'a@b.c\n\tx' }))).toBe(
			'claude-code: a@b.c x'
		);
	});

	it('returns null for anything that is not a JSON object', () => {
		expect(parseClaudeAuthStatus('not json')).toBeNull();
		expect(parseClaudeAuthStatus('[]')).toBeNull();
		expect(parseClaudeAuthStatus('')).toBeNull();
	});
});

describe('parseCodexLoginStatus (fleet cost accounting, EW-777)', () => {
	it('maps the CLI prose onto the three seat kinds', () => {
		expect(parseCodexLoginStatus('Logged in using ChatGPT')).toBe('codex: chatgpt');
		expect(parseCodexLoginStatus('Logged in using an API key')).toBe('codex: api-key');
		expect(parseCodexLoginStatus('Not logged in')).toBe('codex: not logged in');
		expect(parseCodexLoginStatus('Logged in')).toBe('codex: logged in');
	});

	it('returns null for silence or unrelated output', () => {
		expect(parseCodexLoginStatus('')).toBeNull();
		expect(parseCodexLoginStatus('usage: codex login [status]')).toBeNull();
	});
});

describe('detectModelIdentity (fleet cost accounting, EW-777)', () => {
	const claudeJson = JSON.stringify({ loggedIn: true, email: 'ops@example.com', subscriptionType: 'max' });

	it('asks the resolved claude-code binary first and reports its seat', async () => {
		const runner = runnerFor({
			'/opt/claude': { code: 0, stdout: claudeJson },
			codex: { code: 0, stdout: 'Logged in using ChatGPT' }
		});

		await expect(detectModelIdentity(runner, { 'claude-code': '/opt/claude' })).resolves.toBe(
			'claude-code: ops@example.com (max)'
		);
		const calls = (runner.run as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0]).toEqual(['/opt/claude', ['auth', 'status', '--json']]);
		// Claude answered — codex was never spawned.
		expect(calls).toHaveLength(1);
	});

	it('keeps the claude seat when the CLI also prints a warning on stderr', async () => {
		// A JSON document plus stderr noise is not a JSON document; the
		// probe must read stdout on its own before giving up on the seat.
		const runner = runnerFor({
			claude: { code: 0, stdout: claudeJson, stderr: 'warning: a newer version of claude is available' },
			codex: { code: 0, stdout: 'Logged in using ChatGPT' }
		});

		await expect(detectModelIdentity(runner)).resolves.toBe('claude-code: ops@example.com (max)');
		expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
	});

	it('falls through to codex when claude-code is absent, using the resolved codex path', async () => {
		const runner = runnerFor({ '/opt/codex': { code: 0, stdout: 'Logged in using ChatGPT' } });

		await expect(detectModelIdentity(runner, { codex: '/opt/codex' })).resolves.toBe('codex: chatgpt');
	});

	it('still reports a logged-OUT codex, whose status command exits non-zero', async () => {
		const runner = runnerFor({ codex: { code: 1, stdout: '', stderr: 'Not logged in' } });

		await expect(detectModelIdentity(runner)).resolves.toBe('codex: not logged in');
	});

	it('probes the bare command names when no path was resolved', async () => {
		const runner = runnerFor({});
		await detectModelIdentity(runner);

		const probed = (runner.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
		expect(probed).toEqual(['claude', 'codex']);
	});

	it('returns null (not a throw) when nothing answers or the runner throws', async () => {
		await expect(detectModelIdentity(runnerFor({}))).resolves.toBeNull();
		const throwing: CommandRunner = {
			run: vi.fn(async () => {
				throw new Error('spawn EACCES');
			})
		};
		await expect(detectModelIdentity(throwing)).resolves.toBeNull();
	});

	it('caps the label at the contract length', async () => {
		const runner = runnerFor({
			claude: { code: 0, stdout: JSON.stringify({ loggedIn: true, email: `${'x'.repeat(400)}@example.com` }) }
		});
		const label = await detectModelIdentity(runner);
		expect((label ?? '').length).toBeLessThanOrEqual(200);
	});
});

describe('cacheProbe', () => {
	it('reuses one reading for the TTL, then re-probes', async () => {
		let clock = 0;
		const probe = vi.fn(async () => `reading-${probe.mock.calls.length}`);
		const cached = cacheProbe(probe, MODEL_IDENTITY_CACHE_TTL_MS, () => clock);

		await expect(cached()).resolves.toBe('reading-1');
		clock += MODEL_IDENTITY_CACHE_TTL_MS - 1;
		await expect(cached()).resolves.toBe('reading-1');
		expect(probe).toHaveBeenCalledTimes(1);

		clock += 1;
		await expect(cached()).resolves.toBe('reading-2');
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it('caches a null reading too — a machine with no CLI must not spawn per beat', async () => {
		const probe = vi.fn(async () => null);
		const cached = cacheProbe(probe, 1000, () => 0);

		await cached();
		await cached();
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('shares one in-flight probe between concurrent callers', async () => {
		let release: (value: string) => void = () => undefined;
		const probe = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
		const cached = cacheProbe(probe, 1000, () => 0);

		const first = cached();
		const second = cached();
		release('one');
		await expect(first).resolves.toBe('one');
		await expect(second).resolves.toBe('one');
		expect(probe).toHaveBeenCalledTimes(1);
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
			diskFreeBytes: () => 900_000_000,
			modelIdentity: () => 'claude-code: ops@example.com (max)'
		});

		expect(description.cliVersion).toBe('claude 1.4.2');
		expect(description.diskFreeBytes).toBe(900_000_000);
		expect(description.modelIdentity).toBe('claude-code: ops@example.com (max)');
	});

	it('OMITS the model identity when the probe answers null or blank', async () => {
		// Same rule as the other two fields: absent means "leave the stored
		// reading alone" server-side, so a transient probe miss must not
		// blank the identity the operator is reading spend against.
		for (const answer of [null, '']) {
			const description = await describeSelf(runnerFor({}), environment, '1.0.0', null, {
				modelIdentity: () => answer
			});
			expect(description).not.toHaveProperty('modelIdentity');
		}
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
