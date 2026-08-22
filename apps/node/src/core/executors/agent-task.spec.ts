import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import { AgentTaskPayloadError, normalizeAgentTaskSteps, runAgentTaskJob } from './agent-task';

/**
 * The general node job kind.
 *
 * Two properties matter here, and neither is happy-path plumbing:
 *
 *   1. A job with nothing to run FAILS, loudly, naming the operator knob
 *      that would have supplied the commands. Reporting success for work
 *      that never happened would recreate the silent-empty-queue failure
 *      this kind exists to remove.
 *   2. Step verdicts come from the SAME command runner acceptance checks
 *      use, so a node cannot score the two kinds differently.
 */

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

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const alwaysExists = { directoryExists: () => true };

/** Minimal spawn double: emits a close with the scripted exit code. */
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

describe('runAgentTaskJob — payload refusal', () => {
	it('refuses a job with no payload', async () => {
		await expect(runAgentTaskJob(job(null), alwaysExists)).rejects.toBeInstanceOf(AgentTaskPayloadError);
	});

	it('refuses a job with no taskId', async () => {
		await expect(runAgentTaskJob(job({ steps: [] }), alwaysExists)).rejects.toThrowError(/taskId/);
	});

	it('FAILS a job with no steps and names the operator knob', async () => {
		await expect(runAgentTaskJob(job({ taskId: 't1' }), alwaysExists)).rejects.toThrowError(
			/FLEET_NODE_AGENT_TASK_COMMAND/
		);
	});

	it('refuses a RELATIVE workspace', async () => {
		await expect(
			runAgentTaskJob(
				job({ taskId: 't1', workspacePath: 'relative/dir', steps: [{ id: 's', command: 'true' }] }),
				alwaysExists
			)
		).rejects.toThrowError(/absolute path/);
	});

	it('refuses a workspace that does not exist on this node', async () => {
		await expect(
			runAgentTaskJob(job({ taskId: 't1', workspacePath: ABSOLUTE, steps: [{ id: 's', command: 'true' }] }), {
				directoryExists: () => false
			})
		).rejects.toThrowError(/does not exist on this node/);
	});
});

describe('normalizeAgentTaskSteps', () => {
	it('treats an absent list as empty rather than throwing', () => {
		expect(normalizeAgentTaskSteps(undefined)).toEqual([]);
	});

	it('refuses a non-array', () => {
		expect(() => normalizeAgentTaskSteps('pnpm build')).toThrowError(/must be an array/);
	});

	it('refuses a step with no command — silently dropping it would report work that never ran', () => {
		expect(() => normalizeAgentTaskSteps([{ id: 'build' }])).toThrowError(/has no command/);
	});

	it('refuses more steps than the ceiling', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, command: 'true' }));
		expect(() => normalizeAgentTaskSteps(many)).toThrowError(/ceiling/);
	});

	it('keeps the declared order and the optional fields', () => {
		const parsed = normalizeAgentTaskSteps([
			{ id: 'setup', command: 'pnpm install', cwd: 'apps/web', timeoutSec: 30, required: false },
			{ id: 'run', command: 'ever-works agent run' }
		]);
		expect(parsed.map((s) => s.id)).toEqual(['setup', 'run']);
		expect(parsed[0]).toMatchObject({ cwd: 'apps/web', timeoutSec: 30, required: false });
	});
});

