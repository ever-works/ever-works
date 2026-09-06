import { describe, expect, it, vi } from 'vitest';
import type { CapabilityEnvironment, CommandRunner } from './capabilities';
import type { FetchLike } from './fleet-client';
import { createLogger, type LogEntry } from './logger';
import {
	buildSelfDescriptionTelemetry,
	clampHeartbeatInterval,
	createNodeRuntime,
	enrollNode,
	installShutdownHandlers
} from './runtime';
import { PUBLISH_FENCE_MARGIN_MS } from './worker-loop';
import {
	clampResourceLimits,
	DEFAULT_HEARTBEAT_INTERVAL_MS,
	MAX_HEARTBEAT_INTERVAL_MS,
	MIN_HEARTBEAT_INTERVAL_MS,
	type NodeConfig
} from './types';

const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const NODE_ID = '11111111-2222-4333-8444-555555555555';

const environment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

const runner: CommandRunner = {
	run: async (command) =>
		command === 'git' ? { code: 0, stdout: 'git version 2.4', stderr: '' } : { code: 127, stdout: '', stderr: '' }
};

function io(fetchFn: FetchLike) {
	const entries: LogEntry[] = [];
	const logger = createLogger({ sink: (entry) => entries.push(entry) });
	return { entries, logger, io: { fetchFn, runner, environment, logger, version: '0.1.0' } };
}

function enrollResponse(body: unknown, status = 201): FetchLike {
	return async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
}

const nodeFromApi = {
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

describe('clampHeartbeatInterval', () => {
	it('defaults, floors and ceilings the operator-supplied cadence', () => {
		expect(clampHeartbeatInterval(undefined)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(Number.NaN)).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(1)).toBe(MIN_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(99_999_999)).toBe(MAX_HEARTBEAT_INTERVAL_MS);
		expect(clampHeartbeatInterval(30_000)).toBe(30_000);
	});
});

