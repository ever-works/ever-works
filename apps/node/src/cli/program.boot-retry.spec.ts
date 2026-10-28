import { describe, expect, it } from 'vitest';
import type { BootRetryPolicy } from '../core/boot-retry';
import type { CapabilityEnvironment, CommandRunner } from '../core/capabilities';
import type { ConfigFileSystem } from '../core/config-store';
import type { FetchLike } from '../core/fleet-client';
import { createLogger, type LogEntry } from '../core/logger';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../core/types';
import { workerSafetyMarkerPath } from '../core/worker-safety-store';
import { restrictFileToOwnerWindowsWithRetry } from '../node-io';
import { EXIT_OK, runCli, type CliDeps } from './program';

/**
 * Boot-probe retry, end to end: `ever-works-node start --work` on a Windows PC whose
 * `icacls` is slow. The worker-safety marker's owner-only proof goes through
 * the REAL retrying adapter (`restrictFileToOwnerWindowsWithRetry`); only the
 * spawn is scripted — a slow machine is a runner whose first attempts come
 * back `timedOut` — and the pauses between attempts take no time.
 *
 *   - slow, then answers  → no quarantine; the worker leases; the marker is
 *                           released on shutdown (EVERDESK1/2 come up).
 *   - genuinely refused   → quarantined at once, exactly as before.
 *   - never answers       → quarantined, and the reason Fleet is told says
 *                           "probe timed out", not a refused ACL.
 */

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const CONFIG_PATH = 'C:/Users/owner/AppData/Roaming/ever-works-node/node-config.json';
const MARKER_PATH = workerSafetyMarkerPath(CONFIG_PATH);

const storedConfig = JSON.stringify({
	apiUrl: 'https://api.ever.works',
	nodeId: NODE_ID,
	secret: SECRET,
	kind: 'node',
	capabilities: ['os:win32'],
	name: 'everdesk1',
	heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
	enrolledAt: '2026-07-25T10:00:00.000Z'
});

const apiNode = {
	id: NODE_ID,
	name: 'everdesk1',
	kind: 'node',
	status: 'online',
	platform: 'win32/x64',
	version: '0.2.8',
	capabilities: ['os:win32'],
	lastHeartbeatAt: null,
	createdAt: null,
	persisted: true
};

const environment: CapabilityEnvironment = {
	platform: 'win32',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

const probeRunner: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: '' }) };

type IcaclsMode = { slowAttempts: number } | 'refused' | 'hung';

/** The scripted `icacls`: how a busy (or broken) PC answers. */
function icacls(mode: IcaclsMode) {
	const deadlines: number[] = [];
	let calls = 0;
	const runner: CommandRunner = {
		run: async (command, _args, options) => {
			if (command !== 'icacls') throw new Error(`unexpected spawn: ${command}`);
			calls += 1;
			deadlines.push(options?.timeoutMs ?? -1);
			if (mode === 'refused') return { code: 5, stdout: '', stderr: 'Access is denied.' };
			if (mode === 'hung' || calls <= mode.slowAttempts) {
				return { code: 1, stdout: '', stderr: '', timedOut: true };
			}
			return { code: 0, stdout: 'processed file', stderr: '' };
		}
	};
	return { runner, deadlines };
}

