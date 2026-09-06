import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import { FleetClientError } from '../fleet-client';
import { runAgentTaskJob } from './agent-task';

/**
 * Run secrets in the executor (self-build slice Y, EW-781).
 *
 * Two properties are pinned here, and they are the two the whole slice
 * rests on:
 *
 *   1. **Deletion on EVERY exit path the process survives.** Success, a
 *      reported failure, a thrown model step, and an abort (an operator
 *      cancel and a lapsed lease both arrive as an aborted signal) all
 *      pass through the same `finally`. Modelled on
 *      `agent-task-release.spec.ts`, because it is the same seam.
 *   2. **Fail CLOSED.** A missing fetch seam, a refused fetch, or a
 *      response that is short of a file the job asked for stops the run
 *      before the model starts. A run with half its environment reports a
 *      red suite that looks like a code problem — the exact failure this
 *      feature exists to remove.
 *
 * Plus the sentinel: the value must never reach the reported outcome.
 */

const SENTINEL = 'sentinel-4e11-DATABASE_URL=postgres://u:p@db/app';
const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-1',
		kind: 'agent-task',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: payload as Record<string, unknown>,
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

function fakeSpawn(exitCodeByCommand: Record<string, number | null>) {
	return ((command: string) => {
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => {
			handlers.get('close')?.(command in exitCodeByCommand ? exitCodeByCommand[command] : 0);
		});
		return {
			stdout: { on: () => undefined, destroy: () => undefined },
			stderr: { on: () => undefined, destroy: () => undefined },
			on: (event: string, handler: (arg?: unknown) => void) => {
				handlers.set(event, handler);
			},
			kill: () => undefined
		};
	}) as never;
}

const ROW = '22222222-2222-4222-8222-222222222222';
const workspace = {
	repositoryId: 'ever/repository',
	repoUrl: 'https://github.com/ever/repository.git',
	baseRef: 'develop',
	branch: 'task/platform-task-12345678',
	envFilesRef: [{ repoConnectionId: ROW, paths: ['apps/api/.env'] }]
};
const descriptor = {
	path: ABSOLUTE,
	repositoryId: workspace.repositoryId,
	baseRef: workspace.baseRef,
	branch: workspace.branch,
	baseSha: 'a'.repeat(40),
	headSha: 'b'.repeat(40),
	reused: false
};

function io(overrides: Record<string, unknown> = {}) {
	return {
		directoryExists: (path: string) => path === ABSOLUTE,
		provisionWorkspace: vi.fn().mockResolvedValue(descriptor),
		fetchRunEnvFiles: vi
			.fn()
			.mockResolvedValue([{ repoConnectionId: ROW, path: 'apps/api/.env', content: SENTINEL }]),
		writeRunEnvFiles: vi.fn(async () => 1),
		removeRunEnvFiles: vi.fn(async () => 1),
		spawnFn: vi.fn(fakeSpawn({ passing: 0, failing: 1 }) as never),
		...overrides
	};
}