describe('buildSelfDescriptionTelemetry — model identity (fleet cost accounting, EW-777)', () => {
	it('asks the SAME claude-code binary the agent-task step spawns which seat it is logged in as', async () => {
		const run = vi.fn(async (command: string, args: string[]) => {
			if (command === '/opt/claude' && args[0] === 'auth') {
				return { code: 0, stdout: JSON.stringify({ loggedIn: true, email: 'ops@example.com' }), stderr: '' };
			}
			return { code: 127, stdout: '', stderr: '' };
		});
		const telemetry = buildSelfDescriptionTelemetry({
			...io(async () => ({ ok: true, status: 200, text: async () => '{}' })).io,
			runner: { run },
			environment: { ...environment, modelCli: { 'claude-code': '/opt/claude' } }
		});

		await expect(telemetry.modelIdentity?.()).resolves.toBe('claude-code: ops@example.com');
		expect(run).toHaveBeenCalledWith('/opt/claude', ['auth', 'status', '--json']);
	});

	it('does not spawn the CLI on every beat — the reading is cached', async () => {
		const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' }));
		const telemetry = buildSelfDescriptionTelemetry({
			...io(async () => ({ ok: true, status: 200, text: async () => '{}' })).io,
			runner: { run }
		});

		await telemetry.modelIdentity?.();
		await telemetry.modelIdentity?.();
		await telemetry.modelIdentity?.();
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe('enrollNode', () => {
	it('detects capabilities, consumes the token and returns a persistable config', async () => {
		const { io: deps, entries } = io(enrollResponse({ nodeId: NODE_ID, secret: SECRET, node: nodeFromApi }));

		const config = await enrollNode({
			...deps,
			apiUrl: 'https://api.ever.works/',
			token: TOKEN,
			kind: 'node',
			now: () => Date.parse('2026-07-25T10:00:00.000Z')
		});

		expect(config).toEqual<NodeConfig>({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux', 'arch:x64', 'node:22', 'terminal', 'workspace', 'git'],
			name: 'build-box-01',
			heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
			enrolledAt: '2026-07-25T10:00:00.000Z',
			// Enrollment writes the clamped limits so the very first run
			// already has a capacity policy on disk rather than inheriting
			// an implicit default that later drifts.
			limits: clampResourceLimits(undefined)
		});

		// The whole enrollment conversation is logged — with neither credential in it.
		const text = entries.map((entry) => entry.message).join('\n');
		expect(text).toContain(`Enrolled as node ${NODE_ID}`);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(SECRET);
	});

	it('prefers an explicit local label over the platform-assigned name', async () => {
		const { io: deps } = io(enrollResponse({ nodeId: NODE_ID, secret: SECRET, node: nodeFromApi }));
		const config = await enrollNode({
			...deps,
			apiUrl: 'https://api.ever.works',
			token: TOKEN,
			kind: 'desktop-node',
			name: '  my-laptop  ',
			heartbeatIntervalMs: 30_000
		});

		expect(config.name).toBe('my-laptop');
		expect(config.kind).toBe('desktop-node');
		expect(config.heartbeatIntervalMs).toBe(30_000);
	});

	it('propagates an invalid token as an unauthorized FleetClientError', async () => {
		const { io: deps } = io(enrollResponse({ message: 'Invalid or expired enrollment token' }, 401));

		await expect(
			enrollNode({ ...deps, apiUrl: 'https://api.ever.works', token: TOKEN, kind: 'node' })
		).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
	});
});

describe('createNodeRuntime', () => {
	it('wires the durable worker safety gate through startup and safe shutdown', async () => {
		const { io: deps } = io(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ jobs: [] })
		}));
		const safetyGate = {
			acquire: vi.fn(async () => ({ kind: 'acquired' as const, sessionId: 'runtime-session' })),
			release: vi.fn(async () => undefined),
			inspect: vi.fn(async () => null),
			clear: vi.fn(async () => undefined)
		};
		const runtime = createNodeRuntime(
			{
				apiUrl: 'https://api.ever.works',
				nodeId: NODE_ID,
				secret: SECRET,
				kind: 'node',
				capabilities: ['os:linux'],
				heartbeatIntervalMs: 30_000,
				enrolledAt: '2026-07-25T10:00:00.000Z'
			} as NodeConfig,
			deps,
			{ workerEnabled: true, workerSafetyGate: safetyGate }
		);

		await runtime.worker?.start();
		expect(safetyGate.acquire).toHaveBeenCalledOnce();
		await runtime.worker?.stop();
		expect(safetyGate.release).toHaveBeenCalledWith('runtime-session');
	});

	it('restores a persisted unsafe quarantine before the worker can make a lease request', async () => {
		const requests: string[] = [];
		const { io: deps } = io(async (url) => {
			requests.push(url);
			return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
		});
		const config = {
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z',
			unsafe: { since: '2026-08-22T23:00:00.000Z', reason: 'unverified process tree' }
		} as NodeConfig;

		const runtime = createNodeRuntime(config, deps, { workerEnabled: true });
		await runtime.worker?.start();
		expect(runtime.worker?.getState()).toMatchObject({ state: 'unsafe', lastError: 'unverified process tree' });
		expect(requests).toEqual([]);
		await runtime.worker?.stop();
	});

	/**
	 * Fleet health signals (EW-776) — end to end on the node side.
	 *
	 * The wiring is the risky part, not the mapping: `describe` is closed
	 * over the telemetry object at line ~345, BEFORE the worker loop is
	 * constructed. A naive "pass the worker into describeSelf" would have
	 * required reordering that construction, and the heartbeat would have
	 * silently reported nothing. So these drive the REAL beat body.
	 */
	describe('worker state on the heartbeat', () => {
		const beatBodies = (bodies: Record<string, unknown>[]): FetchLike => {
			return async (url, init) => {
				if (url.endsWith('/api/fleet/heartbeat')) {
					bodies.push(JSON.parse(init.body) as Record<string, unknown>);
					return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, node: nodeFromApi }) };
				}
				return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
			};
		};

		const baseConfig = (over: Partial<NodeConfig> = {}): NodeConfig => ({
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z',
			...over
		});

		it('reports a restored quarantine, with the reason that was persisted', async () => {
			// The whole defect, in one test: a machine whose durable safety
			// marker survived a restart used to beat as a healthy, idle
			// `online` node while refusing every job.
			const bodies: Record<string, unknown>[] = [];
			const { io: deps } = io(beatBodies(bodies));
			const runtime = createNodeRuntime(
				baseConfig({
					unsafe: { since: '2026-08-22T23:00:00.000Z', reason: 'unverified process tree' }
				}),
				deps,
				{ workerEnabled: true }
			);

			await runtime.loop.start();
			runtime.loop.stop();

			expect(bodies[0].workerState).toBe('quarantined');
			expect(bodies[0].workerStateReason).toBe('unverified process tree');
		});

		it('reports a node started drained as paused', async () => {
			const bodies: Record<string, unknown>[] = [];
			const { io: deps } = io(beatBodies(bodies));
			const runtime = createNodeRuntime(baseConfig(), deps, {
				workerEnabled: true,
				startPaused: true
			});

			await runtime.loop.start();
			runtime.loop.stop();

			expect(bodies[0].workerState).toBe('paused');
		});

		it('reports idle for a worker that is simply up', async () => {
			const bodies: Record<string, unknown>[] = [];
			const { io: deps } = io(beatBodies(bodies));
			const runtime = createNodeRuntime(baseConfig(), deps, { workerEnabled: true });

			await runtime.loop.start();
			runtime.loop.stop();

			expect(bodies[0].workerState).toBe('idle');
			expect(bodies[0]).not.toHaveProperty('workerStateReason');
		});

		it('reports NOTHING on a visibility-only node with no worker', async () => {
			// Absent, not `idle`: there is no worker, so there is no
			// capacity, and the platform shows "unknown" rather than a
			// fabricated readiness.
			const bodies: Record<string, unknown>[] = [];
			const { io: deps } = io(beatBodies(bodies));
			const runtime = createNodeRuntime(baseConfig(), deps);

			await runtime.loop.start();
			runtime.loop.stop();

			expect(bodies[0]).not.toHaveProperty('workerState');
			expect(bodies[0]).not.toHaveProperty('workerStateReason');
			// The rest of the description is unaffected.
			expect(bodies[0].platform).toBe('linux/x64');
		});
	});

	it('points every client at the pinned control plane, and warns when the pin is not the enrolled origin', async () => {
		// EW-779. A broken `develop` must not be able to orphan the fleet: an
		// operator sets EVER_WORKS_NODE_API_URL, restarts, and both the
		// heartbeat and the job channel move together — they are resolved ONCE
		// so they can never end up on different platforms.
		const { io: deps, entries } = io(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, node: nodeFromApi })
		}));
		const config: NodeConfig = {
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		};

		const runtime = createNodeRuntime(config, deps, {
			workerEnabled: true,
			env: { EVER_WORKS_NODE_API_URL: 'https://apistage.ever.works/' }
		});

		expect(runtime.client.baseUrl).toBe('https://apistage.ever.works');
		const logged = entries.map((entry) => entry.message).join('\n');
		expect(logged).toContain('Control plane: https://apistage.ever.works');
		// The pin does not match the origin the secret was minted against, so
		// every call will 401 — said out loud rather than left to a retry loop.
		expect(logged).toContain('401');
		// And the pin is never written back: unsetting the variable must be
		// enough to undo it.
		expect(config.apiUrl).toBe('https://api.ever.works');
		await runtime.worker?.stop();
	});

	it('falls back to the enrolled origin when nothing is pinned', async () => {
		const { io: deps, entries } = io(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, node: nodeFromApi })
		}));
		const config: NodeConfig = {
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		};

		const runtime = createNodeRuntime(config, deps, { env: {} });
		expect(runtime.client.baseUrl).toBe('https://api.ever.works');
		expect(entries.map((entry) => entry.message).join('\n')).toContain('from the enrolled config');
	});

	it('wires a client and a loop against the stored config, protecting the secret', async () => {
		const {
			io: deps,
			entries,
			logger
		} = io(async () => ({
			ok: true,
			status: 200,
			text: async () => JSON.stringify({ ok: true, node: nodeFromApi })
		}));

		const config: NodeConfig = {
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		};

		const runtime = createNodeRuntime(config, deps);
		expect(runtime.client.baseUrl).toBe('https://api.ever.works');

		await runtime.loop.start();
		runtime.loop.stop();

		expect(runtime.loop.getState().node).toMatchObject({ id: NODE_ID });

		logger.info(`secret is ${SECRET}`);
		expect(entries.map((entry) => entry.message).join('\n')).not.toContain(SECRET);
	});

	it('wires the repository provisioner into agent-task before command execution', async () => {
		const completedBodies: Record<string, unknown>[] = [];
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
		const provisionWorkspace = vi.fn().mockResolvedValue(descriptor);
		const fetchFn: FetchLike = async (url, init) => {
			if (url.endsWith('/api/fleet/jobs/lease')) {
				const jobs = leased
					? []
					: [
							{
								id: 'job-workspace-1',
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
				completedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, job: {} }) };
			}
			throw new Error(`unexpected request: ${url}`);
		};
		const { io: deps } = io(fetchFn);
		const scheduler = {
			setTimeout: () => ({ scheduled: true }),
			clearTimeout: () => undefined
		};
		const config: NodeConfig = {
			apiUrl: 'https://api.ever.works',
			nodeId: NODE_ID,
			secret: SECRET,
			kind: 'node',
			capabilities: ['os:linux'],
			heartbeatIntervalMs: 30_000,
			enrolledAt: '2026-07-25T10:00:00.000Z'
		};

		const runtime = createNodeRuntime(
			config,
			{ ...deps, scheduler },
			{
				workerEnabled: true,
				workspaceProvisioner: { provision: provisionWorkspace }
			}
		);
		await runtime.worker?.start();
		await runtime.worker?.drained();
		await runtime.worker?.stop();

		expect(provisionWorkspace).toHaveBeenCalledWith('task-1', repositoryWorkspace, expect.any(AbortSignal));
		expect(completedBodies).toHaveLength(1);
		expect(completedBodies[0]).toMatchObject({ success: true, result: { workspace: descriptor } });
	});
});

