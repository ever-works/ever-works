import { describe, expect, it, vi } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from '../core/capabilities';
import { parseConfig, type ConfigFileSystem } from '../core/config-store';
import type { FetchLike } from '../core/fleet-client';
import type { Scheduler } from '../core/heartbeat';
import { createLogger, type LogEntry } from '../core/logger';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../core/types';
import { workerSafetyMarkerPath } from '../core/worker-safety-store';
import type { WorkspaceInventory, WorkspaceRecord } from '../core/workspaces/workspace-inventory';
import {
	DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS,
	type WorkspaceReapPlan,
	type WorkspaceReapResult
} from '../core/workspaces/workspace-reaper';
import { EXIT_FAILURE, EXIT_OK, runCli, type CliDeps } from './program';

/**
 * `doctor`, `gc`, the disk-floor flags and the reaper policy flags
 * (self-build program note §6). The inventory scan and the executor are
 * injected fakes: what is pinned here is argument handling, persistence,
 * and what the operator sees — the real scan and reaper have their own
 * real-Git suite.
 */

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
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-05T12:00:00.000Z');

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};
const runner: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: '' }) };

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

const storedConfig = JSON.stringify({
	apiUrl: 'https://api.ever.works',
	nodeId: NODE_ID,
	secret: SECRET,
	kind: 'node',
	capabilities: ['os:linux'],
	// Not the 60 s default: the reaper's initial delay is also 60 s, and the
	// recording scheduler below fires timers BY delay.
	heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS / 2,
	enrolledAt: '2026-07-25T10:00:00.000Z'
});

const okFetch: FetchLike = async (url) => {
	if (url.endsWith('/api/fleet/jobs/lease')) {
		return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
	}
	if (url.endsWith('/api/fleet/enroll')) {
		return {
			ok: true,
			status: 201,
			text: async () => JSON.stringify({ nodeId: NODE_ID, secret: SECRET, node: apiNode })
		};
	}
	return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
};

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
	return {
		path: '/srv/fleet/repositories/r/worktrees/fleet-abc',
		repositoryRoot: '/srv/fleet/repositories/r',
		poolPath: '/srv/fleet/repositories/r/repos/pool',
		gitDir: '/srv/fleet/repositories/r/repos/pool/worktrees/fleet-abc',
		bindingKey: 'fleet-abc',
		branch: 'task/abc',
		headSha: 'a'.repeat(40),
		owned: true,
		ownershipNote: null,
		lastUsedAt: NOW - 30 * DAY,
		hasUsageRecord: true,
		sizeBytes: 300 * MIB,
		dirty: false,
		hasLocks: false,
		unpushedCount: 0,
		remoteBranch: 'absent',
		mergedIntoDefault: 'unknown',
		intentPending: false,
		lease: null,
		mountLinks: [],
		mountsDir: 'absent',
		excludedOutput: false,
		...overrides
	};
}

function inventory(worktrees: WorkspaceRecord[], remoteRefreshed = true): WorkspaceInventory {
	return {
		rootPath: '/srv/fleet',
		exists: true,
		scannedAt: NOW,
		remoteRefreshed,
		repositories: [{ repositoryRoot: '/srv/fleet/repositories/r', pools: [], worktrees, unrecognised: [] }],
		totalBytes: worktrees.reduce((sum, tree) => sum + tree.sizeBytes, 0),
		unrecognised: []
	};
}

function recordingScheduler(): Scheduler & { delays: number[]; fire(delay: number): void } {
	const queue: Array<{ id: number; delay: number; callback: () => void }> = [];
	const delays: number[] = [];
	let nextId = 1;
	return {
		delays,
		setTimeout(callback, ms) {
			delays.push(ms);
			const id = nextId++;
			queue.push({ id, delay: ms, callback });
			return id;
		},
		clearTimeout(handle) {
			const index = queue.findIndex((entry) => entry.id === handle);
			if (index >= 0) queue.splice(index, 1);
		},
		fire(delay) {
			const index = queue.findIndex((entry) => entry.delay === delay);
			if (index >= 0) queue.splice(index, 1)[0].callback();
		}
	};
}

