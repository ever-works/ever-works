import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as nodeFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import {
	FLEET_AGENT_TASK_MAX_SETUP_STEPS,
	FLEET_AGENT_TASK_MAX_STEPS,
	FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES,
	FLEET_AGENT_TASK_SETUP_MAX_TIMEOUT_SEC,
	FLEET_JOB_MAX_RESULT_BYTES
} from '@ever-works/contracts';
import { CHECK_LOG_TAIL_BYTES, DEFAULT_CHECK_TIMEOUT_SEC } from './acceptance-checks';
import {
	AgentTaskPayloadError,
	normalizeAgentTaskSetup,
	runAgentTaskJob,
	type AgentTaskIo,
	type AgentTaskScratchFs
} from './agent-task';
import type { AgentTaskQuestionFs } from './agent-task-question';

/**
 * Acceptance checks that mean something (EW-807) at the executor seam.
 *
 * Three properties, none of them plumbing:
 *
 *  1. A command runs in the REPOSITORY IT NAMES. Before this slice every
 *     step and check ran in the primary worktree, so a run that edited
 *     three repositories tested one and reported green.
 *  2. A repository it did NOT provision is a refusal, never a quiet
 *     fallback to the primary.
 *  3. The setup phase is budgeted, capped and REPORTED apart from the
 *     checks. A failed install is `setupStatus: 'red'` with
 *     `gateStatus: 'none'` — the gate did not fail, it never ran — and the
 *     model, the steps, the checks and the push are all skipped, because
 *     every verdict after a failed install describes the install.
 */

const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';
const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-807',
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

const claudeEnvelope = JSON.stringify({
	type: 'result',
	subtype: 'success',
	is_error: false,
	result: 'done',
	total_cost_usd: 0.1,
	num_turns: 1,
	session_id: 'sess-807'
});

function scratchFs(): AgentTaskScratchFs {
	const files = new Map<string, string>();
	return {
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async (path, content) => {
			files.set(path, content);
		},
		readFile: async (path) => (path.endsWith('model-output.json') ? claudeEnvelope : (files.get(path) ?? null)),
		remove: async () => undefined
	};
}

const silentQuestionFs: AgentTaskQuestionFs = {
	readHead: async () => null,
	remove: async () => undefined,
	removeDirIfEmpty: async () => undefined
};

/**
 * Spawn double that records `(command, cwd)` and scripts an exit code per
 * command. `stdoutByCommand` lets one command flood its pipes so the log
 * cap can be observed.
 */
function recordingSpawn(options: {
	log: Array<{ command: string; cwd: string }>;
	exitCodeByCommand?: Record<string, number | null>;
	stdoutByCommand?: Record<string, string>;
	neverCloses?: ReadonlySet<string>;
}) {
	return ((command: string, spawnOptions: { cwd?: string }) => {
		options.log.push({ command, cwd: String(spawnOptions?.cwd) });
		const handlers = new Map<string, (arg?: unknown) => void>();
		const dataHandlers: Array<(chunk: string) => void> = [];
		queueMicrotask(() => {
			const stdout = options.stdoutByCommand?.[command];
			if (stdout !== undefined) for (const handler of dataHandlers) handler(stdout);
			if (options.neverCloses?.has(command)) return;
			handlers.get('close')?.(options.exitCodeByCommand?.[command] ?? 0);
		});
		return {
			pid: 4242,
			stdout: {
				on: (_event: string, handler: (chunk: string) => void) => dataHandlers.push(handler),
				destroy: () => undefined
			},
			stderr: { on: () => undefined, destroy: () => undefined },
			on: (event: string, handler: (arg?: unknown) => void) => {
				handlers.set(event, handler);
			},
			kill: () => undefined
		};
	}) as never;
}

function baseIo(over: Partial<AgentTaskIo> = {}): AgentTaskIo {
	return {
		directoryExists: () => true,
		modelCli: { 'claude-code': CLAUDE },
		scratchRoot: SCRATCH,
		scratchFs: scratchFs(),
		questionFs: silentQuestionFs,
		parentEnv: {},
		platform: process.platform,
		...over
	};
}