/**
 * The join between the lease and the publish fence.
 *
 * This is the only place in production where a live `JobLeaseHandle`
 * becomes the `WorkspacePublishFence` a Git provider fences a push
 * against, and it is a closure — nothing downstream can prove it was
 * built correctly. Swap its two fields and every other suite in the
 * repository still passes while every publish on every node is withheld
 * forever; freeze the deadline at job start and long runs refuse instead.
 * So the closure is exercised here against a real worker loop, a real
 * lease and a real HTTP transport, with only the executor stubbed.
 */
describe('createNodeRuntime — agent-task publish fence', () => {
	const LEASED_AT = Date.parse('2026-09-04T09:00:00.000Z');

	interface FenceHarness {
		fetches: string[];
		completedBodies: Record<string, unknown>[];
		heartbeatExpiry: string;
	}

	/**
	 * Runs ONE leased `agent-task` job through the real runtime with the
	 * executor replaced, and hands `run` whatever io the runtime built.
	 */
	async function withStubbedExecutor(
		run: (io: Record<string, unknown>, harness: FenceHarness) => Promise<void>
	): Promise<FenceHarness> {
		const harness: FenceHarness = {
			fetches: [],
			completedBodies: [],
			heartbeatExpiry: new Date(LEASED_AT + 120_000).toISOString()
		};
		let leased = false;
		const fetchFn: FetchLike = async (url, init) => {
			harness.fetches.push(url);
			if (url.endsWith('/api/fleet/jobs/lease')) {
				const jobs = leased
					? []
					: [
							{
								id: 'job-fence-1',
								kind: 'agent-task',
								status: 'leased',
								nodeId: NODE_ID,
								requiredCapabilities: [],
								payload: { taskId: 'task-fence', steps: [] },
								leaseExpiresAt: new Date(LEASED_AT + 60_000).toISOString(),
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
			if (url.endsWith('/heartbeat')) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							ok: true,
							job: {
								id: 'job-fence-1',
								kind: 'agent-task',
								status: 'running',
								nodeId: NODE_ID,
								requiredCapabilities: [],
								payload: {},
								leaseExpiresAt: harness.heartbeatExpiry,
								attempts: 1,
								maxAttempts: 3,
								createdAt: null,
								startedAt: null,
								completedAt: null
							}
						})
				};
			}
			if (url.endsWith('/complete')) {
				harness.completedBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
				return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, job: {} }) };
			}
			throw new Error(`unexpected request: ${url}`);
		};

		vi.resetModules();
		vi.doMock('./executors/agent-task', () => ({
			runAgentTaskJob: async (_job: unknown, agentIo: Record<string, unknown>) => {
				await run(agentIo, harness);
				return {};
			}
		}));
		try {
			const { createNodeRuntime: create } = await import('./runtime');
			const { io: deps } = io(fetchFn);
			const config: NodeConfig = {
				apiUrl: 'https://api.ever.works',
				nodeId: NODE_ID,
				secret: SECRET,
				kind: 'node',
				capabilities: ['os:linux'],
				heartbeatIntervalMs: 30_000,
				enrolledAt: '2026-07-25T10:00:00.000Z'
			};
			const runtime = create(
				config,
				{
					...deps,
					scheduler: { setTimeout: () => ({ scheduled: true }), clearTimeout: () => undefined },
					// Both clocks frozen at the instant the job was leased, so
					// the deadline the fence reports is exact rather than
					// "whatever this machine took to get here".
					now: () => LEASED_AT,
					monotonicNow: () => LEASED_AT
				},
				{ workerEnabled: true, workspaceProvisioner: { provision: vi.fn() } }
			);
			await runtime.worker?.start();
			await runtime.worker?.drained();
			await runtime.worker?.stop();
		} finally {
			// NOT `vi.doUnmock` here. In vitest 4 both doMock and doUnmock are
			// fire-and-forget: each queues a DIFFERENT RPC and applies its side
			// effect in completion order, not call order. So this teardown's
			// pending unmock could land AFTER the next test's doMock and delete
			// the stub it had just registered — the dynamic import then bound the
			// REAL runAgentTaskJob, which throws AgentTaskPayloadError on the
			// harness's stepless payload, so the loop POSTed /complete and
			// `completedBodies` was non-empty. Failed ~1 run in 4 locally, and
			// reddened lint-and-test on stage, develop and main at random.
			//
			// Dropping it is safe: resetModules() below discards the module graph,
			// and the next withStubbedExecutor call issues its own doMock for this
			// same path, which replaces the registration outright.
			vi.resetModules();
		}
		return harness;
	}

	it('resolves the fence from the LIVE claim, re-confirming it with the platform first', async () => {
		let first: unknown;
		let second: unknown;
		let heartbeatsBeforeFirst = 0;
		const harness = await withStubbedExecutor(async (agentIo, live) => {
			const publishFence = agentIo.publishFence as () => Promise<{ deadlineAt: number; marginMs: number }>;
			heartbeatsBeforeFirst = live.fetches.filter((url) => url.endsWith('/heartbeat')).length;
			first = await publishFence();
			// A second renewal, further out. A fence that captured the
			// deadline once — at job start, say — would still report the old
			// one and refuse every run longer than a lease.
			live.heartbeatExpiry = new Date(LEASED_AT + 200_000).toISOString();
			second = await publishFence();
		});

		// The deadline is the RENEWED expiry, not the one the job arrived
		// with (LEASED_AT + 60_000), and the margin is the loop's clamped
		// publish budget — not the deadline, and not the other way round.
		expect(heartbeatsBeforeFirst).toBe(0);
		expect(first).toEqual({ deadlineAt: LEASED_AT + 120_000, marginMs: PUBLISH_FENCE_MARGIN_MS });
		expect(second).toEqual({ deadlineAt: LEASED_AT + 200_000, marginMs: PUBLISH_FENCE_MARGIN_MS });
		expect(harness.fetches.filter((url) => url.endsWith('/heartbeat'))).toHaveLength(2);
	});

	it('reports nothing to the platform when the run withheld its publish', async () => {
		const harness = await withStubbedExecutor(async (agentIo) => {
			(agentIo.onPublishWithheld as (reason: string) => void)(
				'the lease on this work expired 12s ago; the platform may already have re-offered it'
			);
		});

		// NOT `success: true` with a failed result, and not `success: false`
		// either: both are terminal on the platform, and the agent's commit is
		// still only on this machine. Silence lets the claim lapse so
		// `reclaimExpired` re-offers the job and the branch still gets pushed.
		expect(harness.completedBodies).toEqual([]);
		expect(harness.fetches.some((url) => url.endsWith('/complete'))).toBe(false);
	});
});

describe('installShutdownHandlers', () => {
	it('registers both signals and runs the shutdown exactly once', () => {
		const handlers = new Map<string, () => void>();
		const shutdown = vi.fn();

		installShutdownHandlers({ on: (signal, handler) => handlers.set(signal, handler) }, shutdown);

		expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);

		handlers.get('SIGINT')?.();
		handlers.get('SIGINT')?.();
		handlers.get('SIGTERM')?.();

		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});