describe('runAgentTaskJob — run secrets', () => {
	it('fetches by REFERENCE and writes before the run, and deletes after a success', async () => {
		const deps = io();
		const outcome = await runAgentTaskJob(
			job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
			deps as never
		);

		expect(outcome.status).toBe('succeeded');
		// The request carries row ids and PATHS. Never a value, and never
		// the mountDir (that is node-local placement).
		expect(deps.fetchRunEnvFiles).toHaveBeenCalledWith([{ repoConnectionId: ROW, paths: ['apps/api/.env'] }]);
		expect(deps.writeRunEnvFiles).toHaveBeenCalledWith('task-1', descriptor, [
			{ path: 'apps/api/.env', content: SENTINEL }
		]);
		expect(deps.removeRunEnvFiles).toHaveBeenCalledWith('task-1', descriptor);
		// …and the value is nowhere in what the node reports back.
		expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
	});

	it('deletes after a FAILED run', async () => {
		const deps = io();
		const outcome = await runAgentTaskJob(
			job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'failing' }] }),
			deps as never
		);
		expect(outcome.status).toBe('failed');
		expect(deps.removeRunEnvFiles).toHaveBeenCalledWith('task-1', descriptor);
		expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
	});

	it('deletes when the model step THROWS', async () => {
		const deps = io({ modelCli: {} });
		await expect(
			runAgentTaskJob(
				job({
					taskId: 'task-1',
					workspace,
					execution: { provider: 'claude-code', instructions: '# do it' }
				}),
				deps as never
			)
		).rejects.toThrowError(/claude-code CLI/);
		expect(deps.removeRunEnvFiles).toHaveBeenCalledWith('task-1', descriptor);
	});

	it('deletes when the run is CANCELLED (an aborted signal — cancel or a lapsed lease)', async () => {
		// The cancel has to land AFTER the secrets are on disk, which is the
		// only interesting shape: an abort before provisioning leaves nothing
		// to clean up, and the executor already refuses at the top for it.
		const controller = new AbortController();
		const deps = io({
			writeRunEnvFiles: vi.fn(async () => {
				controller.abort();
				return 1;
			})
		});
		await expect(
			runAgentTaskJob(
				job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
				deps as never,
				controller.signal
			)
		).rejects.toThrow();
		expect(deps.removeRunEnvFiles).toHaveBeenCalledWith('task-1', descriptor);
	});

	it('deletes even when the WRITE itself failed half way', async () => {
		const deps = io({
			writeRunEnvFiles: vi.fn(async () => {
				throw new Error('EACCES');
			})
		});
		await expect(
			runAgentTaskJob(
				job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
				deps as never
			)
		).rejects.toThrow(/run-secrets-unavailable/);
		expect(deps.removeRunEnvFiles).toHaveBeenCalledWith('task-1', descriptor);
	});

	it('never lets a failed deletion change the verdict', async () => {
		const deps = io({
			removeRunEnvFiles: vi.fn(async () => {
				throw new Error('EBUSY');
			})
		});
		const outcome = await runAgentTaskJob(
			job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
			deps as never
		);
		expect(outcome.status).toBe('succeeded');
	});

	it('does nothing at all — not even a round trip — for a workspace that declares none', async () => {
		const deps = io();
		const { envFilesRef: _dropped, ...plain } = workspace;
		await runAgentTaskJob(
			job({ taskId: 'task-1', workspace: plain, steps: [{ id: 'run', command: 'passing' }] }),
			deps as never
		);
		expect(deps.fetchRunEnvFiles).not.toHaveBeenCalled();
		expect(deps.writeRunEnvFiles).not.toHaveBeenCalled();
	});

	it('fails CLOSED when the node has no way to fetch them', async () => {
		const deps = io({ fetchRunEnvFiles: undefined });
		await expect(
			runAgentTaskJob(
				job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
				deps as never
			)
		).rejects.toThrow(/run-secrets-unavailable/);
		// The model/steps never ran.
		expect(deps.spawnFn).not.toHaveBeenCalled();
	});

	it('fails CLOSED when the platform refuses to resolve the reference', async () => {
		const deps = io({
			fetchRunEnvFiles: vi.fn(async () => {
				throw new FleetClientError('unresolved', 'The platform could not resolve …', 422);
			})
		});
		await expect(
			runAgentTaskJob(
				job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
				deps as never
			)
		).rejects.toThrow(/run-secrets-unavailable/);
		expect(deps.writeRunEnvFiles).not.toHaveBeenCalled();
	});

	it('lets a STALE LEASE keep its own identity, so the worker does not report a failure', async () => {
		const stale = new FleetClientError('stale-lease', 'newer lease', 409);
		const deps = io({ fetchRunEnvFiles: vi.fn(async () => Promise.reject(stale)) });
		await expect(
			runAgentTaskJob(
				job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
				deps as never
			)
		).rejects.toBe(stale);
	});

	it('fails CLOSED when the response is short of a file the job asked for', async () => {
		const deps = io({
			fetchRunEnvFiles: vi.fn(async () => [])
		});
		await expect(
			runAgentTaskJob(
				job({
					taskId: 'task-1',
					workspace: {
						...workspace,
						envFilesRef: [{ repoConnectionId: ROW, paths: ['apps/api/.env', '.env'] }]
					},
					steps: [{ id: 'run', command: 'passing' }]
				}),
				deps as never
			)
		).rejects.toThrow(/run-secrets-unresolved/);
		expect(deps.writeRunEnvFiles).not.toHaveBeenCalled();
	});

	it('places a mount reference into the mount it names', async () => {
		const mountRef = { repoConnectionId: ROW, mountDir: 'api', paths: ['.env'] };
		const deps = io({
			fetchRunEnvFiles: vi.fn().mockResolvedValue([{ repoConnectionId: ROW, path: '.env', content: SENTINEL }])
		});
		await runAgentTaskJob(
			job({
				taskId: 'task-1',
				workspace: { ...workspace, envFilesRef: [mountRef] },
				steps: [{ id: 'run', command: 'passing' }]
			}),
			deps as never
		);
		// The fetch does NOT carry the mountDir — the platform has no
		// business knowing the node's on-disk layout — but the write does.
		expect(deps.fetchRunEnvFiles).toHaveBeenCalledWith([{ repoConnectionId: ROW, paths: ['.env'] }]);
		expect(deps.writeRunEnvFiles).toHaveBeenCalledWith('task-1', descriptor, [
			{ mountDir: 'api', path: '.env', content: SENTINEL }
		]);
	});
});