// ─────────────────────────────────────────────────────────────────────
// 1. A command runs in the repository it names — on a REAL tree, because
//    the mount's worktree is a cousin of the primary and the junction
//    between them is a filesystem object, not a string.
// ─────────────────────────────────────────────────────────────────────

async function realFleetLayout(): Promise<{
	primaryPath: string;
	mountPath: string;
	descriptor: FleetTaskWorkspaceDescriptor;
}> {
	const root = mkdtempSync(join(tmpdir(), 'ew-phases-'));
	await nodeFs.mkdir(join(root, 'primary', '.mounts'), { recursive: true });
	await nodeFs.mkdir(join(root, 'template-worktree', 'packages'), { recursive: true });
	// Canonical, because the descriptor's own contract says its paths are —
	// and on macOS `/var/folders/...` is a symlink to `/private/var/...`.
	const primaryPath = await nodeFs.realpath(join(root, 'primary'));
	const mountPath = join(root, 'template-worktree');
	const linkPath = join(primaryPath, '.mounts', 'template');
	await nodeFs.symlink(mountPath, linkPath, linkKind);
	return {
		primaryPath,
		mountPath: await nodeFs.realpath(mountPath),
		descriptor: {
			path: primaryPath,
			repositoryId: 'ever-works/ever-works',
			baseRef: 'develop',
			branch: 'task/t1',
			baseSha: 'a'.repeat(40),
			headSha: 'a'.repeat(40),
			reused: false,
			mounts: [
				{
					path: await nodeFs.realpath(mountPath),
					linkPath,
					repositoryId: 'ever-works/directory-web-template',
					baseRef: 'develop',
					branch: 'task/t1',
					baseSha: 'c'.repeat(40),
					headSha: 'c'.repeat(40),
					reused: false,
					mountDir: 'template',
					writable: true
				}
			]
		}
	};
}

async function mkLayout(): Promise<{
	primaryPath: string;
	mountPath: string;
	descriptor: FleetTaskWorkspaceDescriptor;
}> {
	const layout = await realFleetLayout();
	return layout;
}