describe('runAgentTaskJob — verdicts', () => {
	it('reports succeeded when every required step exits 0', async () => {
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				runId: 'r1',
				workspacePath: ABSOLUTE,
				steps: [
					{ id: 'setup', command: 'passing' },
					{ id: 'run', command: 'passing' }
				]
			}),
			{ ...alwaysExists, spawnFn: fakeSpawn({ passing: 0 }) }
		);

		expect(outcome.status).toBe('succeeded');
		expect(outcome.taskId).toBe('t1');
		expect(outcome.runId).toBe('r1');
		expect(outcome.steps.map((s) => s.status)).toEqual(['green', 'green']);
	});

	it('reports failed when a required step exits nonzero', async () => {
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspacePath: ABSOLUTE,
				steps: [{ id: 'run', command: 'failing', required: true }]
			}),
			{ ...alwaysExists, spawnFn: fakeSpawn({ failing: 3 }) }
		);

		expect(outcome.status).toBe('failed');
		expect(outcome.steps[0].exitCode).toBe(3);
		expect(outcome.runId).toBeNull();
	});

	it('a NON-required step can never fail the job', async () => {
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspacePath: ABSOLUTE,
				steps: [
					{ id: 'run', command: 'passing', required: true },
					{ id: 'advisory', command: 'failing', required: false }
				]
			}),
			{ ...alwaysExists, spawnFn: fakeSpawn({ passing: 0, failing: 1 }) }
		);

		expect(outcome.steps[1].status).toBe('red');
		expect(outcome.status).toBe('succeeded');
	});

	it('falls back to the injected default workspace when the job carries none', async () => {
		const outcome = await runAgentTaskJob(job({ taskId: 't1', steps: [{ id: 'run', command: 'passing' }] }), {
			...alwaysExists,
			defaultWorkspacePath: ABSOLUTE,
			spawnFn: fakeSpawn({ passing: 0 })
		});

		expect(outcome.status).toBe('succeeded');
		expect(outcome.workspace).toBeNull();
	});

	it('treats workspace null as an absent legacy field and uses workspacePath without provisioning', async () => {
		const provisionWorkspace = vi.fn();
		const outcome = await runAgentTaskJob(
			job({
				taskId: 't1',
				workspace: null,
				workspacePath: ABSOLUTE,
				steps: [{ id: 'run', command: 'passing' }]
			}),
			{ ...alwaysExists, provisionWorkspace, spawnFn: fakeSpawn({ passing: 0 }) }
		);

		expect(outcome.status).toBe('succeeded');
		expect(outcome.workspace).toBeNull();
		expect(provisionWorkspace).not.toHaveBeenCalled();
	});
});

describe('runAgentTaskJob — repository workspace boundary', () => {
	const workspace = {
		repositoryId: 'ever/repository',
		repoUrl: 'https://github.com/ever/repository.git',
		baseRef: 'develop',
		branch: 'task/platform-task-12345678'
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

	it('provisions before execution, runs every step in that checkout, and returns the descriptor', async () => {
		const provisionWorkspace = vi.fn().mockResolvedValue(descriptor);
		const controller = new AbortController();
		const cwd: string[] = [];
		const scriptedSpawn = fakeSpawn({ passing: 0 }) as unknown as (command: string) => unknown;
		const spawnFn = ((command: string, options: { cwd?: string }) => {
			cwd.push(String(options.cwd));
			return scriptedSpawn(command);
		}) as never;

		const outcome = await runAgentTaskJob(
			job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
			{ directoryExists: (path) => path === ABSOLUTE, provisionWorkspace, spawnFn },
			controller.signal
		);

		expect(provisionWorkspace).toHaveBeenCalledOnce();
		expect(provisionWorkspace).toHaveBeenCalledWith('task-1', workspace, controller.signal);
		expect(cwd).toEqual([ABSOLUTE]);
		expect(outcome.workspace).toEqual(descriptor);
	});

	it('refuses repository metadata when this runtime has no provisioner', async () => {
		await expect(
			runAgentTaskJob(job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }), {
				...alwaysExists,
				spawnFn: fakeSpawn({ passing: 0 })
			})
		).rejects.toThrowError(/workspace provisioner is not configured/i);
	});

	it('refuses ambiguous legacy and repository workspaces instead of choosing the wrong checkout', async () => {
		await expect(
			runAgentTaskJob(
				job({
					taskId: 'task-1',
					workspace,
					workspacePath: ABSOLUTE,
					steps: [{ id: 'run', command: 'passing' }]
				}),
				{ ...alwaysExists, provisionWorkspace: vi.fn().mockResolvedValue(descriptor) }
			)
		).rejects.toThrowError(/cannot carry both/i);
	});

	it('validates executable steps before provisioning, so malformed retries never touch Git', async () => {
		const provisionWorkspace = vi.fn().mockResolvedValue(descriptor);
		await expect(
			runAgentTaskJob(job({ taskId: 'task-1', workspace }), { provisionWorkspace })
		).rejects.toThrowError(/FLEET_NODE_AGENT_TASK_COMMAND/);
		expect(provisionWorkspace).not.toHaveBeenCalled();
	});
});