function harness(
	options: {
		files?: Record<string, string>;
		freeBytes?: number | null;
		inventory?: WorkspaceInventory;
		scheduler?: Scheduler;
	} = {}
) {
	const files = new Map<string, string>(Object.entries(options.files ?? {}));
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
		chmod: async () => undefined,
		remove: async (filePath) => void files.delete(filePath),
		dirname: (filePath) => filePath.replace(/\/[^/]*$/, '')
	};
	const scan = vi.fn(async (rootPath: string, scanOptions?: { refreshRemote?: boolean }) => {
		const refreshed = scanOptions?.refreshRemote !== false;
		const base = options.inventory ?? inventory([]);
		return {
			...base,
			rootPath,
			remoteRefreshed: refreshed,
			// Like the real scanner: offline, every remote fact reads as unknown.
			repositories: refreshed
				? base.repositories
				: base.repositories.map((repository) => ({
						...repository,
						worktrees: repository.worktrees.map((tree) => ({
							...tree,
							remoteBranch: 'unknown' as const,
							mergedIntoDefault: 'unknown' as const
						}))
					}))
		};
	});
	const reap = vi.fn(
		async (plan: WorkspaceReapPlan): Promise<WorkspaceReapResult> => ({
			dryRun: plan.policy.dryRun === true,
			removed: plan.remove.map((verdict) => ({ record: verdict.record, freedBytes: verdict.record.sizeBytes })),
			kept: plan.keep,
			removedPools: [],
			keptPools: plan.keepPools,
			freedBytes: plan.remove.reduce((sum, verdict) => sum + verdict.record.sizeBytes, 0),
			errors: []
		})
	);
	const deps: CliDeps = {
		io: {
			fetchFn: okFetch,
			runner,
			environment,
			logger,
			version: '0.1.0',
			diskProbe: { freeBytes: () => (options.freeBytes === undefined ? 50 * GIB : options.freeBytes) },
			...(options.scheduler ? { scheduler: options.scheduler } : {})
		},
		fs,
		configPath: CONFIG_PATH,
		platform: 'linux',
		out: (line) => stdout.push(line),
		secrets: null,
		workspaceHousekeeping: { scan, reap },
		now: () => NOW
	};
	return {
		deps,
		files,
		scan,
		reap,
		output: () => stdout.join('\n'),
		logged: () => entries.map((e) => e.message).join('\n')
	};
}

describe('disk floor flags', () => {
	it('start --min-free-disk reaches the runtime limits in bytes', async () => {
		runtimeCalls.options.length = 0;
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start', '--min-free-disk', '4096'], h.deps)).toBe(EXIT_OK);
		expect((runtimeCalls.options[0]?.limits as { minFreeDiskBytes?: number }).minFreeDiskBytes).toBe(4096 * MIB);
		// A process-only override, like --max-cpu: nothing was persisted.
		expect(h.files.get(CONFIG_PATH)).toBe(storedConfig);
	});

	it('start --no-disk-floor switches the floor off for this process', async () => {
		runtimeCalls.options.length = 0;
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		h.deps.waitForShutdown = () => Promise.resolve();

		// `--work`, because the limits banner is printed for a worker host only.
		expect(await runCli(['start', '--work', '--no-disk-floor'], h.deps)).toBe(EXIT_OK);
		expect((runtimeCalls.options[0]?.limits as { minFreeDiskBytes?: number | null }).minFreeDiskBytes).toBeNull();
		expect(h.output()).toContain('no disk floor');
	});

	it('refuses a floor below the minimum, a non-integer, and the two flags together', async () => {
		for (const argv of [
			['start', '--min-free-disk', '64'],
			['start', '--min-free-disk', '1.5'],
			['start', '--min-free-disk', '512', '--no-disk-floor']
		]) {
			const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
			h.deps.waitForShutdown = () => Promise.resolve();
			expect(await runCli(argv, h.deps)).toBe(EXIT_FAILURE);
		}
	});

	it('enroll persists the floor with the other limits', async () => {
		const h = harness();
		expect(
			await runCli(
				['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN, '--min-free-disk', '512'],
				h.deps
			)
		).toBe(EXIT_OK);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.limits?.minFreeDiskBytes).toBe(512 * MIB);
		expect(h.output()).toContain('disk floor 512 MiB');
	});

	it('status shows the default floor and the default reaper policy', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		expect(await runCli(['status'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('disk floor 2.0 GiB');
		expect(h.output()).toContain('workspace gc max age 14 d, no count budget');
	});
});

describe('workspace reaper policy flags', () => {
	it('start --workspace-max-age / --workspace-max-count are persisted and shown', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		h.deps.waitForShutdown = () => Promise.resolve();

		expect(await runCli(['start', '--workspace-max-age', '7', '--workspace-max-count', '25'], h.deps)).toBe(
			EXIT_OK
		);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.workspaceGc).toEqual({ maxAgeDays: 7, maxCount: 25 });
	});

	it('start without the flags leaves the stored policy alone', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		h.deps.waitForShutdown = () => Promise.resolve();
		expect(await runCli(['start'], h.deps)).toBe(EXIT_OK);
		expect(h.files.get(CONFIG_PATH)).toBe(storedConfig);
	});

	it('rejects an out-of-range max age as a usage error before the config is read', async () => {
		const h = harness();
		h.deps.waitForShutdown = () => Promise.resolve();
		expect(await runCli(['start', '--workspace-max-age', '0'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.logged()).toContain('--workspace-max-age must be between');
	});

	it('enroll --workspace-max-age persists the policy', async () => {
		const h = harness();
		expect(
			await runCli(
				['enroll', '--api-url', 'https://api.ever.works', '--token', TOKEN, '--workspace-max-age', '30'],
				h.deps
			)
		).toBe(EXIT_OK);
		expect(parseConfig(h.files.get(CONFIG_PATH) ?? null)?.workspaceGc).toEqual({ maxAgeDays: 30, maxCount: null });
		expect(h.output()).toContain('workspace gc max age 30 d');
	});

	it('start --work arms the reaper timer, runs it through the injected seams, and stops it on shutdown', async () => {
		const scheduler = recordingScheduler();
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			scheduler,
			inventory: inventory([record()])
		});
		h.deps.waitForShutdown = async () => {
			// Fire the reaper's first run before shutting down.
			scheduler.fire(DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS);
			await vi.waitFor(() => expect(h.reap).toHaveBeenCalledOnce());
		};

		expect(await runCli(['start', '--work', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		expect(scheduler.delays).toContain(DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS);
		expect(h.scan).toHaveBeenCalledWith('/srv/fleet', expect.objectContaining({ refreshRemote: true }));
		const plan = h.reap.mock.calls[0][0];
		expect(plan.remove).toHaveLength(1);
		expect(plan.policy.maxAgeMs).toBe(14 * DAY);
		expect(h.output()).toContain('Workspace reaper — max age 14 d, no count budget, root /srv/fleet');
	});

	it('start without --work runs no reaper', async () => {
		const scheduler = recordingScheduler();
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, scheduler });
		h.deps.waitForShutdown = () => Promise.resolve();
		expect(await runCli(['start'], h.deps)).toBe(EXIT_OK);
		expect(scheduler.delays).not.toContain(DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS);
		expect(h.scan).not.toHaveBeenCalled();
	});
});

