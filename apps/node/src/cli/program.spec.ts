import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from '../core/capabilities';
import { parseConfig, type ConfigFileSystem } from '../core/config-store';
import type { FetchLike } from '../core/fleet-client';
import { createLogger, type LogEntry } from '../core/logger';
import type { SecretStore } from '../core/secret-store';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../core/types';
import { workerSafetyMarkerPath } from '../core/worker-safety-store';
import {
	CliError,
	EXIT_FAILURE,
	EXIT_NOT_ENROLLED,
	EXIT_OK,
	parseIntervalSeconds,
	runCli,
	type CliDeps
} from './program';

// Pass-through spy on the runtime factory: `start` is only observable from
// the outside through what it hands to createNodeRuntime, and TypeScript
// cannot prove that a CLI flag reaches the runtime option it is meant for.
const runtimeCalls = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock('../core/runtime', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../core/runtime')>();
	return {
		...actual,
		createNodeRuntime: (...args: Parameters<typeof actual.createNodeRuntime>) => {
			runtimeCalls.options.push(args[2] as unknown as Record<string, unknown>);
			return actual.createNodeRuntime(...args);
		}
	};
});

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

/** In-memory {@link SecretStore} so keychain paths are testable. */
function fakeKeychain(seed: Record<string, string> = {}) {
	const entries = new Map<string, string>(Object.entries(seed));
	const store: SecretStore = {
		label: 'test keychain',
		get: async (account) => entries.get(account) ?? null,
		set: async (account, secret) => void entries.set(account, secret),
		delete: async (account) => void entries.delete(account)
	};
	return { store, entries };
}

function harness(
	options: {
		fetchFn?: FetchLike;
		files?: Record<string, string>;
		platform?: string;
		secrets?: SecretStore | null;
	} = {}
) {
	const files = new Map<string, string>(Object.entries(options.files ?? {}));
	const chmods: Array<{ path: string; mode: number }> = [];
	const restricted: string[] = [];
	const removed: string[] = [];
	const stdout: string[] = [];
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });

	const fs: ConfigFileSystem = {
		readFile: async (filePath) => files.get(filePath) ?? null,
		writeFile: async (filePath, content) => void files.set(filePath, content),
		createFileExclusive: async (filePath, content) => {
			if (files.has(filePath)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
			files.set(filePath, content);
		},
		mkdir: async () => undefined,
		chmod: async (filePath, mode) => void chmods.push({ path: filePath, mode }),
		remove: async (filePath) => {
			removed.push(filePath);
			files.delete(filePath);
		},
		restrict: async (filePath) => void restricted.push(filePath),
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
		out: (line) => stdout.push(line),
		...(options.secrets !== undefined ? { secrets: options.secrets } : {})
	};

	return {
		deps,
		files,
		chmods,
		restricted,
		removed,
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

describe('ever-works-node status — the pinned control plane (EW-779)', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('names the source of the API base when nothing is pinned', async () => {
		// Printing the bare URL made a pinned node indistinguishable from an
		// unpinned one, which is the state an operator most needs to see during
		// a fleet-wide outage.
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('api          https://api.ever.works (from the enrolled config)');
	});

	it('shows the pin and warns loudly when it is not the enrolled origin', async () => {
		vi.stubEnv('EVER_WORKS_NODE_API_URL', 'https://apistage.ever.works');
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });

		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('https://apistage.ever.works (PINNED via EVER_WORKS_NODE_API_URL)');
		// The enrolled origin is still named: it is what the secret was minted
		// against, and a mismatch 401s every call.
		expect(h.output()).toContain('enrolled against https://api.ever.works');
		expect(h.output()).toContain('401');
	});

	it('still prints a status when the pin itself is malformed', async () => {
		// `status` is the command an operator is told to run when nothing works.
		// It must not be the thing that also fails.
		vi.stubEnv('EVER_WORKS_NODE_API_URL', 'not a url');
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });

		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain(`node id      ${NODE_ID}`);
		expect(h.output()).toContain('EVER_WORKS_NODE_API_URL is set to an invalid URL');
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

	it('rejects a relative --workspace-root as a usage error before the config is read', async () => {
		// No config file on purpose: had the config been read first, the
		// outcome would be EXIT_NOT_ENROLLED, not the usage failure.
		const h = harness();
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start', '--workspace-root', 'relative/dir'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.logged()).toContain('--workspace-root must be an absolute directory');
	});

	it('hands --workspace-root to the runtime as agentTaskWorkspaceRoot', async () => {
		runtimeCalls.options.length = 0;
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			fetchFn: async () => ({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ ok: true, node: apiNode })
			})
		});
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		expect(runtimeCalls.options).toHaveLength(1);
		expect(runtimeCalls.options[0]?.agentTaskWorkspaceRoot).toBe('/srv/fleet');
	});

	it('leaves agentTaskWorkspaceRoot unset when --workspace-root is not given', async () => {
		runtimeCalls.options.length = 0;
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			fetchFn: async () => ({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ ok: true, node: apiNode })
			})
		});
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start'], h.deps)).toBe(EXIT_OK);
		expect(runtimeCalls.options).toHaveLength(1);
		expect(runtimeCalls.options[0]?.agentTaskWorkspaceRoot).toBeUndefined();
	});
});