describe('a check runs in the repository it names', () => {
	it('routes a mountDir check into the MOUNT worktree and a plain check into the primary', async () => {
		const { primaryPath, mountPath, descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				execution: { provider: 'claude-code', instructions: '# Task' },
				git: { commit: false },
				acceptanceChecks: [
					{ id: 'primary-tests', command: 'primary-tests', required: true },
					{ id: 'template-tests', command: 'template-tests', mountDir: 'template', required: true },
					{
						id: 'template-pkg',
						command: 'template-pkg',
						mountDir: 'template',
						cwd: 'packages',
						required: true
					}
				]
			}),
			baseIo({
				spawnFn: recordingSpawn({ log }),
				provisionWorkspace: async () => descriptor
			})
		);

		expect(outcome.gateStatus).toBe('green');
		// [0] is the model CLI, which always runs in the primary worktree.
		expect(log.map((entry) => entry.cwd)).toEqual([
			primaryPath,
			primaryPath,
			mountPath,
			join(mountPath, 'packages')
		]);
		// The property that makes this worth having: the mount is NOT under
		// the primary, so no amount of joining onto `descriptor.path` could
		// have produced it.
		expect(mountPath.startsWith(primaryPath)).toBe(false);
	});

	it('REFUSES the job when a check names a repository this run did not provision', async () => {
		const { descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		await expect(
			runAgentTaskJob(
				job({
					taskId: 't1',
					workspace: {
						repositoryId: 'x/y',
						repoUrl: 'https://example.invalid/x/y.git',
						baseRef: 'develop',
						branch: 'b'
					},
					setup: [{ id: 'install', command: 'pnpm install', mountDir: 'api' }],
					execution: { provider: 'claude-code', instructions: '# Task' },
					acceptanceChecks: [{ id: 'api-tests', command: 'api-tests', mountDir: 'api', required: true }]
				}),
				baseIo({ spawnFn: recordingSpawn({ log }), provisionWorkspace: async () => descriptor })
			)
		).rejects.toThrowError(/did not provision/);
		// Refused BEFORE anything was spawned: the alternative — running it
		// in the primary and reporting green — is the defect, not the fix.
		expect(log).toEqual([]);
	});

	it('REFUSES a CHECK that names an unprovisioned repository, after the model has already run', async () => {
		// The refusal is not a payload-shape check that could be hoisted to
		// dispatch: it is resolved per command, at the moment the command is
		// about to spawn, against the descriptor THIS run provisioned.
		const { descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		await expect(
			runAgentTaskJob(
				job({
					taskId: 't1',
					workspace: {
						repositoryId: 'x/y',
						repoUrl: 'https://example.invalid/x/y.git',
						baseRef: 'develop',
						branch: 'b'
					},
					execution: { provider: 'claude-code', instructions: '# Task' },
					git: { commit: false },
					acceptanceChecks: [{ id: 'api-tests', command: 'api-tests', mountDir: 'api', required: true }]
				}),
				baseIo({ spawnFn: recordingSpawn({ log }), provisionWorkspace: async () => descriptor })
			)
		).rejects.toThrowError(/did not provision/);
		// The model ran; the check did NOT run in the primary as a fallback.
		expect(log.map((entry) => entry.command)).toEqual([expect.stringContaining(CLAUDE)]);
	});

	it('REFUSES a traversal string in mountDir without ever touching the filesystem', async () => {
		const { descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		await expect(
			runAgentTaskJob(
				job({
					taskId: 't1',
					workspace: {
						repositoryId: 'x/y',
						repoUrl: 'https://example.invalid/x/y.git',
						baseRef: 'develop',
						branch: 'b'
					},
					setup: [{ id: 'escape', command: 'escape', mountDir: '../..' }],
					execution: { provider: 'claude-code', instructions: '# Task' },
					acceptanceChecks: [{ id: 'tests', command: 'pnpm test', required: true }]
				}),
				baseIo({ spawnFn: recordingSpawn({ log }), provisionWorkspace: async () => descriptor })
			)
		).rejects.toThrowError(/not a valid mount directory name/);
		expect(log).toEqual([]);
	});

	it('routes a platform-authored STEP the same way', async () => {
		const { mountPath, descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				steps: [{ id: 's1', command: 'build-template', mountDir: 'template' }]
			}),
			baseIo({ spawnFn: recordingSpawn({ log }), provisionWorkspace: async () => descriptor })
		);
		expect(log).toEqual([{ command: 'build-template', cwd: mountPath }]);
	});
});

// ─────────────────────────────────────────────────────────────────────
// 2. The setup phase
// ─────────────────────────────────────────────────────────────────────

describe('normalizeAgentTaskSetup', () => {
	it('treats an absent phase as empty rather than throwing', () => {
		expect(normalizeAgentTaskSetup(undefined)).toEqual([]);
		expect(normalizeAgentTaskSetup(null)).toEqual([]);
	});

	it('refuses a non-array', () => {
		expect(() => normalizeAgentTaskSetup('pnpm install')).toThrowError(/must be an array/);
	});

	it('refuses more setup steps than the ceiling', () => {
		const many = Array.from({ length: FLEET_AGENT_TASK_MAX_SETUP_STEPS + 1 }, (_, i) => ({
			id: `s${i}`,
			command: 'true'
		}));
		expect(() => normalizeAgentTaskSetup(many)).toThrowError(/ceiling/);
	});

	it('refuses an entry with no command — a silently dropped install poisons every later verdict', () => {
		expect(() => normalizeAgentTaskSetup([{ id: 'install' }])).toThrowError(/Setup step 'install' has no command/);
		expect(() => normalizeAgentTaskSetup([{ command: 'pnpm i' }])).toThrowError(/Setup step at index 0 has no id/);
	});

	it('carries cwd, mountDir, timeoutSec and required through', () => {
		expect(
			normalizeAgentTaskSetup([
				{
					id: 'install',
					command: 'pnpm i',
					cwd: 'apps/web',
					mountDir: 'template',
					timeoutSec: 60,
					required: false
				}
			])[0]
		).toEqual({
			id: 'install',
			command: 'pnpm i',
			cwd: 'apps/web',
			mountDir: 'template',
			timeoutSec: 60,
			required: false
		});
	});
});

