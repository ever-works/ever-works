import { describe, expect, it } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from '../core/capabilities';
import { parseConfig, type ConfigFileSystem } from '../core/config-store';
import type { FetchLike } from '../core/fleet-client';
import { createLogger, type LogEntry } from '../core/logger';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../core/types';
import {
	CliError,
	EXIT_FAILURE,
	EXIT_NOT_ENROLLED,
	EXIT_OK,
	parseIntervalSeconds,
	runCli,
	type CliDeps
} from './program';

const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';
const CONFIG_PATH = '/home/x/.config/ever-works-node/node-config.json';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

const runner: CommandRunner = {
	run: async (command) =>
		command === 'docker'
			? { code: 0, stdout: 'Docker version 27.4.0', stderr: '' }
			: { code: 127, stdout: '', stderr: '' }
};

const apiNode = {
	id: NODE_ID,
	name: 'build-box-01',
	kind: 'node',
	status: 'online',
	platform: 'linux/x64',
	version: '0.1.0',
	capabilities: ['os:linux'],
	lastHeartbeatAt: null,
	createdAt: null,
	persisted: true
};

function harness(
	options: {
		fetchFn?: FetchLike;
		files?: Record<string, string>;
		platform?: string;
	} = {}
) {
	const files = new Map<string, string>(Object.entries(options.files ?? {}));
	const chmods: Array<{ path: string; mode: number }> = [];
	const stdout: string[] = [];
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });

	const fs: ConfigFileSystem = {
		readFile: async (filePath) => files.get(filePath) ?? null,
		writeFile: async (filePath, content) => void files.set(filePath, content),
		mkdir: async () => undefined,
		chmod: async (filePath, mode) => void chmods.push({ path: filePath, mode }),
		dirname: (filePath) => filePath.replace(/\/[^/]*$/, '')
	};

	const deps: CliDeps = {
		io: {
			fetchFn: options.fetchFn ?? (async () => ({ ok: true, status: 201, text: async () => JSON.stringify({}) })),
			runner,
			environment,
			logger,
			version: '0.1.0'
		},
		fs,
		configPath: CONFIG_PATH,
		platform: options.platform ?? 'linux',
		out: (line) => stdout.push(line)
	};

	return {
		deps,
		files,
		chmods,
		stdout,
		entries,
		output: () => stdout.join('\n'),
		logged: () => entries.map((entry) => entry.message).join('\n')
	};
}

const enrollOk: FetchLike = async () => ({
	ok: true,
	status: 201,
	text: async () => JSON.stringify({ nodeId: NODE_ID, secret: SECRET, node: apiNode })
});

const storedConfig = JSON.stringify({
	apiUrl: 'https://api.ever.works',
	nodeId: NODE_ID,
	secret: SECRET,
	kind: 'node',
	capabilities: ['os:linux', 'docker'],
	name: 'build-box-01',
	heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
	enrolledAt: '2026-07-25T10:00:00.000Z'
});

describe('parseIntervalSeconds', () => {
	it('accepts whole seconds and converts to milliseconds', () => {
		expect(parseIntervalSeconds(undefined)).toBeUndefined();
		expect(parseIntervalSeconds('60')).toBe(60_000);
		expect(parseIntervalSeconds('5')).toBe(5_000);
	});

	it('rejects non-numeric, fractional and out-of-range values instead of silently defaulting', () => {
		for (const bad of ['abc', '', '1.5', '0', '-30', '5000']) {
			expect(() => parseIntervalSeconds(bad)).toThrowError(CliError);
		}
	});
});