describe('ever-works-node pause / resume', () => {
	/** Capture what the CLI actually sent to the platform. */
	function recordingFetch(status = 200) {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const fetchFn: FetchLike = async (url, init) => {
			calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
			return {
				ok: status < 400,
				status,
				text: async () => JSON.stringify({ ok: true, node: { ...apiNode, status: 'paused' } })
			};
		};
		return { calls, fetchFn };
	}

	it('tells the platform to drain AND records the intent locally', async () => {
		const { calls, fetchFn } = recordingFetch();
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, fetchFn });

		expect(await runCli(['pause'], h.deps)).toBe(EXIT_OK);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.ever.works/api/fleet/pause');
		expect(calls[0].body).toMatchObject({ nodeId: NODE_ID, secret: SECRET, paused: true });
		// Local flag matters independently: a restart must come back paused.
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.paused).toBe(true);
		expect(h.output()).toContain("the platform now reports status 'paused'");
		expect(h.output()).toContain('In-flight jobs keep running');
	});

	it('resume clears both the platform pause and the local flag', async () => {
		const { calls, fetchFn } = recordingFetch();
		const paused = JSON.stringify({ ...JSON.parse(storedConfig), paused: true });
		const h = harness({ files: { [CONFIG_PATH]: paused }, fetchFn });

		expect(await runCli(['resume'], h.deps)).toBe(EXIT_OK);

		expect(calls[0].body).toMatchObject({ paused: false });
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.paused).toBe(false);
	});

	it('keeps an unsafe quarantine on ordinary resume and clears it only after explicit process-tree confirmation', async () => {
		const unsafe = {
			since: '2026-08-22T23:00:00.000Z',
			reason: 'unverified process tree'
		};
		const quarantined = JSON.stringify({ ...JSON.parse(storedConfig), paused: true, unsafe });
		const h = harness({ files: { [CONFIG_PATH]: quarantined }, fetchFn: recordingFetch().fetchFn });

		expect(await runCli(['resume', '--local-only'], h.deps)).toBe(EXIT_OK);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)).toMatchObject({ paused: false, unsafe });
		expect(await runCli(['clear-quarantine'], h.deps)).toBe(EXIT_FAILURE);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)).toMatchObject({ unsafe });

		expect(await runCli(['clear-quarantine', '--confirm-process-tree-stopped'], h.deps)).toBe(EXIT_OK);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.unsafe).toBeUndefined();
		expect(h.output()).toContain('Quarantine cleared');
	});

	it('still records the drain locally when the platform is unreachable', async () => {
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			fetchFn: async () => {
				throw new Error('getaddrinfo ENOTFOUND api.ever.works');
			}
		});

		// Not a failure exit: the operator's intent was recorded and the
		// node WILL stop leasing. The gap is reported, not swallowed.
		expect(await runCli(['pause'], h.deps)).toBe(EXIT_OK);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.paused).toBe(true);
		expect(h.logged()).toContain('Could not reach the platform to pause');
		expect(h.output()).toContain('The platform still believes it is available');
	});

	it('--local-only never touches the network', async () => {
		const { calls, fetchFn } = recordingFetch();
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, fetchFn });

		expect(await runCli(['pause', '--local-only'], h.deps)).toBe(EXIT_OK);

		expect(calls).toHaveLength(0);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.paused).toBe(true);
		expect(h.output()).toContain('The platform was NOT told');
	});

	it('requires enrollment', async () => {
		const h = harness();
		expect(await runCli(['pause'], h.deps)).toBe(EXIT_NOT_ENROLLED);
	});

	it('never prints the credential', async () => {
		const { fetchFn } = recordingFetch();
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, fetchFn });
		await runCli(['pause'], h.deps);
		expect(h.output()).not.toContain(SECRET);
		expect(h.logged()).not.toContain(SECRET);
	});

	it('start comes back paused when the config says so, and says so loudly', async () => {
		const paused = JSON.stringify({ ...JSON.parse(storedConfig), paused: true });
		const h = harness({
			files: { [CONFIG_PATH]: paused },
			fetchFn: async () => ({
				ok: true,
				status: 200,
				text: async () => JSON.stringify({ ok: true, node: apiNode })
			})
		});
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start', '--work'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('Worker host PAUSED');
	});

	it('refuses every lease after restart when an orphan worker-session marker exists', async () => {
		const markerPath = workerSafetyMarkerPath(CONFIG_PATH);
		let leaseCalls = 0;
		const h = harness({
			files: {
				[CONFIG_PATH]: storedConfig,
				[markerPath]: JSON.stringify({
					version: 1,
					sessionId: 'prior-session',
					since: '2026-08-22T23:45:00.000Z'
				})
			},
			fetchFn: async (url) => {
				if (url.endsWith('/api/fleet/jobs/lease')) {
					leaseCalls += 1;
					return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
				}
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
			}
		});
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start', '--work'], h.deps)).toBe(EXIT_OK);
		expect(leaseCalls).toBe(0);
		expect(h.output()).toContain('Worker host QUARANTINED');
		expect(h.files.get(CONFIG_PATH)).toBe(storedConfig);
		expect(h.files.has(markerPath)).toBe(true);
	});

	it('clears a marker-only quarantine only after explicit process-tree confirmation', async () => {
		const markerPath = workerSafetyMarkerPath(CONFIG_PATH);
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig, [markerPath]: '{partial-worker-session' }
		});

		expect(await runCli(['clear-quarantine'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.files.has(markerPath)).toBe(true);
		expect(await runCli(['clear-quarantine', '--confirm-process-tree-stopped'], h.deps)).toBe(EXIT_OK);
		expect(h.files.has(markerPath)).toBe(false);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)).not.toBeNull();
	});
});