describe('the setup phase runs first and is reported apart from the checks', () => {
	it('runs setup before the model, then the checks, and reports each block separately', async () => {
		const { descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup: [
					{ id: 'install', command: 'pnpm install' },
					{ id: 'install-template', command: 'pnpm install --template', mountDir: 'template' }
				],
				execution: { provider: 'claude-code', instructions: '# Task' },
				acceptanceChecks: [{ id: 'tests', command: 'pnpm test', required: true }],
				git: { commit: false }
			}),
			baseIo({ spawnFn: recordingSpawn({ log }), provisionWorkspace: async () => descriptor })
		);

		expect(log.map((entry) => entry.command)).toEqual([
			'pnpm install',
			'pnpm install --template',
			expect.stringContaining(CLAUDE),
			'pnpm test'
		]);
		expect(outcome.setup?.map((result) => result.id)).toEqual(['install', 'install-template']);
		expect(outcome.setupStatus).toBe('green');
		expect(outcome.checks?.map((result) => result.id)).toEqual(['tests']);
		expect(outcome.gateStatus).toBe('green');
		expect(outcome.status).toBe('succeeded');
	});

	it('reports NOTHING new for a job that carries no setup phase', async () => {
		const { descriptor } = await mkLayout();
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				execution: { provider: 'claude-code', instructions: '# Task' },
				git: { commit: false },
				acceptanceChecks: [{ id: 'tests', command: 'pnpm test', required: true }]
			}),
			baseIo({ spawnFn: recordingSpawn({ log: [] }), provisionWorkspace: async () => descriptor })
		);
		expect('setup' in outcome).toBe(false);
		expect('setupStatus' in outcome).toBe(false);
	});

	it('a failed required setup step is SETUP FAILED, not a red gate', async () => {
		const { descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		const finalize = vi.fn();
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup: [{ id: 'install', command: 'pnpm install' }],
				steps: [{ id: 's1', command: 'never-runs' }],
				execution: { provider: 'claude-code', instructions: '# Task' },
				acceptanceChecks: [{ id: 'tests', command: 'pnpm test', required: true }]
			}),
			baseIo({
				spawnFn: recordingSpawn({ log, exitCodeByCommand: { 'pnpm install': 1 } }),
				provisionWorkspace: async () => descriptor,
				finalizeWorkspace: finalize as never
			})
		);

		expect(outcome.setupStatus).toBe('red');
		expect(outcome.setup?.[0]).toMatchObject({ id: 'install', status: 'red', exitCode: 1 });
		// The gate did not fail. It never ran.
		expect(outcome.gateStatus).toBe('none');
		expect('checks' in outcome).toBe(false);
		expect(outcome.steps).toEqual([]);
		expect(outcome.status).toBe('failed');
		expect(outcome.failureReason).toContain('SETUP FAILED');
		expect(outcome.failureReason).toContain("'install' exited 1");
		expect(outcome.failureReason).toContain('this is not a failing test');
		// Nothing after the install ran: no model call, no steps, no checks,
		// and no branch pushed for a run that did no work.
		expect(log.map((entry) => entry.command)).toEqual(['pnpm install']);
		expect(finalize).not.toHaveBeenCalled();
	});

	it('a NON-required setup step that fails does not block the run', async () => {
		const { descriptor } = await mkLayout();
		const log: Array<{ command: string; cwd: string }> = [];
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				execution: { provider: 'claude-code', instructions: '# Task' },
				git: { commit: false },
				setup: [{ id: 'warm-cache', command: 'warm-cache', required: false }],
				acceptanceChecks: [{ id: 'tests', command: 'pnpm test', required: true }]
			}),
			baseIo({
				spawnFn: recordingSpawn({ log, exitCodeByCommand: { 'warm-cache': 7 } }),
				provisionWorkspace: async () => descriptor
			})
		);
		expect(outcome.setupStatus).toBe('green');
		expect(outcome.setup?.[0]).toMatchObject({ status: 'red', exitCode: 7 });
		expect(outcome.gateStatus).toBe('green');
		expect(outcome.status).toBe('succeeded');
	});

	it('keeps a bigger log tail for setup than for a check', async () => {
		const { descriptor } = await mkLayout();
		const flood = 'x'.repeat(FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES * 3);
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup: [{ id: 'install', command: 'noisy-install' }],
				execution: { provider: 'claude-code', instructions: '# Task' },
				git: { commit: false },
				acceptanceChecks: [{ id: 'tests', command: 'noisy-test', required: true }]
			}),
			baseIo({
				spawnFn: recordingSpawn({
					log: [],
					stdoutByCommand: { 'noisy-install': flood, 'noisy-test': flood }
				}),
				provisionWorkspace: async () => descriptor
			})
		);
		// Both are bounded; the setup window is the larger one, which is the
		// whole reason it is a separate budget.
		expect(outcome.setup?.[0].logTail).toHaveLength(FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES);
		expect(outcome.checks?.[0].logTail).toHaveLength(CHECK_LOG_TAIL_BYTES);
		expect(FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES).toBeGreaterThan(CHECK_LOG_TAIL_BYTES);
	});

	it('scrubs a granted credential out of a setup step tail, like every other command', async () => {
		const { descriptor } = await mkLayout();
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup: [{ id: 'install', command: 'leaky-install' }],
				execution: { provider: 'claude-code', instructions: '# Task', envGrants: ['NPM_TOKEN'] },
				git: { commit: false }
			}),
			baseIo({
				parentEnv: { NPM_TOKEN: 'npm_supersecrettokenvalue' },
				spawnFn: recordingSpawn({
					log: [],
					stdoutByCommand: { 'leaky-install': 'error: 401 for npm_supersecrettokenvalue' }
				}),
				provisionWorkspace: async () => descriptor
			})
		);
		expect(outcome.setup?.[0].logTail).not.toContain('npm_supersecrettokenvalue');
		expect(outcome.setup?.[0].logTail).toContain('401 for');
	});
});

