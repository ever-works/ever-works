import { describe, expect, it, vi } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from '../core/capabilities';
import type { ConfigFileSystem } from '../core/config-store';
import type { FetchLike } from '../core/fleet-client';
import { createLogger, type LogEntry } from '../core/logger';
import { nodeLifecycleRecordPath } from '../core/node-lifecycle';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../core/types';
import { EXIT_OK, runCli, type CliDeps } from './program';

/**
 * Node lifecycle (self-build slice AR) at the CLI: the running service
 * records the platform's version-floor verdict beside the config, and
 * `status` / `doctor` — separate processes — read it back; `doctor` also
 * says what each pinned model CLI is and whether this node can drive it.
 */

const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';
const CONFIG_PATH = '/home/x/.config/ever-works-node/node-config.json';
const RECORD_PATH = nodeLifecycleRecordPath(CONFIG_PATH);
const NOW = Date.parse('2026-10-08T12:00:00.000Z');

const storedConfig = JSON.stringify({
	apiUrl: 'https://api.ever.works',
	nodeId: NODE_ID,
	secret: SECRET,
	kind: 'node',
	capabilities: ['os:linux'],
	heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS / 2,
	enrolledAt: '2026-07-25T10:00:00.000Z'
});

const apiNode = {
	id: NODE_ID,
	name: 'build-box-01',
	kind: 'node',
	status: 'online',
	platform: 'linux/x64',
	version: '0.2.0',
	capabilities: ['os:linux'],
	lastHeartbeatAt: null,
	createdAt: null,
	persisted: true
};

const CLAUDE_HELP = [
	'Usage: claude [options]',
	'  -p, --print                 Print response and exit',
	'  --output-format <format>    Output format',
	'  --permission-mode <mode>    Permission mode',
	'  --model <model>             Model',
	'  --add-dir <directories...>  Additional directories',
	'  --mcp-config <configs...>   MCP config',
	'  --strict-mcp-config         Strict MCP',
	'  --allowedTools <tools...>   Allowed tools',
	'  --dangerously-skip-permissions  Skip permissions'
].join('\n');

function harness(
	options: {
		files?: Record<string, string>;
		heartbeat?: Record<string, unknown>;
		modelCli?: CapabilityEnvironment['modelCli'];
		version?: string;
	} = {}
) {
	const files = new Map<string, string>(Object.entries(options.files ?? {}));
	const stdout: string[] = [];
	const entries: LogEntry[] = [];
	const leases: string[] = [];
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
		dirname: (filePath) => filePath.replace(/\/[^/]*$/, '')
	};
	const fetchFn: FetchLike = async (url) => {
		if (url.endsWith('/api/fleet/jobs/lease')) {
			leases.push(url);
			return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
		}
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, node: apiNode, ...(options.heartbeat ?? {}) })
		};
	};
	const runner: CommandRunner = {
		run: async (_command, args) =>
			args[0] === '--version'
				? { code: 0, stdout: '2.1.3 (Claude Code)', stderr: '' }
				: { code: 0, stdout: CLAUDE_HELP, stderr: '' }
	};
	const deps: CliDeps = {
		io: {
			fetchFn,
			runner,
			environment: {
				platform: 'linux',
				arch: 'x64',
				nodeVersion: 'v26.10.0',
				hasDisplay: false,
				...(options.modelCli ? { modelCli: options.modelCli } : {})
			},
			logger: createLogger({ sink: (entry) => entries.push(entry) }),
			version: options.version ?? '0.2.0'
		},
		fs,
		configPath: CONFIG_PATH,
		platform: 'linux',
		out: (line) => stdout.push(line),
		secrets: null,
		workspaceHousekeeping: {
			scan: vi.fn(async (rootPath: string) => ({
				rootPath,
				exists: false,
				scannedAt: NOW,
				remoteRefreshed: true,
				repositories: [],
				totalBytes: 0,
				unrecognised: []
			})),
			reap: vi.fn()
		} as never,
		now: () => NOW
	};
	return {
		deps,
		files,
		leases,
		output: () => stdout.join('\n'),
		logged: () => entries.map((entry) => entry.message).join('\n')
	};
}

const record = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		version: 1,
		recordedAt: '2026-10-08T11:00:00.000Z',
		daemonVersion: '0.2.0',
		minNodeVersion: '0.3.0',
		upgradeRequired: true,
		...over
	});

describe('start — the platform says this daemon is below the floor', () => {
	it('holds the work lane, logs the upgrade command once, and records the verdict for status/doctor', async () => {
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			heartbeat: { minNodeVersion: '0.3.0', upgradeRequired: true }
		});
		h.deps.waitForShutdown = async () => {
			await vi.waitFor(() => expect(h.files.has(RECORD_PATH)).toBe(true));
		};

		expect(await runCli(['start', '--work'], h.deps)).toBe(EXIT_OK);

		// The first beat arrived before the worker started, so it never asked.
		expect(h.leases).toHaveLength(0);
		expect(h.logged()).toContain('Upgrade required — This daemon (0.2.0) is below the platform');
		expect(h.logged()).toContain('npm install -g ever-works-node@latest');
		expect(JSON.parse(h.files.get(RECORD_PATH) ?? '{}')).toMatchObject({
			version: 1,
			daemonVersion: '0.2.0',
			minNodeVersion: '0.3.0',
			upgradeRequired: true
		});
	});

	it('leases normally when the platform admits it', async () => {
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			heartbeat: { minNodeVersion: '0.1.0', upgradeRequired: false }
		});
		h.deps.waitForShutdown = async () => {
			await vi.waitFor(() => expect(h.leases.length).toBeGreaterThan(0));
		};
		expect(await runCli(['start', '--work'], h.deps)).toBe(EXIT_OK);
		expect(h.logged()).not.toContain('Upgrade required');
	});
});

