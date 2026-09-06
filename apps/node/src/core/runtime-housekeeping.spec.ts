import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike } from './fleet-client';
import { createLogger } from './logger';
import { createNodeRuntime } from './runtime';
import { clampResourceLimits, type NodeConfig } from './types';

/**
 * Disk floor wiring (self-build program note §6, OPS-12).
 *
 * `diskFreeBytes` used to be heart-beated and consulted by nothing. These
 * tests pin the three places the composition root now routes the disk
 * probe to: the heartbeat (measured on the WORKSPACE volume), the worker
 * loop's admission gate, and the provisioner's pre-provision re-check —
 * plus the release hook the executor needs to hand a worktree back.
 */

const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

const runner: CommandRunner = {
	run: async () => ({ code: 127, stdout: '', stderr: '' })
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

const config: NodeConfig = {
	apiUrl: 'https://api.ever.works',
	nodeId: NODE_ID,
	secret: SECRET,
	kind: 'node',
	capabilities: ['os:linux'],
	heartbeatIntervalMs: 30_000,
	enrolledAt: '2026-07-25T10:00:00.000Z',
	limits: clampResourceLimits({ maxConcurrentJobs: 1 })
};

const scheduler = { setTimeout: () => ({ scheduled: true }), clearTimeout: () => undefined };

function io(fetchFn: FetchLike) {
	const logger = createLogger({ sink: () => undefined });
	return { fetchFn, runner, environment, logger, version: '0.1.0', scheduler };
}

describe('createNodeRuntime — disk floor', () => {
	it('measures the heartbeat disk figure on the workspace root, not the service cwd', async () => {
		const bodies: Record<string, unknown>[] = [];
		const probed: string[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
			}
			throw new Error(`unexpected request: ${url}`);
		};
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-disk-'));
		try {
			const runtime = createNodeRuntime(
				config,
				{
					...io(fetchFn),
					diskProbe: {
						freeBytes: (path) => {
							probed.push(path);
							return 123 * 1024 ** 3;
						}
					}
				},
				{ agentTaskWorkspaceRoot: root }
			);
			await runtime.loop.start();
			runtime.loop.stop();

			expect(probed).toEqual([root]);
			expect(bodies[0]?.diskFreeBytes).toBe(123 * 1024 ** 3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('still reports a figure before the workspace root exists (review AO-8)', async () => {
		// The beat used the RAW probe while both gates used
		// `measureWorkspaceFreeBytes`, which walks to the nearest existing
		// ancestor. `statfs` on a missing path throws, so on every freshly
		// enrolled node — the root is not created until the first provision
		// — the beat omitted `diskFreeBytes` entirely while reporting
		// `minFreeDiskBytes` beside it. The drawer then showed a floor with
		// no reading to compare it against and could never say "below", on
		// exactly the machines whose lease gate was already enforcing
		// against the parent volume.
		const bodies: Record<string, unknown>[] = [];
		const probed: string[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		const parent = mkdtempSync(join(tmpdir(), 'ew-runtime-disk-absent-'));
		const root = join(parent, 'fleet-workspaces');
		try {
			const runtime = createNodeRuntime(
				config,
				{
					...io(fetchFn),
					diskProbe: {
						freeBytes: (path) => {
							probed.push(path);
							return 77 * 1024 ** 3;
						}
					}
				},
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			await runtime.loop.start();
			runtime.loop.stop();

			// Measured on the nearest EXISTING ancestor, exactly as the gates do.
			expect(probed).toContain(parent);
			expect(bodies[0]?.diskFreeBytes).toBe(77 * 1024 ** 3);
			// So the floor beside it now has something to be compared against.
			expect(bodies[0]?.minFreeDiskBytes).toBe(2 * 1024 ** 3);
			await runtime.worker?.stop();
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it('gates the lease on the workspace volume and exposes the root and provisioner to the shell', async () => {
		let leaseCalls = 0;
		const fetchFn: FetchLike = async (url) => {
			if (url.endsWith('/api/fleet/jobs/lease')) {
				leaseCalls += 1;
				return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-gate-'));
		try {
			const runtime = createNodeRuntime(
				config,
				{ ...io(fetchFn), diskProbe: { freeBytes: () => 100 * 1024 ** 2 } },
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			expect(runtime.workspaceRoot).toBe(root);
			expect(runtime.workspaceProvisioner).toBeDefined();

			await runtime.worker?.start();
			expect(leaseCalls).toBe(0);
			expect(runtime.worker?.getState().state).toBe('throttled');
			expect(runtime.worker?.getState().throttleReason).toContain('floor');
			await runtime.worker?.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('re-checks the floor in the provisioner, before any Git call, with the same limits', async () => {
		const fetchFn: FetchLike = async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, node: apiNode })
		});
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-provision-'));
		try {
			// 3 GiB free clears the default 2 GiB floor but not a 4 GiB one:
			// the provisioner must be built from the SAME effective limits.
			const runtime = createNodeRuntime(
				{ ...config, limits: clampResourceLimits({ maxConcurrentJobs: 1, minFreeDiskBytes: 4 * 1024 ** 3 }) },
				{ ...io(fetchFn), diskProbe: { freeBytes: () => 3 * 1024 ** 3 } },
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			await expect(
				runtime.workspaceProvisioner!.provision('task-1', {
					repositoryId: 'ever/repository',
					repoUrl: 'https://github.com/ever/repository.git',
					baseRef: 'develop',
					branch: 'task/example-12345678'
				})
			).rejects.toMatchObject({ code: 'disk-low' });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('hands the provisioner release hook to agent-task so a run gives its worktree back', async () => {
		let leased = false;
		const repositoryWorkspace = {
			repositoryId: 'ever/repository',
			repoUrl: 'https://github.com/ever/repository.git',
			baseRef: 'develop',
			branch: 'task/fleet-runtime-12345678'
		};
		const descriptor = {
			path: process.cwd(),
			repositoryId: repositoryWorkspace.repositoryId,
			baseRef: repositoryWorkspace.baseRef,
			branch: repositoryWorkspace.branch,
			baseSha: 'a'.repeat(40),
			headSha: 'b'.repeat(40),
			reused: false
		};
		const provision = vi.fn().mockResolvedValue(descriptor);
		const release = vi.fn(async () => undefined);
		const fetchFn: FetchLike = async (url) => {
			if (url.endsWith('/api/fleet/jobs/lease')) {
				const jobs = leased
					? []
					: [
							{
								id: 'job-release-1',
								kind: 'agent-task',
								status: 'leased',
								nodeId: NODE_ID,
								requiredCapabilities: [],
								payload: {
									taskId: 'task-1',
									workspace: repositoryWorkspace,
									steps: [{ id: 'node-version', command: 'node --version' }]
								},
								leaseExpiresAt: null,
								attempts: 1,
								maxAttempts: 3,
								createdAt: null,
								startedAt: null,
								completedAt: null
							}
						];
				leased = true;
				return { ok: true, status: 200, text: async () => JSON.stringify({ jobs }) };
			}
			if (url.endsWith('/complete')) {
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, job: {} }) };
			}
			throw new Error(`unexpected request: ${url}`);
		};

		const runtime = createNodeRuntime(config, io(fetchFn), {
			workerEnabled: true,
			workspaceProvisioner: { provision, release }
		});
		await runtime.worker?.start();
		await runtime.worker?.drained();
		await runtime.worker?.stop();

		expect(provision).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith('task-1', descriptor);
	});

	it('hands a job back unsettled when the provisioner refuses for disk, so the platform re-offers it', async () => {
		let leaseCalls = 0;
		const completions: string[] = [];
		const fetchFn: FetchLike = async (url) => {
			if (url.endsWith('/api/fleet/jobs/lease')) {
				leaseCalls += 1;
				const jobs =
					leaseCalls > 1
						? []
						: [
								{
									id: 'job-decline-1',
									kind: 'agent-task',
									status: 'leased',
									nodeId: NODE_ID,
									requiredCapabilities: [],
									payload: {
										taskId: 'task-1',
										workspace: {
											repositoryId: 'ever/repository',
											repoUrl: 'https://github.com/ever/repository.git',
											baseRef: 'develop',
											branch: 'task/fleet-decline-12345678'
										},
										steps: [{ id: 'node-version', command: 'node --version' }]
									},
									leaseExpiresAt: null,
									attempts: 1,
									maxAttempts: 3,
									createdAt: null,
									startedAt: null,
									completedAt: null
								}
							];
				return { ok: true, status: 200, text: async () => JSON.stringify({ jobs }) };
			}
			if (url.endsWith('/complete')) {
				completions.push(url);
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, job: {} }) };
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		// The gate admits on the first reading; the volume drops before the
		// provisioner re-checks — the exact window the re-check exists for.
		let readings = 0;
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-decline-'));
		try {
			const runtime = createNodeRuntime(
				config,
				{
					...io(fetchFn),
					diskProbe: { freeBytes: () => ((readings += 1) === 1 ? 10 * 1024 ** 3 : 100 * 1024 ** 2) }
				},
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			await runtime.worker?.start();
			await runtime.worker?.drained();
			await runtime.worker?.stop();

			expect(leaseCalls).toBe(1);
			expect(readings).toBe(2);
			// Neither `success: false` nor `success: true`: both are terminal on
			// the platform, and nothing about the WORK was learned here. The
			// claim lapses and `reclaimExpired` re-offers the job.
			expect(completions).toEqual([]);
			expect(runtime.worker?.getState().failed).toBe(1);
			expect(runtime.worker?.getState().lastError).toContain('floor');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

/**
 * Housekeeping reporting wiring (EW-803).
 *
 * The floor and the reaper's outcome were enforced on the machine and
 * invisible from the platform. These pin the composition root's half of
 * the fix: the reporter exists only where there is a worker to report
 * about, it reads the SAME effective floor the gates were built from, and
 * what it records reaches the actual heartbeat body.
 */
describe('createNodeRuntime — housekeeping reporting', () => {
	it('puts the effective floor on the heartbeat, matching the floor the gates enforce', async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-hk-floor-'));
		try {
			const runtime = createNodeRuntime(
				{ ...config, limits: clampResourceLimits({ maxConcurrentJobs: 1, minFreeDiskBytes: 4 * 1024 ** 3 }) },
				{ ...io(fetchFn), diskProbe: { freeBytes: () => 9 * 1024 ** 3 } },
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			await runtime.loop.start();
			runtime.loop.stop();

			// The number Fleet displays is the number this machine enforces,
			// not a second reading of the config that could drift from it.
			expect(bodies[0]?.minFreeDiskBytes).toBe(4 * 1024 ** 3);
			// Nothing has swept yet, so there is no reclaim to claim.
			expect(bodies[0]).not.toHaveProperty('lastReclaimAt');
			await runtime.worker?.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reports a recorded sweep on the NEXT beat', async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-hk-sweep-'));
		try {
			const runtime = createNodeRuntime(
				config,
				{ ...io(fetchFn), diskProbe: { freeBytes: () => 9 * 1024 ** 3 } },
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			expect(runtime.housekeeping).toBeDefined();
			// What the reaper timer hands over after a cycle.
			runtime.housekeeping!.record({
				dryRun: false,
				removed: [
					{ record: { path: '/w/gone', sizeBytes: 3 * 1024 ** 3 } as never, freedBytes: 3 * 1024 ** 3 }
				],
				kept: [{ record: { path: '/w/stays', sizeBytes: 1024 ** 3 } as never, reason: 'within the max age' }],
				removedPools: [],
				keptPools: [],
				freedBytes: 3 * 1024 ** 3,
				errors: []
			});

			await runtime.loop.start();
			runtime.loop.stop();

			expect(bodies[0]?.workspaceCount).toBe(1);
			expect(bodies[0]?.workspaceBytes).toBe(1024 ** 3);
			expect(bodies[0]?.lastReclaimFreedBytes).toBe(3 * 1024 ** 3);
			expect(typeof bodies[0]?.lastReclaimAt).toBe('string');
			await runtime.worker?.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reports NOTHING about housekeeping on a visibility-only node', async () => {
		// No worker means no floor in force and no reaper. Reporting a
		// floor there would claim a control that is not running.
		const bodies: Record<string, unknown>[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-hk-none-'));
		try {
			const runtime = createNodeRuntime(
				config,
				{ ...io(fetchFn), diskProbe: { freeBytes: () => 9 * 1024 ** 3 } },
				{ agentTaskWorkspaceRoot: root }
			);
			expect(runtime.housekeeping).toBeUndefined();

			await runtime.loop.start();
			runtime.loop.stop();

			expect(bodies[0]).not.toHaveProperty('minFreeDiskBytes');
			// The disk READING still travels — that half was never gated on
			// having a worker.
			expect(bodies[0]?.diskFreeBytes).toBe(9 * 1024 ** 3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reports an operator-disabled floor as an explicit null', async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-hk-off-'));
		try {
			const runtime = createNodeRuntime(
				{ ...config, limits: clampResourceLimits({ maxConcurrentJobs: 1, minFreeDiskBytes: null }) },
				{ ...io(fetchFn), diskProbe: { freeBytes: () => 9 * 1024 ** 3 } },
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			await runtime.loop.start();
			runtime.loop.stop();

			expect(bodies[0]).toHaveProperty('minFreeDiskBytes');
			expect(bodies[0]?.minFreeDiskBytes).toBeNull();
			await runtime.worker?.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reports NO floor when no disk probe is wired, because none is enforced (review AO-9)', async () => {
		// `diskProbe` is optional on `NodeIo`, and BOTH gates switch
		// themselves off without it — `wantsDisk` requires one and
		// `assertWorkspaceDiskHeadroom` returns before it measures. Reporting
		// `2 GiB` anyway put a control on the operator's screen that was
		// doing nothing: the drawer rendered "Above floor" for a node
		// leasing and provisioning with no free-space check at all.
		const bodies: Record<string, unknown>[] = [];
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/heartbeat')) {
				bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			}
			return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: apiNode }) };
		};
		const root = mkdtempSync(join(tmpdir(), 'ew-runtime-hk-noprobe-'));
		try {
			const runtime = createNodeRuntime(
				{ ...config, limits: clampResourceLimits({ maxConcurrentJobs: 1, minFreeDiskBytes: 4 * 1024 ** 3 }) },
				io(fetchFn),
				{ workerEnabled: true, agentTaskWorkspaceRoot: root }
			);
			await runtime.loop.start();
			runtime.loop.stop();

			// Null, not 4 GiB: "no floor in force" is the true statement, and
			// `hasFleetNodeHousekeeping` deliberately does not count a null
			// floor as a report, so the drawer says "not reported".
			expect(bodies[0]?.minFreeDiskBytes).toBeNull();
			// And no reading either, which is the honest pair.
			expect(bodies[0]).not.toHaveProperty('diskFreeBytes');
			await runtime.worker?.stop();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