describe('the setup phase has its own wall-clock budget', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	async function runWithFakeTimers(setupStep: Record<string, unknown>, advanceSec: number[]) {
		const { descriptor } = await mkLayout();
		vi.useFakeTimers();
		const terminated: string[] = [];
		const promise = runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup: [setupStep],
				execution: { provider: 'claude-code', instructions: '# Task' },
				git: { commit: false }
			}),
			baseIo({
				spawnFn: recordingSpawn({ log: [], neverCloses: new Set([String(setupStep.command)]) }),
				terminateProcessTree: async () => {
					terminated.push('killed');
				},
				provisionWorkspace: async () => descriptor
			})
		);
		const settled: Array<'pending' | 'settled'> = [];
		for (const seconds of advanceSec) {
			await vi.advanceTimersByTimeAsync(seconds * 1000);
			await Promise.resolve();
			settled.push(terminated.length > 0 ? 'settled' : 'pending');
		}
		return { promise, settled };
	}

	it('does not kill an install at the acceptance-check default (600s)', async () => {
		const { promise, settled } = await runWithFakeTimers({ id: 'install', command: 'slow-install' }, [
			DEFAULT_CHECK_TIMEOUT_SEC + 60,
			1800
		]);
		// Still running long after a CHECK would have been killed; killed at
		// the setup default. This is the point of a separate budget: a cold
		// `pnpm install` legitimately outlives a test run's ceiling.
		expect(settled).toEqual(['pending', 'settled']);
		const outcome = await promise;
		expect(outcome.setup?.[0]).toMatchObject({ id: 'install', status: 'timeout' });
		expect(outcome.setupStatus).toBe('red');
		expect(outcome.gateStatus).toBe('none');
		expect(outcome.failureReason).toContain("'install' timed out");
	});

	it('clamps an absurd declared timeout to the setup ceiling rather than honouring it', async () => {
		const { promise, settled } = await runWithFakeTimers(
			{ id: 'install', command: 'hanging-install', timeoutSec: 999_999 },
			[FLEET_AGENT_TASK_SETUP_MAX_TIMEOUT_SEC - 60, 120]
		);
		expect(settled).toEqual(['pending', 'settled']);
		const outcome = await promise;
		expect(outcome.setup?.[0]).toMatchObject({ status: 'timeout' });
	});
});