describe('ever-works-node doctor', () => {
	const mixed = () =>
		inventory([
			record(),
			record({
				path: '/srv/fleet/repositories/r/worktrees/fleet-dirty',
				bindingKey: 'fleet-dirty',
				branch: 'task/dirty',
				dirty: true,
				lastUsedAt: NOW - 3 * DAY,
				sizeBytes: 120 * MIB
			})
		]);

	it('reports the floor, the root, the counts and a verdict per worktree, and says BELOW FLOOR', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, freeBytes: 38 * MIB, inventory: mixed() });

		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		const out = h.output();
		expect(out).toContain(`enrolled     yes (node ${NODE_ID})`);
		expect(out).toContain('workspace    /srv/fleet');
		expect(out).toContain('disk free    38 MiB on the workspace volume (floor 2.0 GiB) — BELOW FLOOR');
		expect(out).toContain('workspace gc max age 14 d, no count budget');
		expect(out).toContain('workspaces   2 worktree(s), 0 pool(s), 420 MiB, oldest unused for 30 d');
		expect(out).toMatch(/REMOVE\s+fleet-abc\s+task\/abc\s+30 d\s+300 MiB\s+clean, branch gone from the remote/);
		expect(out).toMatch(/KEEP\s+fleet-dirty\s+task\/dirty\s+3 d\s+120 MiB\s+uncommitted changes/);
		expect(out).toContain('gc would remove 1 worktree(s) and 0 pool(s) (300 MiB), keep 1 worktree(s)');
		expect(h.reap).not.toHaveBeenCalled();
	});

	it('works when the machine is not enrolled, with the defaults', async () => {
		const h = harness({ freeBytes: 10 * GIB });
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('enrolled     no — defaults apply');
		expect(h.output()).toContain('disk free    10.0 GiB on the workspace volume (floor 2.0 GiB)');
	});

	it('honours --max-age and --offline for the verdicts without touching the config', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, inventory: mixed() });
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet', '--max-age', '60'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('gc would remove 0 worktree(s)');
		expect(h.files.get(CONFIG_PATH)).toBe(storedConfig);

		const offline = harness({ files: { [CONFIG_PATH]: storedConfig }, inventory: mixed() });
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet', '--offline'], offline.deps)).toBe(EXIT_OK);
		expect(offline.scan).toHaveBeenCalledWith('/srv/fleet', expect.objectContaining({ refreshRemote: false }));
		expect(offline.output()).toContain('(offline: nothing is removable)');
		expect(offline.output()).toContain('remote state unknown');
	});

	it('keeps workspaces without a usage record while a worker-session marker exists', async () => {
		const h = harness({
			files: {
				[CONFIG_PATH]: storedConfig,
				[workerSafetyMarkerPath(CONFIG_PATH)]: JSON.stringify({
					version: 1,
					sessionId: 'live',
					since: '2026-09-05T11:00:00.000Z'
				})
			},
			inventory: inventory([record({ hasUsageRecord: false })])
		});
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('worker       session marker present');
		expect(h.output()).toContain('no usage record while a worker session may be active');
	});

	it('--json emits one machine-readable object', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, freeBytes: 38 * MIB, inventory: mixed() });
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet', '--json'], h.deps)).toBe(EXIT_OK);
		const parsed = JSON.parse(h.output()) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			enrolled: true,
			workspaceRoot: '/srv/fleet',
			diskFreeBytes: 38 * MIB,
			minFreeDiskBytes: 2 * GIB,
			belowFloor: true,
			workspaceGc: { maxAgeDays: 14, maxCount: null },
			reclaimableBytes: 300 * MIB
		});
		expect(parsed.remove).toEqual([expect.objectContaining({ bindingKey: 'fleet-abc', branch: 'task/abc' })]);
		expect(parsed.keep).toEqual([
			expect.objectContaining({ bindingKey: 'fleet-dirty', reason: 'uncommitted changes' })
		]);
	});

	it('rejects a relative --workspace-root as a usage error', async () => {
		const h = harness();
		expect(await runCli(['doctor', '--workspace-root', 'relative/dir'], h.deps)).toBe(EXIT_FAILURE);
	});

	it('explains an unreadable volume, in both floor states (review AO-13)', async () => {
		// This line is the only place `doctor` explains why jobs are being
		// deferred on a machine with no visible disk problem, and neither of
		// its two branches was executed by any test. Both halves matter and
		// they differ: with a floor in force the node refuses at the lease
		// AND at provision; with the floor switched off nothing refuses.
		const withFloor = harness({ files: { [CONFIG_PATH]: storedConfig }, freeBytes: null });
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], withFloor.deps)).toBe(EXIT_OK);
		expect(withFloor.output()).toContain(
			'disk free    unknown on the workspace volume (floor 2.0 GiB) — this node will not lease or provision'
		);

		const noFloor = harness({
			files: {
				[CONFIG_PATH]: JSON.stringify({
					...(JSON.parse(storedConfig) as Record<string, unknown>),
					limits: { maxConcurrentJobs: 1, maxCpuPercent: null, maxMemoryMb: null, minFreeDiskBytes: null }
				})
			},
			freeBytes: null
		});
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], noFloor.deps)).toBe(EXIT_OK);
		expect(noFloor.output()).toContain('disk free    unknown on the workspace volume (no floor)');
		expect(noFloor.output()).not.toContain('will not lease');
	});

	it('inspects the root the SERVICE recorded, and says where the root came from (review AO-6)', async () => {
		// `doctor` and `gc` resolved the root independently of the running
		// node — flag, else `homedir()`. The Windows installer's preflight
		// ERRORS unless the operator passes an explicit `-WorkspaceRoot`, and the
		// service runs as its own account, so an admin following the disk
		// refusal's own advice landed on an empty directory in their profile
		// and was told `0 worktree(s), 0 B` about a machine whose real root
		// was full and refusing every job.
		const started = harness({ files: { [CONFIG_PATH]: storedConfig } });
		started.deps.waitForShutdown = () => Promise.resolve();
		expect(await runCli(['start', '--workspace-root', '/srv/fleet'], started.deps)).toBe(EXIT_OK);
		expect(parseConfig(started.files.get(CONFIG_PATH) ?? null)?.workspaceRoot).toBe('/srv/fleet');

		// Now `doctor`, with NO flag, on that same machine's config.
		const later = harness({
			files: { [CONFIG_PATH]: started.files.get(CONFIG_PATH) ?? '' },
			inventory: inventory([record()])
		});
		expect(await runCli(['doctor'], later.deps)).toBe(EXIT_OK);
		expect(later.scan).toHaveBeenCalledWith('/srv/fleet', expect.objectContaining({ refreshRemote: true }));
		expect(later.output()).toContain("workspace    /srv/fleet (from this node's last `start`)");
		// And `gc` reaps that tree, not a guess.
		const collected = harness({
			files: { [CONFIG_PATH]: started.files.get(CONFIG_PATH) ?? '' },
			inventory: inventory([record()])
		});
		expect(await runCli(['gc'], collected.deps)).toBe(EXIT_OK);
		expect(collected.scan.mock.calls[0][0]).toBe('/srv/fleet');
	});

	it('warns when the root is only a guess (review AO-6)', async () => {
		// Nothing recorded and no flag: the answer may be about a completely
		// different tree, and an operator reading "0 worktree(s)" has to be
		// able to tell that from "this machine is tidy".
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		expect(await runCli(['doctor'], h.deps)).toBe(EXIT_OK);
		expect(h.output()).toContain('(default — NOT recorded by any `start`');
		expect(h.output()).toContain('pass --workspace-root');

		// The flag says so too, so all three provenances are distinguishable.
		const flagged = harness({ files: { [CONFIG_PATH]: storedConfig } });
		expect(await runCli(['doctor', '--workspace-root', '/srv/fleet'], flagged.deps)).toBe(EXIT_OK);
		expect(flagged.output()).toContain('workspace    /srv/fleet (from --workspace-root)');
	});
});

