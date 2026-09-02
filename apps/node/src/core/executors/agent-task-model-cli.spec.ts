import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { AgentTaskPayloadError, runAgentTaskJob, type AgentTaskIo, type AgentTaskScratchFs } from './agent-task';

/**
 * `agent-task` with an `execution` block — agent execution v2.
 *
 * What these prove, in order of how much it would hurt to lose:
 *
 *   1. The model runs FIRST, in the provisioned worktree, with the
 *      instructions on stdin (a scratch file the node writes) and the
 *      CLI's output captured from a scratch file — never argv.
 *   2. The verdict is honest: a model that failed, a red check, or a
 *      failed push each make the job `failed` and say why, even when
 *      the other parts went fine.
 *   3. A node without the requested CLI refuses the job naming the knob,
 *      rather than pretending to have run it.
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

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-77',
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
	result: 'Implemented the change.',
	total_cost_usd: 0.5,
	num_turns: 3,
	session_id: 'sess-1'
});

/** In-memory scratch filesystem; records what the model step wrote. */
function scratchFs(modelOutput: string | null): AgentTaskScratchFs & { files: Map<string, string>; removed: string[] } {
	const files = new Map<string, string>();
	const removed: string[] = [];
	return {
		files,
		removed,
		mkdir: async () => undefined,
		writeFile: async (path, content) => {
			files.set(path, content);
		},
		readFile: async (path) => (path.endsWith('model-output.json') ? modelOutput : (files.get(path) ?? null)),
		remove: async (path) => {
			removed.push(path);
		}
	};
}