describe('setup refusals fail the job', () => {
	it('refuses a malformed setup phase rather than running the rest of the job', async () => {
		const { descriptor } = await mkLayout();
		await expect(
			runAgentTaskJob(
				job({
					taskId: 't1',
					workspace: {
						repositoryId: 'x/y',
						repoUrl: 'https://example.invalid/x/y.git',
						baseRef: 'develop',
						branch: 'b'
					},
					setup: 'pnpm install',
					execution: { provider: 'claude-code', instructions: '# Task' },
					acceptanceChecks: [{ id: 'tests', command: 'pnpm test', required: true }]
				}),
				baseIo({ spawnFn: recordingSpawn({ log: [] }), provisionWorkspace: async () => descriptor })
			)
		).rejects.toBeInstanceOf(AgentTaskPayloadError);
	});
});

// ─────────────────────────────────────────────────────────────────────
// 4. AUTHORSHIP decides what a command may read (EW-807).
//
//    A repository-declared command is authored by whoever can land a
//    commit or a PR branch. An env grant is an operator binding a
//    credential to a repository for THEIR OWN commands — and an
//    allow-list over command STRINGS cannot bound where a granted value
//    goes, because an allow-listed `pnpm install` honours a
//    repository-committed `.npmrc` that expands `${NPM_TOKEN}` into a
//    request to whoever wrote the file.
// ─────────────────────────────────────────────────────────────────────

/** Spawn double that records the ENV each command was actually given. */
function envRecordingSpawn(seen: Array<{ command: string; env: Record<string, string> }>) {
	return ((command: string, spawnOptions: { env?: Record<string, string> }) => {
		seen.push({ command, env: { ...(spawnOptions?.env ?? {}) } });
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => handlers.get('close')?.(0));
		return {
			pid: 4243,
			stdout: { on: () => undefined, destroy: () => undefined },
			stderr: { on: () => undefined, destroy: () => undefined },
			on: (event: string, handler: (arg?: unknown) => void) => {
				handlers.set(event, handler);
			},
			kill: () => undefined
		};
	}) as never;
}

describe('a repository-declared command never receives the run env grants', () => {
	it('withholds the grant from a repo/ id and keeps it for the owner-authored one', async () => {
		const { descriptor } = await mkLayout();
		const seen: Array<{ command: string; env: Record<string, string> }> = [];
		await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup: [
					// What the Work's own defaults produced.
					{ id: 'owner-install', command: 'owner-install' },
					// What `.works/works.yml` produced. The `repo/` prefix is
					// minted by the platform and cannot be spelled by an
					// owner-authored id, which is what makes it a sound
					// authorship marker.
					{ id: 'repo/setup-1', command: 'repo-install' }
				],
				execution: { provider: 'claude-code', instructions: '# Task', envGrants: ['NPM_TOKEN'] },
				git: { commit: false },
				acceptanceChecks: [{ id: 'repo/check-1', command: 'repo-test', required: true }]
			}),
			baseIo({
				parentEnv: { NPM_TOKEN: 'npm_supersecrettokenvalue', PATH: '/usr/bin' },
				spawnFn: envRecordingSpawn(seen),
				provisionWorkspace: async () => descriptor
			})
		);

		const envFor = (command: string): Record<string, string> =>
			seen.find((entry) => entry.command === command)?.env ?? {};
		expect(envFor('owner-install').NPM_TOKEN).toBe('npm_supersecrettokenvalue');
		expect(envFor('repo-install').NPM_TOKEN).toBeUndefined();
		expect(envFor('repo-test').NPM_TOKEN).toBeUndefined();
		// Not "the env was empty" — the repository-declared command still
		// runs with everything a command needs, it just has no credential.
		expect(envFor('repo-install').CI).toBe('1');
	});
});