describe('ever-works-node unenroll', () => {
	it('retires the registration and erases the local credential', async () => {
		const calls: string[] = [];
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			fetchFn: async (url) => {
				calls.push(url);
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
			}
		});

		expect(await runCli(['unenroll'], h.deps)).toBe(EXIT_OK);

		expect(calls).toEqual(['https://api.ever.works/api/fleet/unenroll']);
		expect(h.removed).toEqual([CONFIG_PATH]);
		expect(h.files.has(CONFIG_PATH)).toBe(false);
		expect(h.output()).toContain('The registration and the local credential are both gone');
	});

	it('erases the local credential even when the platform call fails', async () => {
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			fetchFn: async () => ({ ok: false, status: 500, text: async () => '{}' })
		});

		expect(await runCli(['unenroll'], h.deps)).toBe(EXIT_OK);

		// A decommissioned machine holding a live secret is the worse
		// outcome — the erase is unconditional, the gap is reported.
		expect(h.files.has(CONFIG_PATH)).toBe(false);
		expect(h.output()).toContain('the platform was NOT told');
	});

	it('also deletes the keychain entry', async () => {
		const keychain = fakeKeychain({ [NODE_ID]: SECRET });
		const keychainConfig = JSON.stringify({
			...JSON.parse(storedConfig),
			secret: '',
			secretStorage: 'keychain'
		});
		const h = harness({
			files: { [CONFIG_PATH]: keychainConfig },
			secrets: keychain.store,
			fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) })
		});

		expect(await runCli(['unenroll'], h.deps)).toBe(EXIT_OK);
		expect(keychain.entries.has(NODE_ID)).toBe(false);
	});

	it('--local-only leaves the platform registration alone', async () => {
		const calls: string[] = [];
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			fetchFn: async (url) => {
				calls.push(url);
				return { ok: true, status: 200, text: async () => '{}' };
			}
		});

		expect(await runCli(['unenroll', '--local-only'], h.deps)).toBe(EXIT_OK);
		expect(calls).toHaveLength(0);
		expect(h.files.has(CONFIG_PATH)).toBe(false);
		expect(h.output()).toContain('The platform still lists this node');
	});
});