describe('ever-works-node gc', () => {
	it('--dry-run scans and prints the plan but never calls the executor', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, inventory: inventory([record()]) });
		expect(await runCli(['gc', '--workspace-root', '/srv/fleet', '--dry-run'], h.deps)).toBe(EXIT_OK);
		expect(h.scan).toHaveBeenCalledOnce();
		expect(h.reap).not.toHaveBeenCalled();
		expect(h.output()).toContain('gc would remove 1 worktree(s)');
		expect(h.output()).toContain('Dry run — nothing was removed.');
	});

	it('runs the executor with the plan and reports what happened', async () => {
		const h = harness({
			files: { [CONFIG_PATH]: storedConfig },
			inventory: inventory([record(), record({ bindingKey: 'fleet-young', lastUsedAt: NOW - DAY })])
		});
		expect(await runCli(['gc', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_OK);
		expect(h.reap).toHaveBeenCalledOnce();
		expect(h.reap.mock.calls[0][0].remove.map((verdict) => verdict.record.bindingKey)).toEqual(['fleet-abc']);
		expect(h.output()).toContain('removed fleet-abc (300 MiB)');
		expect(h.output()).toContain('kept    fleet-young: used 24 h ago');
		expect(h.output()).toContain('Removed 1 worktree(s) and 0 pool(s), freed 300 MiB; kept 1 worktree(s).');
	});

	it('exits with a failure code when a removal errored, naming it', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, inventory: inventory([record()]) });
		h.reap.mockImplementationOnce(async (plan) => ({
			dryRun: false,
			removed: [],
			kept: plan.remove.map((verdict) => ({
				record: verdict.record,
				reason: 'removal failed: git worktree remove exited 128'
			})),
			removedPools: [],
			keptPools: [],
			freedBytes: 0,
			errors: [`${plan.remove[0].record.path}: removal failed: git worktree remove exited 128`]
		}));
		expect(await runCli(['gc', '--workspace-root', '/srv/fleet'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.logged()).toContain('1 removal(s) failed');
		expect(h.logged()).toContain('git worktree remove exited 128');
	});

	it('--max-age and --max-count override the stored policy for this run only', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig }, inventory: inventory([record()]) });
		expect(
			await runCli(['gc', '--workspace-root', '/srv/fleet', '--max-age', '45', '--max-count', '3'], h.deps)
		).toBe(EXIT_OK);
		expect(h.reap.mock.calls[0][0].policy).toMatchObject({ maxAgeMs: 45 * DAY, maxCount: 3 });
		expect(h.reap.mock.calls[0][0].remove).toHaveLength(0);
		expect(h.files.get(CONFIG_PATH)).toBe(storedConfig);
	});

	it('rejects a zero max age and an unknown flag', async () => {
		const h = harness({ files: { [CONFIG_PATH]: storedConfig } });
		expect(await runCli(['gc', '--max-age', '0'], h.deps)).toBe(EXIT_FAILURE);
		expect(await runCli(['gc', '--force'], h.deps)).toBe(EXIT_FAILURE);
		expect(h.reap).not.toHaveBeenCalled();
	});
});