describe('ever-works-node enroll', () => {
	it('parses the flags, enrolls and persists the credential at 0600', async () => {
		const h = harness({ fetchFn: enrollOk });

		const code = await runCli(
			['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN, '--name', 'build-box-01'],
			h.deps
		);

		expect(code).toBe(EXIT_OK);
		const written = parseConfig(h.files.get(CONFIG_PATH) ?? null);
		expect(written).toMatchObject({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			name: 'build-box-01'
		});
		expect(written?.capabilities).toContain('docker');
		expect(h.chmods).toEqual([{ path: CONFIG_PATH, mode: 0o600 }]);
		expect(h.output()).toContain(`Enrolled as node ${NODE_ID}`);
	});

	it('accepts the short flag aliases and a custom heartbeat interval', async () => {
		const h = harness({ fetchFn: enrollOk });

		const code = await runCli(['enroll', '-a', 'http://localhost:3100', '-t', TOKEN, '-i', '30'], h.deps);

		expect(code).toBe(EXIT_OK);
		const written = parseConfig(h.files.get(CONFIG_PATH) ?? null);
		expect(written?.apiUrl).toBe('http://localhost:3100');
		expect(written?.heartbeatIntervalMs).toBe(30_000);
	});

	it('fails when a required flag is missing, and writes nothing', async () => {
		const missingToken = harness({ fetchFn: enrollOk });
		expect(await runCli(['enroll', '--api-url', 'https://api.ever.works'], missingToken.deps)).toBe(EXIT_FAILURE);
		expect(missingToken.files.size).toBe(0);

		const missingUrl = harness({ fetchFn: enrollOk });
		expect(await runCli(['enroll', '--token', TOKEN], missingUrl.deps)).toBe(EXIT_FAILURE);
		expect(missingUrl.files.size).toBe(0);
	});

	it('rejects an unknown flag rather than ignoring a typo', async () => {
		const h = harness({ fetchFn: enrollOk });
		const code = await runCli(
			['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN, '--capabilties', 'docker'],
			h.deps
		);
		expect(code).toBe(EXIT_FAILURE);
		expect(h.files.size).toBe(0);
	});

	it('surfaces a rejected token as a failure exit code and never persists a config', async () => {
		const h = harness({
			fetchFn: async () => ({ ok: false, status: 401, text: async () => '{}' })
		});

		const code = await runCli(['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN], h.deps);

		expect(code).toBe(EXIT_FAILURE);
		expect(h.files.size).toBe(0);
		expect(h.logged()).toContain('unauthorized');
	});

	it('never prints or logs the token or the minted secret', async () => {
		const h = harness({ fetchFn: enrollOk });
		await runCli(['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN], h.deps);

		expect(h.output()).not.toContain(TOKEN);
		expect(h.output()).not.toContain(SECRET);
		expect(h.logged()).not.toContain(TOKEN);
		expect(h.logged()).not.toContain(SECRET);
	});
});

describe('ever-works-node status', () => {
	it('prints the enrollment with the credential reported but never shown', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });

		const code = await runCli(['status'], h.deps);

		expect(code).toBe(EXIT_OK);
		expect(h.output()).toContain(`node id      ${NODE_ID}`);
		expect(h.output()).toContain('api          https://api.ever.works');
		expect(h.output()).toContain('credential   stored');
		expect(h.output()).toContain('os:linux, docker');
		expect(h.output()).not.toContain(SECRET);
	});

	it('exits with the dedicated not-enrolled code when there is no config', async () => {
		const h = harness();
		const code = await runCli(['status'], h.deps);

		expect(code).toBe(EXIT_NOT_ENROLLED);
		expect(h.logged()).toContain('not enrolled');
	});

	it('treats a corrupt config as not enrolled rather than crashing', async () => {
		const h = harness({ files: { [CONFIG_PATH]: '{ truncated' } });
		expect(await runCli(['status'], h.deps)).toBe(EXIT_NOT_ENROLLED);
	});
});

describe('ever-works-node capabilities', () => {
	it('prints the tags this machine would report, without needing enrollment', async () => {
		const h = harness();

		const code = await runCli(['capabilities'], h.deps);

		expect(code).toBe(EXIT_OK);
		expect(h.output()).toContain('platform     linux/x64');
		expect(h.output()).toContain('version      0.1.0');
		expect(h.output()).toContain('docker');
		expect(h.output()).toContain('terminal');
	});
});

describe('ever-works-node start', () => {
	it('heartbeats until the shutdown signal, then stops the loop', async () => {
		let beats = 0;
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			fetchFn: async () => {
				beats += 1;
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
			}
		});
		// Shut down immediately after the first beat settles.
		h.deps.waitForShutdown = () => Promise.resolve();

		const code = await runCli(['start'], h.deps);

		expect(code).toBe(EXIT_OK);
		expect(beats).toBeGreaterThanOrEqual(1);
		expect(h.output()).toContain(`Starting node ${NODE_ID}`);
		expect(h.output()).toContain('Stopped.');
		expect(h.logged()).not.toContain(SECRET);
	});

	it('refuses to start when the machine is not enrolled', async () => {
		const h = harness();
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start'], h.deps)).toBe(EXIT_NOT_ENROLLED);
	});

	it('rejects an out-of-range interval override before touching the network', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start', '--heartbeat-interval', '99999'], h.deps)).toBe(EXIT_FAILURE);
	});
});

describe('program surface', () => {
	it('treats --help and --version as successful terminations', async () => {
		const h = harness();
		// Commander writes help to stdout via its own writer; we only assert the code.
		expect(await runCli(['--help'], h.deps)).toBe(EXIT_OK);
		expect(await runCli(['--version'], h.deps)).toBe(EXIT_OK);
	});

	it('fails on an unknown subcommand', async () => {
		const h = harness();
		expect(await runCli(['teleport'], h.deps)).toBe(EXIT_FAILURE);
	});
});