describe('credential storage (audit A45)', () => {
	it('enroll puts the secret in the keychain and keeps it out of the file', async () => {
		const keychain = fakeKeychain();
		const h = harness({ fetchFn: enrollOk, secrets: keychain.store });

		expect(await runCli(['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN], h.deps)).toBe(EXIT_OK);

		const raw = h.files.get(CONFIG_PATH) ?? '';
		expect(raw).not.toContain(SECRET);
		expect(raw).toContain('"secretStorage": "keychain"');
		expect(keychain.entries.get(NODE_ID)).toBe(SECRET);
		expect(h.output()).toContain('credential   test keychain');
	});

	it('a keychain-backed config is rehydrated on load', async () => {
		const keychain = fakeKeychain({ [NODE_ID]: SECRET });
		const keychainConfig = JSON.stringify({
			...JSON.parse(storedConfig),
			secret: '',
			secretStorage: 'keychain'
		});
		const h = harness({ files: { [CONFIG_PATH]: keychainConfig }, secrets: keychain.store });

		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('credential   stored (keychain)');
	});

	it('a keychain-backed config whose secret vanished reads as not enrolled', async () => {
		const keychain = fakeKeychain();
		const keychainConfig = JSON.stringify({
			...JSON.parse(storedConfig),
			secret: '',
			secretStorage: 'keychain'
		});
		const h = harness({ files: { [CONFIG_PATH]: keychainConfig }, secrets: keychain.store });

		// Beating forever with a blank credential would just farm 401s.
		expect(await runCli(['status'], h.deps)).toBe(EXIT_NOT_ENROLLED);
		expect(h.logged()).toContain('No credential for node');
	});

	it('without a keychain the secret lands in the file, loudly, and the file is tightened', async () => {
		const h = harness({ fetchFn: enrollOk, secrets: null });

		expect(await runCli(['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN], h.deps)).toBe(EXIT_OK);

		expect(h.files.get(CONFIG_PATH) ?? '').toContain(SECRET);
		expect(h.chmods).toEqual([{ path: CONFIG_PATH, mode: 0o600 }]);
		expect(h.output()).toContain('credential   config file (no OS keychain available)');
	});

	it('on Windows the file gets an owner-only ACL instead of a skipped chmod', async () => {
		const h = harness({ fetchFn: enrollOk, secrets: null, platform: 'win32' });

		expect(await runCli(['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN], h.deps)).toBe(EXIT_OK);

		expect(h.restricted).toEqual([CONFIG_PATH]);
		// chmod is meaningless on win32 and must NOT be the fallback.
		expect(h.chmods).toEqual([]);
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