describe('a per-command env grant on the wire is not honoured, on either phase', () => {
	/**
	 * `normalizeChecks` never read `envGrants` off an acceptance check, so
	 * before this the SETUP phase — which runs first, before the model, at
	 * the largest ceiling — was the LESS restricted of the two at the one
	 * place both are validated. Reconciled toward the narrower side: a
	 * command's grants come from the run-level `execution.envGrants` and
	 * nowhere else.
	 */
	it('ignores envGrants declared on a setup step, a step and a check alike', async () => {
		const { descriptor } = await mkLayout();
		const seen: Array<{ command: string; env: Record<string, string> }> = [];
		await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup: [{ id: 'install', command: 'wire-install', envGrants: ['DATABASE_URL'] }],
				steps: [{ id: 'build', command: 'wire-build', envGrants: ['DATABASE_URL'] }],
				acceptanceChecks: [{ id: 'tests', command: 'wire-test', envGrants: ['DATABASE_URL'] }],
				git: { commit: false }
			}),
			baseIo({
				parentEnv: { DATABASE_URL: 'postgres://u:p@db/ever', PATH: '/usr/bin' },
				spawnFn: envRecordingSpawn(seen),
				provisionWorkspace: async () => descriptor
			})
		);
		expect(seen.map((entry) => entry.command).sort()).toEqual(['wire-build', 'wire-install', 'wire-test']);
		for (const entry of seen) {
			expect(entry.env.DATABASE_URL).toBeUndefined();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────
// 5. The assembled result has to FIT, or the verdict is destroyed.
// ─────────────────────────────────────────────────────────────────────

describe('a maximally noisy run still reports a result the platform will accept', () => {
	it('keeps the outcome inside FLEET_JOB_MAX_RESULT_BYTES and keeps every verdict', async () => {
		const { descriptor } = await mkLayout();
		// Non-ASCII on purpose: one UTF-16 code unit, three UTF-8 bytes —
		// the glyph package managers draw their trees with, and the reason a
		// code-unit window overran its byte budget by 3x.
		const flood = '─'.repeat(FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES * 2);
		const setup = Array.from({ length: FLEET_AGENT_TASK_MAX_SETUP_STEPS }, (_, i) => ({
			id: `install-${i}`,
			command: `install-${i}`
		}));
		const steps = Array.from({ length: FLEET_AGENT_TASK_MAX_STEPS }, (_, i) => ({
			id: `step-${i}`,
			command: `step-${i}`
		}));
		const checks = Array.from({ length: 32 }, (_, i) => ({
			id: `check-${i}`,
			command: `check-${i}`,
			required: true
		}));
		const stdoutByCommand: Record<string, string> = {};
		for (const command of [...setup, ...steps, ...checks]) stdoutByCommand[command.command] = flood;

		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: {
					repositoryId: 'x/y',
					repoUrl: 'https://example.invalid/x/y.git',
					baseRef: 'develop',
					branch: 'b'
				},
				setup,
				steps,
				acceptanceChecks: checks,
				execution: { provider: 'claude-code', instructions: '# Task' },
				git: { commit: false }
			}),
			baseIo({
				spawnFn: recordingSpawn({ log: [], stdoutByCommand }),
				provisionWorkspace: async () => descriptor
			})
		);

		// The platform measures exactly this and REJECTS the settlement over
		// the cap; the worker loop then re-reports the run as failed and
		// `completeJob` stores no result at all.
		expect(Buffer.byteLength(JSON.stringify(outcome), 'utf8')).toBeLessThanOrEqual(FLEET_JOB_MAX_RESULT_BYTES);
		// And the verdicts are all still there.
		expect(outcome.status).toBe('succeeded');
		expect(outcome.setupStatus).toBe('green');
		expect(outcome.gateStatus).toBe('green');
		expect(outcome.setup).toHaveLength(FLEET_AGENT_TASK_MAX_SETUP_STEPS);
		expect(outcome.steps).toHaveLength(FLEET_AGENT_TASK_MAX_STEPS);
		expect(outcome.checks).toHaveLength(32);
		// The un-trimmed tails really would have overflowed: the per-command
		// windows MULTIPLY, and 8x8 KiB + 16x4 KiB + 32x4 KiB is the 256 KiB
		// cap exactly, before the JSON around them.
		const untrimmed =
			FLEET_AGENT_TASK_MAX_SETUP_STEPS * FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES +
			(FLEET_AGENT_TASK_MAX_STEPS + 32) * CHECK_LOG_TAIL_BYTES;
		expect(untrimmed).toBeGreaterThanOrEqual(FLEET_JOB_MAX_RESULT_BYTES);
	});
});