/** Spawn double that records every command and scripts exit codes by substring. */
function recordingSpawn(exitCodes: Array<[match: string, code: number | null]>) {
	const commands: string[] = [];
	const spawnFn = ((command: string) => {
		commands.push(command);
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => {
			const hit = exitCodes.find(([match]) => command.includes(match));
			handlers.get('close')?.(hit ? hit[1] : 0);
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
	return { commands, spawnFn };
}

function baseIo(over: Partial<AgentTaskIo> = {}): AgentTaskIo {
	return {
		directoryExists: () => true,
		provisionWorkspace: vi.fn(async () => descriptor),
		finalizeWorkspace: vi.fn(async () => ({
			pushed: true,
			headSha: 'b'.repeat(40),
			empty: false,
			changedFiles: 3
		})),
		modelCli: { 'claude-code': CLAUDE, codex: null },
		scratchRoot: SCRATCH,
		scratchFs: scratchFs(claudeEnvelope),
		...over
	};
}

const payload = {
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
		provider: 'claude-code',
		instructions: '# Task\nFix the thing.',
		model: 'claude-opus-5',
		effort: 'high',
		envPassthrough: ['CLAUDE_CODE_OAUTH_TOKEN']
	},
	acceptanceChecks: [{ id: 'unit', name: 'Unit', kind: 'test', command: 'pnpm test' }]
};

describe('runAgentTaskJob — model-cli execution', () => {
	it('runs the model in the worktree, grades the checks, commits and pushes, and reports success', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const fs = scratchFs(claudeEnvelope);
		const io = baseIo({ spawnFn, scratchFs: fs });

		const outcome = await runAgentTaskJob(job(payload), io);

		expect(io.provisionWorkspace).toHaveBeenCalledWith('t1', payload.workspace, undefined);
		// The model command came FIRST, then the acceptance check.
		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain(CLAUDE);
		expect(commands[0]).toContain('-p --output-format json --permission-mode acceptEdits');
		expect(commands[0]).toContain('--model claude-opus-5');
		expect(commands[0]).toContain('--effort high');
		expect(commands[0]).toContain('instructions.md');
		expect(commands[0]).not.toContain('Fix the thing');
		expect(commands[1]).toBe('pnpm test');
		// Instructions were written verbatim to scratch, and scratch was removed.
		const written = [...fs.files.entries()].find(([path]) => path.endsWith('instructions.md'));
		expect(written?.[1]).toBe('# Task\nFix the thing.');
		expect(fs.removed).toHaveLength(1);
		expect(fs.removed[0]).toContain('job-77');

		expect(io.finalizeWorkspace).toHaveBeenCalledWith(
			't1',
			descriptor,
			{ commitMessage: 'feat(task): t1 agent run output', push: true },
			undefined
		);
		expect(outcome).toEqual({
			status: 'succeeded',
			taskId: 't1',
			runId: 'run-1',
			workspace: descriptor,
			steps: [],
			model: {
				provider: 'claude-code',
				status: 'succeeded',
				exitCode: 0,
				durationMs: expect.any(Number),
				summary: 'Implemented the change.',
				costUsd: 0.5,
				turns: 3,
				sessionId: 'sess-1'
			},
			checks: [{ id: 'unit', status: 'green', exitCode: 0, durationMs: expect.any(Number) }],
			gateStatus: 'green',
			git: {
				branch: 'task/t1-fix',
				baseSha: 'a'.repeat(40),
				headSha: 'b'.repeat(40),
				empty: false,
				pushed: true,
				changedFiles: 3
			}
		});
	});

	it('honours the git policy: custom subject, no push', async () => {
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({ spawnFn });
		await runAgentTaskJob(job({ ...payload, git: { push: false, commitMessage: 'chore: wip' } }), io);
		expect(io.finalizeWorkspace).toHaveBeenCalledWith(
			't1',
			descriptor,
			{ commitMessage: 'chore: wip', push: false },
			undefined
		);
	});

	it('skips the commit entirely when the policy says so', async () => {
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({ spawnFn });
		const outcome = await runAgentTaskJob(job({ ...payload, git: { commit: false } }), io);
		expect(io.finalizeWorkspace).not.toHaveBeenCalled();
		expect(outcome.git).toBeUndefined();
		expect(outcome.status).toBe('succeeded');
	});

	it('fails the job when the CLI reports an error, and still grades the checks', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const io = baseIo({
			spawnFn,
			scratchFs: scratchFs(
				JSON.stringify({ type: 'result', is_error: true, subtype: 'error_during_execution', result: 'blew up' })
			)
		});
		const outcome = await runAgentTaskJob(job(payload), io);
		expect(commands).toHaveLength(2);
		expect(outcome.status).toBe('failed');
		expect(outcome.model?.status).toBe('failed');
		expect(outcome.failureReason).toContain('claude-code reported an error: blew up');
		expect(outcome.gateStatus).toBe('green');
	});

	it('fails the job on a red required check even when the model succeeded', async () => {
		const { spawnFn } = recordingSpawn([['pnpm test', 1]]);
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn }));
		expect(outcome.status).toBe('failed');
		expect(outcome.gateStatus).toBe('red');
		expect(outcome.checks?.[0].status).toBe('red');
		expect(outcome.failureReason).toBe('a required acceptance check did not pass');
	});

	it('fails the job when the push fails, and names the git error', async () => {
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({
			spawnFn,
			finalizeWorkspace: vi.fn(async () => {
				throw new Error('git push failed: remote rejected');
			})
		});
		const outcome = await runAgentTaskJob(job(payload), io);
		expect(outcome.status).toBe('failed');
		expect(outcome.git?.error).toBe('git push failed: remote rejected');
		expect(outcome.failureReason).toContain('git finalize failed');
	});

	it('reports a node without a finalizer honestly', async () => {
		const { spawnFn } = recordingSpawn([]);
		const outcome = await runAgentTaskJob(job(payload), baseIo({ spawnFn, finalizeWorkspace: undefined }));
		expect(outcome.status).toBe('failed');
		expect(outcome.git?.error).toContain('no workspace finalizer');
	});

	it('refuses a job for a CLI this node does not have, naming the knob', async () => {
		const { spawnFn } = recordingSpawn([]);
		await expect(
			runAgentTaskJob(
				job({ ...payload, execution: { ...payload.execution, provider: 'codex' } }),
				baseIo({ spawnFn })
			)
		).rejects.toThrowError(/EVER_WORKS_NODE_CODEX_PATH/);
	});

	it('refuses a malformed execution block naming the field', async () => {
		const { spawnFn } = recordingSpawn([]);
		await expect(
			runAgentTaskJob(
				job({ ...payload, execution: { ...payload.execution, model: 'x; rm -rf /' } }),
				baseIo({ spawnFn })
			)
		).rejects.toBeInstanceOf(AgentTaskPayloadError);
	});

	it('runs the model without a repository workspace when only a path is given, and does not commit', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const io = baseIo({ spawnFn });
		const { workspace: _workspace, acceptanceChecks: _checks, ...rest } = payload;
		const outcome = await runAgentTaskJob(job({ ...rest, workspacePath: ABSOLUTE }), io);
		expect(commands).toHaveLength(1);
		expect(io.finalizeWorkspace).not.toHaveBeenCalled();
		expect(outcome.workspace).toBeNull();
		expect(outcome.gateStatus).toBe('none');
		expect(outcome.status).toBe('succeeded');
	});

	it('still runs legacy steps after the model when both are present', async () => {
		const { commands, spawnFn } = recordingSpawn([]);
		const outcome = await runAgentTaskJob(
			job({ ...payload, steps: [{ id: 'lint', command: 'pnpm lint' }] }),
			baseIo({ spawnFn })
		);
		expect(commands.map((c) => (c.includes(CLAUDE) ? 'model' : c))).toEqual(['model', 'pnpm lint', 'pnpm test']);
		expect(outcome.steps).toEqual([{ id: 'lint', status: 'green', exitCode: 0, durationMs: expect.any(Number) }]);
	});

	it('stops at a cancellation between phases', async () => {
		const controller = new AbortController();
		const { spawnFn } = recordingSpawn([]);
		const io = baseIo({
			spawnFn,
			provisionWorkspace: vi.fn(async () => {
				controller.abort(new Error('lease lost'));
				return descriptor;
			})
		});
		await expect(runAgentTaskJob(job(payload), io, controller.signal)).rejects.toThrowError(/lease lost/);
		expect(io.finalizeWorkspace).not.toHaveBeenCalled();
	});
});
