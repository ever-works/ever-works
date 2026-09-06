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