/**
 * The grant has to reach the ACCEPTANCE CHECKS, not only the model.
 *
 * `pnpm test` needing `DATABASE_URL` is the concrete thing this slice
 * exists to unblock, and the checks are frozen from the Task, so they can
 * never carry a grant of their own. And because a failing check prints
 * its connection string, the value has to come back OUT of the log tail
 * before the result is reported.
 */
describe('runAgentTaskJob — run env grants reach every command of the run', () => {
	const GRANTED_VALUE = 'postgres://user:s3cr3t-value-here@db.internal/app';
	const CLAUDE = process.platform === 'win32' ? String.raw`C:\cli\claude.exe` : '/usr/local/bin/claude';

	const SCRATCH = process.platform === 'win32' ? String.raw`C:\scratch` : '/tmp/ew-scratch';

	/** In-memory scratch, so the model step runs without touching a disk. */
	const scratchFs = () => ({
		createScratchDir: async (root: string, prefix: string) => join(root, prefix),
		writeFile: async () => undefined,
		readFile: async () => null,
		remove: async () => undefined
	});

	/** Spawn double that echoes `value` on stdout and exits nonzero. */
	function spawnEchoing(value: string) {
		return vi.fn(((_command: string) => {
			const handlers = new Map<string, (arg?: unknown) => void>();
			const stdoutHandlers = new Map<string, (chunk: Buffer) => void>();
			queueMicrotask(() => {
				stdoutHandlers.get('data')?.(
					Buffer.from(`connecting to ${value}
`)
				);
				handlers.get('close')?.(1);
			});
			return {
				stdout: {
					on: (event: string, handler: (chunk: Buffer) => void) => stdoutHandlers.set(event, handler),
					destroy: () => undefined
				},
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
				kill: () => undefined
			};
		}) as never);
	}

	const { envFilesRef: _dropped, ...plainWorkspace } = workspace;

	it('stamps the run grants onto the frozen acceptance checks and the platform steps', async () => {
		const sawGrantedName: boolean[] = [];
		const deps = io({
			spawnFn: vi.fn(((_command: string, options: { env?: Record<string, string> }) => {
				sawGrantedName.push(options.env?.DATABASE_URL === GRANTED_VALUE);
				const handlers = new Map<string, (arg?: unknown) => void>();
				queueMicrotask(() => handlers.get('close')?.(0));
				return {
					stdout: { on: () => undefined, destroy: () => undefined },
					stderr: { on: () => undefined, destroy: () => undefined },
					on: (event: string, handler: (arg?: unknown) => void) => handlers.set(event, handler),
					kill: () => undefined
				};
			}) as never),
			parentEnv: { PATH: '/usr/bin', DATABASE_URL: GRANTED_VALUE },
			modelCli: { 'claude-code': CLAUDE },
			scratchFs: scratchFs(),
			scratchRoot: SCRATCH
		});

		await runAgentTaskJob(
			job({
				taskId: 'task-1',
				workspace: plainWorkspace,
				execution: {
					provider: 'claude-code',
					instructions: '# do it',
					envGrants: ['DATABASE_URL']
				},
				steps: [{ id: 'run', command: 'passing' }],
				acceptanceChecks: [{ id: 'unit', command: 'passing' }]
			}),
			deps as never
		);

		// Three spawns: the model CLI, the platform step, and the frozen
		// acceptance check — and the granted value reached all three.
		expect(sawGrantedName).toHaveLength(3);
		expect(sawGrantedName.every(Boolean)).toBe(true);
	});

	it('scrubs a granted value out of a failing CHECK log tail before it is reported', async () => {
		const deps = io({
			spawnFn: spawnEchoing(GRANTED_VALUE),
			parentEnv: { PATH: '/usr/bin', DATABASE_URL: GRANTED_VALUE },
			modelCli: { 'claude-code': CLAUDE },
			scratchFs: scratchFs(),
			scratchRoot: SCRATCH
		});
		const outcome = await runAgentTaskJob(
			job({
				taskId: 'task-1',
				workspace: plainWorkspace,
				execution: {
					provider: 'claude-code',
					instructions: '# do it',
					envGrants: ['DATABASE_URL']
				},
				acceptanceChecks: [{ id: 'unit', command: 'failing' }]
			}),
			deps as never
		);
		expect(JSON.stringify(outcome)).not.toContain(GRANTED_VALUE);
		expect(JSON.stringify(outcome)).toContain('[redacted]');
	});

	it('scrubs a DELIVERED env file value out of a failing check tail, with no grant involved', async () => {
		// The env FILE is the other half of this slice, and its values live in
		// no environment for `collectProtectedValues` to look up. A failing
		// `pnpm test` prints the connection string it read from
		// `apps/api/.env`, and that tail is stored verbatim in
		// `fleet_jobs.result` unless it is carried and scrubbed.
		const FILE_VALUE = 'postgres://file-user:file-s3cret@db.internal/app';
		const deps = io({
			fetchRunEnvFiles: vi.fn().mockResolvedValue([
				{
					repoConnectionId: ROW,
					path: 'apps/api/.env',
					content: `# seed\nDATABASE_URL=${FILE_VALUE}\n`
				}
			]),
			spawnFn: spawnEchoing(FILE_VALUE),
			// Nothing granted, nothing in the parent environment: the value is
			// protected because it was DELIVERED, not because it was named.
			parentEnv: { PATH: '/usr/bin' }
		});
		const outcome = await runAgentTaskJob(
			job({
				taskId: 'task-1',
				workspace,
				steps: [{ id: 'run', command: 'failing' }],
				acceptanceChecks: [{ id: 'unit', command: 'failing' }]
			}),
			deps as never
		);
		expect(JSON.stringify(outcome)).not.toContain(FILE_VALUE);
		expect(JSON.stringify(outcome)).toContain('[redacted]');
	});

	it('takes the delivered env files off the disk BEFORE the first Git command', async () => {
		// `info/exclude` is the LOWEST-precedence ignore source Git has, and
		// the model has `acceptEdits` over the checkout: a `.gitignore`
		// carrying `!/apps/api/.env` would re-include the secret and the node
		// would commit and push it itself. Nothing after the checks reads the
		// files, so they come off first.
		const order: string[] = [];
		const deps = io({
			removeRunEnvFiles: vi.fn(async () => {
				order.push('remove');
				return 1;
			}),
			finalizeWorkspace: vi.fn(async () => {
				order.push('finalize');
				return { pushed: true, headSha: 'c'.repeat(40), empty: false, changedFiles: 1 };
			}),
			modelCli: { 'claude-code': CLAUDE },
			scratchFs: scratchFs(),
			scratchRoot: SCRATCH
		});
		await runAgentTaskJob(
			job({
				taskId: 'task-1',
				workspace,
				execution: { provider: 'claude-code', instructions: '# do it' },
				git: { commit: true, push: true, commitMessage: 'chore: run' }
			}),
			deps as never
		);
		expect(order[0]).toBe('remove');
		expect(order).toContain('finalize');
		expect(order.indexOf('remove')).toBeLessThan(order.indexOf('finalize'));
	});

	it('leaves an ordinary log tail alone when the run granted nothing', async () => {
		const deps = io({
			spawnFn: spawnEchoing('some ordinary output that is long enough'),
			parentEnv: { PATH: '/usr/bin', DATABASE_URL: GRANTED_VALUE }
		});
		const outcome = await runAgentTaskJob(
			job({
				taskId: 'task-1',
				workspace: plainWorkspace,
				steps: [{ id: 'run', command: 'failing' }]
			}),
			deps as never
		);
		expect(JSON.stringify(outcome)).toContain('some ordinary output that is long enough');
		// …and an ungranted value is not in the environment to leak anyway.
		expect(JSON.stringify(outcome)).not.toContain(GRANTED_VALUE);
	});
});