function harness(
	mode: IcaclsMode,
	policy?: BootRetryPolicy,
	options: { environment?: CapabilityEnvironment; argv?: string[] } = {}
) {
	const files = new Map<string, string>([[CONFIG_PATH, storedConfig]]);
	const entries: LogEntry[] = [];
	const stdout: string[] = [];
	const beats: Array<Record<string, unknown>> = [];
	let leaseCalls = 0;
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	const acl = icacls(mode);

	const fs: ConfigFileSystem = {
		readFile: async (filePath) => files.get(filePath) ?? null,
		writeFile: async (filePath, content) => void files.set(filePath, content),
		createFileExclusive: async (filePath, content) => {
			if (files.has(filePath)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
			files.set(filePath, content);
		},
		mkdir: async () => undefined,
		chmod: async () => undefined,
		remove: async (filePath) => void files.delete(filePath),
		// The production adapter, with the spawn and the clock injected.
		restrict: (filePath) =>
			restrictFileToOwnerWindowsWithRetry(filePath, {
				runner: acl.runner,
				env: { USERDOMAIN: 'EVERDESK1', USERNAME: 'owner' },
				sleep: async () => undefined,
				logger,
				...(policy ? { policy } : {})
			}),
		dirname: (filePath) => filePath.replace(/\/[^/]*$/, '')
	};

	const fetchFn: FetchLike = async (url, init) => {
		if (url.endsWith('/api/fleet/jobs/lease')) {
			leaseCalls += 1;
			return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
		}
		if (url.endsWith('/api/fleet/heartbeat')) beats.push(JSON.parse(init.body) as Record<string, unknown>);
		return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
	};

	const timers: Array<() => void> = [];
	let shutdown!: () => void;
	const deps: CliDeps = {
		io: {
			fetchFn,
			runner: probeRunner,
			environment: options.environment ?? environment,
			logger,
			version: '0.2.8',
			scheduler: {
				setTimeout: (callback: () => void) => {
					timers.push(callback);
					return timers.length;
				},
				clearTimeout: () => undefined
			}
		},
		fs,
		configPath: CONFIG_PATH,
		platform: 'win32',
		out: (line) => stdout.push(line),
		waitForShutdown: () =>
			new Promise<void>((resolve) => {
				shutdown = resolve;
			})
	};

	const flush = async (): Promise<void> => {
		for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
	};

	return {
		deps,
		files,
		acl,
		leases: () => leaseCalls,
		output: () => stdout.join('\n'),
		logged: () => entries.map((entry) => entry.message).join('\n'),
		/** Boot, let the lanes start, beat once more so the worker's state is reported, then stop. */
		async bootAndStop(): Promise<{ code: number; lastBeat: Record<string, unknown> | undefined }> {
			const run = runCli(options.argv ?? ['start', '--work'], deps);
			await flush();
			for (const fire of timers.splice(0)) fire();
			await flush();
			const lastBeat = beats.at(-1);
			shutdown();
			return { code: await run, lastBeat };
		}
	};
}

describe('start --work on a busy Windows PC (boot-probe retry)', () => {
	it('retries a slow icacls and comes up WITHOUT quarantine, then releases the marker on shutdown', async () => {
		const h = harness({ slowAttempts: 2 });

		const { code, lastBeat } = await h.bootAndStop();

		expect(code).toBe(EXIT_OK);
		expect(h.acl.deadlines).toEqual([10_000, 20_000, 30_000]);
		expect(h.output()).toContain('Worker host enabled');
		expect(h.output()).not.toContain('QUARANTINED');
		expect(h.leases()).toBeGreaterThanOrEqual(1);
		expect(lastBeat).toMatchObject({ workerState: 'idle' });
		expect(h.logged()).toMatch(/Owner-only ACL \(icacls\) on .*timed out after 10 s \(attempt 1\/4\)/);
		// A clean drain released the marker: the next start is not quarantined either.
		expect(h.files.has(MARKER_PATH)).toBe(false);
		expect(h.files.get(CONFIG_PATH)).toBe(storedConfig);
	});

	it('the old single 10 s attempt, on the same slow machine, is what quarantined it', async () => {
		const h = harness({ slowAttempts: 2 }, { attemptTimeoutsMs: [10_000], backoffMs: [] });

		const { code } = await h.bootAndStop();

		expect(code).toBe(EXIT_OK);
		expect(h.output()).toContain('Worker host QUARANTINED');
		expect(h.leases()).toBe(0);
		expect(h.files.has(MARKER_PATH)).toBe(true);
	});

	it('still quarantines at once on a GENUINE refusal — no retry, and the reason is the refusal', async () => {
		const h = harness('refused');

		const { code, lastBeat } = await h.bootAndStop();

		expect(code).toBe(EXIT_OK);
		expect(h.acl.deadlines).toEqual([10_000]);
		expect(h.output()).toContain('Worker host QUARANTINED');
		expect(h.leases()).toBe(0);
		expect(lastBeat).toMatchObject({
			workerState: 'quarantined',
			workerStateReason: expect.stringContaining('not proven owner-only: icacls exited 5: Access is denied.')
		});
		expect(String(lastBeat?.workerStateReason)).not.toMatch(/timed out/);
		// Fail closed exactly as before: the marker stays for an operator to clear.
		expect(h.files.has(MARKER_PATH)).toBe(true);
	});

	it('quarantines when icacls never answers — and reports it to Fleet as a TIMEOUT', async () => {
		const h = harness('hung');

		const { code, lastBeat } = await h.bootAndStop();

		expect(code).toBe(EXIT_OK);
		expect(h.acl.deadlines).toEqual([10_000, 20_000, 30_000, 40_000]);
		expect(h.output()).toContain('Worker host QUARANTINED');
		expect(h.leases()).toBe(0);
		expect(lastBeat).toMatchObject({
			workerState: 'quarantined',
			workerStateReason: expect.stringMatching(
				/not proven owner-only: probe timed out: owner-only ACL \(icacls\) did not finish in 4 attempts/
			)
		});
		expect(h.logged()).toMatch(/Fleet worker cannot lease: .*probe timed out/);
		expect(h.files.has(MARKER_PATH)).toBe(true);
	});
});

describe('start --work when the model-CLI PATH lookup timed out at boot (boot-probe retry)', () => {
	const timedOutEnvironment: CapabilityEnvironment = {
		...environment,
		modelCli: { 'claude-code': null, codex: null },
		modelCliNotes: [
			'claude-code: probe timed out: PATH lookup (where claude) did not finish in 4 attempts (deadlines 5 s, 10 s, 20 s, 30 s); the machine was too busy to answer, which is not a negative result — not advertised by this process; restart the node once the machine is less busy',
			'codex: not found on PATH'
		],
		modelCliTimedOut: ['claude-code']
	};

	it('logs "probe timed out" — not "not found on PATH" — and tells Fleet the same', async () => {
		const h = harness({ slowAttempts: 0 }, undefined, { environment: timedOutEnvironment });

		const { lastBeat } = await h.bootAndStop();

		expect(h.logged()).toMatch(/Model CLI — claude-code: probe timed out: PATH lookup \(where claude\)/);
		expect(h.logged()).not.toMatch(/claude-code: not found on PATH/);
		expect(h.logged()).toContain('Model CLI — codex: not found on PATH');
		// The timed-out CLI is listed as such; the genuinely missing one is not listed at all.
		expect(lastBeat?.cliVersions).toEqual(['claude-code probe-timed-out']);
		expect(lastBeat?.capabilities).not.toContain('claude-code');
	});

	it('keeps the timed-out verdict when another CLI is re-pinned with a flag', async () => {
		const h = harness({ slowAttempts: 0 }, undefined, {
			environment: timedOutEnvironment,
			argv: ['start', '--work', '--codex-path', 'C:/tools/codex.exe']
		});

		const { lastBeat } = await h.bootAndStop();

		expect(h.logged()).toMatch(/Model CLI — claude-code: probe timed out/);
		expect(h.logged()).toContain('Model CLI — codex: C:/tools/codex.exe (pinned)');
		expect(lastBeat?.cliVersions).toEqual(['codex unknown', 'claude-code probe-timed-out']);
	});
});