describe('status and doctor read the recorded verdict', () => {
	it('status says UPGRADE REQUIRED with the exact command', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig, [RECORD_PATH]: record() } });
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain(
			"daemon       0.2.0 (running service) — UPGRADE REQUIRED: below the platform's minimum 0.3.0 (as of 2026-10-08T11:00:00.000Z); it is offered no new work"
		);
		expect(h.output()).toContain(
			'Run `npm install -g ever-works-node@latest` (or, on a node built from a monorepo'
		);
		expect(h.output()).toContain('then restart the node service');
	});

	it('doctor run by the UPGRADED binary says to restart the service that is still old', async () => {
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig, [RECORD_PATH]: record() },
			version: '0.3.0'
		});
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain(
			"daemon       0.2.0 (running service) — UPGRADE REQUIRED: below the platform's minimum 0.3.0 (as of 2026-10-08T11:00:00.000Z); it is offered no new work. This command's binary is already 0.3.0 — restart the node service to run it"
		);
	});

	it('never claims the SERVICE is refused because the binary running the command is older (review)', async () => {
		// The service runs 0.3.0 and the platform admits it; the CLI on PATH
		// is an older 0.2.0 install. The verdict is about the service.
		const h = harness({
			files: {
				[CONFIG_PATH]: storedConfig,
				[RECORD_PATH]: record({ daemonVersion: '0.3.0', minNodeVersion: '0.3.0', upgradeRequired: false })
			},
			version: '0.2.0'
		});
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).not.toContain('UPGRADE REQUIRED');
		expect(h.output()).toContain(
			"daemon       0.3.0 (running service; platform minimum 0.3.0, as of 2026-10-08T11:00:00.000Z); this command's binary is 0.2.0, below that minimum"
		);

		const json = harness({
			files: {
				[CONFIG_PATH]: storedConfig,
				[RECORD_PATH]: record({ daemonVersion: '0.3.0', minNodeVersion: '0.3.0', upgradeRequired: false })
			},
			version: '0.2.0'
		});
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet', '--json'], json.deps)).toBe(EXIT_OK);
		expect(JSON.parse(json.output())).toMatchObject({ upgradeRequired: false, localBinaryBelowFloor: true });
	});

	it('status before the service has ever beaten says the floor is not known yet', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain("daemon       0.2.0 (the platform's minimum version has not been reported yet");
	});

	it('doctor reports each pinned model CLI, its version, and what it does not advertise', async () => {
		const h = harness({
			files: {
				[CONFIG_PATH]: storedConfig,
				[RECORD_PATH]: record({ upgradeRequired: false, minNodeVersion: '0.1.0' })
			},
			modelCli: { 'claude-code': '/opt/pinned/claude', codex: null }
		});
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain(
			'daemon       0.2.0 (running service; platform minimum 0.1.0, as of 2026-10-08T11:00:00.000Z)'
		);
		expect(h.output()).toContain(
			'model cli    claude-code 2.1.3 (/opt/pinned/claude) — compatible; runs go without --effort, --max-budget-usd (not advertised by this build)'
		);
	});

	it('doctor --json carries the same facts', async () => {
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig, [RECORD_PATH]: record() },
			modelCli: { 'claude-code': '/opt/pinned/claude' }
		});
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet', '--json'], h.deps)).toBe(EXIT_OK);
		const parsed = JSON.parse(h.output()) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			daemonVersion: '0.2.0',
			minNodeVersion: '0.3.0',
			upgradeRequired: true,
			upgradeCommand: 'npm install -g ever-works-node@latest',
			modelCli: [
				{
					provider: 'claude-code',
					executable: '/opt/pinned/claude',
					version: '2.1.3',
					verified: true,
					compatible: true,
					unsupportedOptionalFlags: ['--effort', '--max-budget-usd']
				}
			]
		});
	});
});

describe('status and doctor show the platform limit ceiling (slice AS)', () => {
	const withCeiling = record({
		upgradeRequired: false,
		minNodeVersion: '0.1.0',
		limitCeiling: { maxConcurrentJobs: 2, maxCpuPercent: 80, maxMemoryMb: null }
	});
	const configWithLimits = JSON.stringify({
		...JSON.parse(storedConfig),
		limits: { maxConcurrentJobs: 4, maxCpuPercent: 70, maxMemoryMb: null }
	});

	it('status says what the platform set and what the node enforces under it', async () => {
		const h = harness({ files: { [CONFIG_PATH]: configWithLimits, [RECORD_PATH]: withCeiling } });
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain(
			'ceiling      2 concurrent job(s), CPU < 80% set on the platform (as of 2026-10-08T11:00:00.000Z) — enforcing 2 concurrent job(s), CPU < 70%, no memory ceiling'
		);
	});

	it('status says plainly when no ceiling is set', async () => {
		const h = harness({
			files: {
				[CONFIG_PATH]: storedConfig,
				[RECORD_PATH]: record({ upgradeRequired: false, limitCeiling: null })
			}
		});
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('ceiling      none set on the platform');
	});

	it('doctor --json carries the ceiling and the effective limits', async () => {
		const h = harness({ files: { [CONFIG_PATH]: configWithLimits, [RECORD_PATH]: withCeiling } });
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet', '--json'], h.deps)).toBe(EXIT_OK);
		expect(JSON.parse(h.output())).toMatchObject({
			limitCeiling: { maxConcurrentJobs: 2, maxCpuPercent: 80, maxMemoryMb: null },
			effectiveLimits: { maxConcurrentJobs: 2, maxCpuPercent: 70, maxMemoryMb: null }
		});
	});
});
