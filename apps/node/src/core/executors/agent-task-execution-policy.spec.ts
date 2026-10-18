import { join } from 'node:path';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { describe, expect, it, vi } from 'vitest';
import { NodeExecutionPolicyError } from '../execution-policy';
import { DEFAULT_NODE_EXECUTION_POLICY, type NodeExecutionPolicy } from '../types';
import { runAcceptanceChecksJob } from './acceptance-checks';
import { runAgentTaskJob, type AgentTaskIo, type AgentTaskScratchFs } from './agent-task';
import type { AgentTaskQuestionFs } from './agent-task-question';

/**
 * Control 18 — the machine owner's LOCAL execution policy.
 *
 * Two things a job can ask for turn "a model edits a worktree" into
 * "anything runs as the machine owner": skip-permissions (an unrestricted
 * shell for the model) and node-run shell commands (setup, steps, acceptance
 * checks — repository code, after a model step code the model may have just
 * written). Both are refused unless the owner allowed them ON THE MACHINE,
 * before anything is provisioned or spawned. The platform cannot flip them.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';

const descriptor: FleetTaskWorkspaceDescriptor = {
	path: ABSOLUTE,
	repositoryId: 'ever-works/ever-works',
	baseRef: 'develop',
	branch: 'task/t1-fix',
	baseSha: 'a'.repeat(40),
	headSha: 'a'.repeat(40),
	reused: false
};

const modelPayload = {
	taskId: 't1',
	runId: 'run-1',
	agentId: 'agent-1',
	workspace: {
		repositoryId: 'ever-works/ever-works',
		repoUrl: 'https://github.com/ever-works/ever-works.git',
		baseRef: 'develop',
		branch: 'task/t1-fix'
	},
	execution: {
		provider: 'claude-code' as const,
		instructions: '# Task\nFix the thing.',
		permissionMode: 'acceptEdits' as const
	}
};

const check = { id: 'test', name: 'Unit tests', command: 'pnpm test', required: true };

function job(payload: unknown, kind: FleetJobView['kind'] = 'agent-task'): FleetJobView {
	return {
		id: 'job-18',
		kind,
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
	result: 'Implemented the change.',
	session_id: 'sess-1'
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

function questionFs(): AgentTaskQuestionFs {
	return { readHead: async () => null, remove: async () => undefined, removeDirIfEmpty: async () => undefined };
}

function recordingSpawn() {
	const commands: string[] = [];
	const spawnFn = ((command: string) => {
		commands.push(command);
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => handlers.get('close')?.(0));
		return {
			stdout: { on: () => undefined, destroy: () => undefined },
			stderr: { on: () => undefined, destroy: () => undefined },
			on: (event: string, handler: (arg?: unknown) => void) => {
				handlers.set(event, handler);
			},
			kill: () => undefined
		};
	}) as never;
	return { commands, spawnFn };
}

function io(policy: NodeExecutionPolicy | undefined, over: Partial<AgentTaskIo> = {}) {
	const provisionWorkspace = vi.fn(async () => descriptor);
	const value: AgentTaskIo = {
		directoryExists: () => true,
		provisionWorkspace,
		finalizeWorkspace: vi.fn(async () => ({
			pushed: true,
			headSha: 'b'.repeat(40),
			empty: false,
			changedFiles: 1
		})),
		modelCli: { 'claude-code': CLAUDE },
		scratchRoot: SCRATCH,
		scratchFs: scratchFs(),
		questionFs: questionFs(),
		...(policy ? { executionPolicy: policy } : {}),
		...over
	};
	return { io: value, provisionWorkspace };
}

const OFF = DEFAULT_NODE_EXECUTION_POLICY;

describe('control 18 — the node’s local execution policy (agent-task)', () => {
	it('OFF/OFF is the default a machine enforces', () => {
		expect(DEFAULT_NODE_EXECUTION_POLICY).toEqual({
			allowSkipPermissions: false,
			allowShellCommands: false,
			restrictedMode: true
		});
	});

	it('refuses a skip-permissions job before provisioning or spawning anything', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const { io: value, provisionWorkspace } = io(OFF, { spawnFn });

		await expect(
			runAgentTaskJob(
				job({ ...modelPayload, execution: { ...modelPayload.execution, skipPermissions: true } }),
				value
			)
		).rejects.toThrowError(NodeExecutionPolicyError);
		await expect(
			runAgentTaskJob(
				job({ ...modelPayload, execution: { ...modelPayload.execution, skipPermissions: true } }),
				value
			)
		).rejects.toThrowError(/--allow-skip-permissions/);
		expect(provisionWorkspace).not.toHaveBeenCalled();
		expect(commands).toHaveLength(0);
	});

	it('runs a skip-permissions job once the owner allowed it on this machine', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const { io: value } = io({ ...OFF, allowSkipPermissions: true }, { spawnFn });

		const outcome = await runAgentTaskJob(
			job({ ...modelPayload, execution: { ...modelPayload.execution, skipPermissions: true } }),
			value
		);

		expect(outcome.status).toBe('succeeded');
		expect(commands[0]).toContain('--dangerously-skip-permissions');
	});

	it('runs an ordinary model job (no skip, no commands) with the default policy', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const { io: value } = io(OFF, { spawnFn });

		const outcome = await runAgentTaskJob(job(modelPayload), value);

		expect(outcome.status).toBe('succeeded');
		expect(commands).toHaveLength(1);
		expect(commands[0]).not.toContain('--dangerously-skip-permissions');
	});

	it.each([
		['acceptance checks', { acceptanceChecks: [check] }, /1 acceptance check/],
		['a setup phase', { setup: [{ id: 'install', command: 'pnpm install', required: true }] }, /1 setup command/],
		['command steps', { steps: [{ id: 'lint', command: 'pnpm lint', required: true }] }, /1 command step/]
	])(
		'refuses a model job carrying %s — shell commands that would run repository code',
		async (_name, extra, phase) => {
			const { commands, spawnFn } = recordingSpawn();
			const { io: value, provisionWorkspace } = io(OFF, { spawnFn });

			const run = runAgentTaskJob(job({ ...modelPayload, ...extra }), value);
			await expect(run).rejects.toThrowError(NodeExecutionPolicyError);
			await expect(runAgentTaskJob(job({ ...modelPayload, ...extra }), value)).rejects.toThrowError(phase);
			await expect(runAgentTaskJob(job({ ...modelPayload, ...extra }), value)).rejects.toThrowError(
				/--allow-shell-commands/
			);
			expect(provisionWorkspace).not.toHaveBeenCalled();
			expect(commands).toHaveLength(0);
		}
	);

	it('refuses the legacy command template (steps, no model) with the default policy', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const { io: value } = io(OFF, { spawnFn });
		const { execution: _execution, ...legacy } = modelPayload;

		await expect(
			runAgentTaskJob(
				job({ ...legacy, steps: [{ id: 'agent', command: 'run-agent --task t1', required: true }] }),
				value
			)
		).rejects.toThrowError(/1 command-template step/);
		expect(commands).toHaveLength(0);
	});

	it('runs the commands once the owner allowed node-run shell commands on this machine', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const { io: value } = io({ ...OFF, allowShellCommands: true }, { spawnFn });

		const outcome = await runAgentTaskJob(job({ ...modelPayload, acceptanceChecks: [check] }), value);

		expect(outcome.gateStatus).toBe('green');
		// The model step, then the check.
		expect(commands).toHaveLength(2);
		expect(commands[1]).toContain('pnpm test');
	});

	it('enforces nothing when the embedder passes no policy (library callers keep their behaviour)', async () => {
		const { commands, spawnFn } = recordingSpawn();
		const { io: value } = io(undefined, { spawnFn });

		const outcome = await runAgentTaskJob(
			job({
				...modelPayload,
				execution: { ...modelPayload.execution, skipPermissions: true },
				acceptanceChecks: [check]
			}),
			value
		);

		expect(outcome.status).toBe('succeeded');
		expect(commands).toHaveLength(2);
	});
});

describe('control 18 — the node’s local execution policy (acceptance-checks jobs)', () => {
	const payload = { workspacePath: ABSOLUTE, checks: [check] };

	it('refuses an acceptance-checks job with the default policy, spawning nothing', async () => {
		const { commands, spawnFn } = recordingSpawn();

		await expect(
			runAcceptanceChecksJob(job(payload, 'acceptance-checks'), {
				spawnFn,
				directoryExists: () => true,
				executionPolicy: OFF
			})
		).rejects.toThrowError(/--allow-shell-commands/);
		expect(commands).toHaveLength(0);
	});

	it('runs it once the owner allowed node-run shell commands', async () => {
		const { commands, spawnFn } = recordingSpawn();

		const outcome = await runAcceptanceChecksJob(job(payload, 'acceptance-checks'), {
			spawnFn,
			directoryExists: () => true,
			executionPolicy: { ...OFF, allowShellCommands: true }
		});

		expect(outcome.gateStatus).toBe('green');
		expect(commands).toHaveLength(1);
	});

	it('an empty check list is still "nothing to run", not a refusal', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [] }, 'acceptance-checks'),
			{
				directoryExists: () => true,
				executionPolicy: OFF
			}
		);
		expect(outcome).toEqual({ gateStatus: 'none', results: [] });
	});
});
