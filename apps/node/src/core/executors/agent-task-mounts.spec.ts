import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { join } from 'node:path';
import { runAgentTaskJob, type AgentTaskIo, type AgentTaskScratchFs } from './agent-task';
import { ownerQuestionPath, type AgentTaskQuestionFs } from './agent-task-question';

/**
 * Multi-repo Task workspaces (self-build slice C) at the executor seam.
 *
 * The provisioner and the Git work are faked; what is pinned here is the
 * executor's contract with the platform: writable mounts are finalized
 * BEFORE the primary, every mount gets its own verdict in `mountGit`, a
 * failed mount makes the run `failed` naming the mount while the others
 * (and the primary) still report, and a workspace without writable mounts
 * reports exactly what a single-repository run always did.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const CODEX = process.platform === 'win32' ? 'C:\\npm\\codex.cmd' : '/usr/local/bin/codex';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';

const primary: FleetTaskWorkspaceDescriptor = {
	path: ABSOLUTE,
	repositoryId: 'ever-works/ever-works',
	baseRef: 'develop',
	branch: 'task/t1-fix',
	baseSha: 'a'.repeat(40),
	headSha: 'a'.repeat(40),
	reused: false
};

const withMounts: FleetTaskWorkspaceDescriptor = {
	...primary,
	mounts: [
		{
			path: join(ABSOLUTE, '..', 'template-worktree'),
			linkPath: join(ABSOLUTE, '.mounts', 'template'),
			repositoryId: 'ever-works/directory-web-template',
			baseRef: 'develop',
			branch: 'task/t1-fix',
			baseSha: 'c'.repeat(40),
			headSha: 'c'.repeat(40),
			reused: false,
			mountDir: 'template',
			writable: true
		},
		{
			path: join(ABSOLUTE, '..', 'workspace-worktree'),
			linkPath: join(ABSOLUTE, '.mounts', 'workspace'),
			repositoryId: 'ever-works/workspace',
			baseRef: 'develop',
			branch: 'task/t1-fix',
			baseSha: 'd'.repeat(40),
			headSha: 'd'.repeat(40),
			reused: false,
			mountDir: 'workspace',
			writable: false
		}
	]
};

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-78',
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
	result: 'Changed both repositories.',
	total_cost_usd: 0.5,
	num_turns: 3,
	session_id: 'sess-2'
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

/**
 * In-memory owner-question filesystem (self-build slice Q). Every read and
 * removal is logged to `log` so a test can interleave it with the finalize
 * `order`; the default double logs to its own list so the existing
 * `['mounts', 'primary']` assertions stay exact.
 */
function questionFs(seed: Record<string, string> = {}, log: string[] = []) {
	const files = new Map<string, string>(Object.entries(seed));
	const fs: AgentTaskQuestionFs & { files: Map<string, string> } = {
		files,
		readHead: async (path, maxBytes) => {
			log.push(`read:${path}`);
			const content = files.get(path);
			if (content === undefined) return null;
			return Buffer.from(content, 'utf8').subarray(0, maxBytes).toString('utf8');
		},
		remove: async (path) => {
			log.push(`remove:${path}`);
			files.delete(path);
		},
		removeDirIfEmpty: async () => undefined
	};
	return fs;
}

function spawnOk(commands?: string[]) {
	return ((command: string) => {
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => handlers.get('close')?.(0));
		commands?.push(command);
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

const payload = {
	taskId: 't1',
	runId: 'run-2',
	agentId: 'agent-1',
	workspace: {
		repositoryId: 'ever-works/ever-works',
		repoUrl: 'https://github.com/ever-works/ever-works.git',
		baseRef: 'develop',
		branch: 'task/t1-fix',
		mounts: [
			{
				repositoryId: 'ever-works/directory-web-template',
				repoUrl: 'https://github.com/ever-works/directory-web-template.git',
				baseRef: 'develop',
				branch: 'task/t1-fix',
				mountDir: 'template',
				writable: true
			}
		]
	},
	execution: {
		provider: 'claude-code',
		instructions: '# Task\nChange both.',
		effort: 'high'
	}
};

function io(over: Partial<AgentTaskIo> = {}): AgentTaskIo & { order: string[] } {
	const order: string[] = [];
	return {
		order,
		directoryExists: () => true,
		spawnFn: spawnOk(),
		provisionWorkspace: vi.fn(async () => withMounts),
		finalizeWorkspace: vi.fn(async () => {
			order.push('primary');
			return { pushed: true, headSha: 'b'.repeat(40), empty: false, changedFiles: 2 };
		}),
		// Typed explicitly: vitest's default `Procedure` signature would leave
		// `descriptor` as `any`, and the package type-check (which includes
		// every spec) refuses the implicit-any callbacks below.
		finalizeMounts: vi.fn(async (_taskId: string, descriptor: FleetTaskWorkspaceDescriptor) => {
			order.push('mounts');
			return (descriptor.mounts ?? [])
				.filter((mount) => mount.writable)
				.map((mount) => ({
					repositoryId: mount.repositoryId,
					mountDir: mount.mountDir,
					branch: mount.branch,
					baseSha: mount.baseSha,
					pushed: true,
					headSha: 'e'.repeat(40),
					empty: false,
					changedFiles: 1
				}));
		}),
		modelCli: { 'claude-code': CLAUDE, codex: null },
		scratchRoot: SCRATCH,
		scratchFs: scratchFs(),
		questionFs: questionFs(),
		...over
	} as AgentTaskIo & { order: string[] };
}

describe('runAgentTaskJob — multi-repo mounts', () => {
	it('finalizes writable mounts before the primary and reports one verdict per mount', async () => {
		const deps = io();
		const outcome = await runAgentTaskJob(job(payload), deps);

		expect(outcome.status).toBe('succeeded');
		expect(deps.order).toEqual(['mounts', 'primary']);
		expect(deps.finalizeMounts).toHaveBeenCalledWith(
			't1',
			withMounts,
			{ commitMessage: 'feat(task): t1 agent run output', push: true },
			undefined
		);
		expect(outcome.git).toMatchObject({ branch: 'task/t1-fix', pushed: true });
		expect(outcome.mountGit).toEqual([
			{
				repositoryId: 'ever-works/directory-web-template',
				mountDir: 'template',
				branch: 'task/t1-fix',
				baseSha: 'c'.repeat(40),
				headSha: 'e'.repeat(40),
				empty: false,
				pushed: true,
				changedFiles: 1
			}
		]);
		expect(outcome.workspace).toEqual(withMounts);
	});

	it('fails the run naming the mount when a mount push fails, while the primary still reports', async () => {
		const deps = io({
			finalizeMounts: vi.fn(async () => [
				{
					repositoryId: 'ever-works/directory-web-template',
					mountDir: 'template',
					branch: 'task/t1-fix',
					baseSha: 'c'.repeat(40),
					pushed: false,
					headSha: null,
					empty: false,
					error: 'push rejected: protected branch'
				}
			])
		});
		const outcome = await runAgentTaskJob(job(payload), deps);

		expect(outcome.status).toBe('failed');
		expect(outcome.failureReason).toContain('git finalize failed for mount template: push rejected');
		expect(outcome.git).toMatchObject({ pushed: true });
		expect(outcome.mountGit?.[0]?.error).toBe('push rejected: protected branch');
		expect(deps.finalizeWorkspace).toHaveBeenCalledTimes(1);
	});

	it('reports every writable mount as failed when the node has no mount finalizer', async () => {
		const deps = io({ finalizeMounts: undefined });
		const outcome = await runAgentTaskJob(job(payload), deps);

		expect(outcome.status).toBe('failed');
		expect(outcome.failureReason).toContain('this node has no mount finalizer configured');
		expect(outcome.mountGit).toEqual([
			expect.objectContaining({
				mountDir: 'template',
				pushed: false,
				error: expect.stringContaining('no mount finalizer')
			})
		]);
	});

	it('omits mountGit entirely when the workspace has no writable mounts', async () => {
		const readOnlyOnly: FleetTaskWorkspaceDescriptor = {
			...withMounts,
			mounts: withMounts.mounts!.filter((mount) => !mount.writable)
		};
		const deps = io({ provisionWorkspace: vi.fn(async () => readOnlyOnly) });
		const outcome = await runAgentTaskJob(job(payload), deps);

		expect(outcome.status).toBe('succeeded');
		expect(deps.finalizeMounts).not.toHaveBeenCalled();
		expect('mountGit' in outcome).toBe(false);
		expect(deps.order).toEqual(['primary']);
	});

	it('grants the descriptor mounts to the model CLI, by worktree and never by link', async () => {
		// The whole premise of a multi-repo run: the descriptor's mounts must
		// reach the spawn builder. Without the grant the CLI is confined to
		// its cwd, the model's edits to `.mounts/<dir>` are refused, and the
		// run reports success having changed only the primary repository.
		const commands: string[] = [];
		const writable = withMounts.mounts!.find((mount) => mount.writable)!;
		const readOnly = withMounts.mounts!.find((mount) => !mount.writable)!;

		const outcome = await runAgentTaskJob(job(payload), io({ spawnFn: spawnOk(commands) }));

		expect(outcome.status).toBe('succeeded');
		expect(commands[0]).toContain(CLAUDE);
		expect(commands[0]).toContain(`--add-dir "${writable.path}" "${readOnly.path}"`);
		// The grant is each mount's own worktree, never the link inside the
		// primary and never an ancestor holding other Tasks' worktrees.
		expect(commands[0]).not.toContain('.mounts');
	});

	it('grants codex the writable mount only — its --add-dir is a write grant', async () => {
		const commands: string[] = [];
		const writable = withMounts.mounts!.find((mount) => mount.writable)!;
		const readOnly = withMounts.mounts!.find((mount) => !mount.writable)!;

		const outcome = await runAgentTaskJob(
			job({ ...payload, execution: { ...payload.execution, provider: 'codex' } }),
			io({ spawnFn: spawnOk(commands), modelCli: { 'claude-code': null, codex: CODEX } })
		);

		expect(outcome.status).toBe('succeeded');
		expect(commands[0]).toContain(`--add-dir "${writable.path}"`);
		expect(commands[0]).not.toContain(readOnly.path);
	});

	it('spawns the unchanged single-repository command when the workspace has no mounts', async () => {
		const commands: string[] = [];
		await runAgentTaskJob(
			job({ ...payload, workspace: { ...payload.workspace, mounts: [] } }),
			io({ spawnFn: spawnOk(commands), provisionWorkspace: vi.fn(async () => primary) })
		);
		expect(commands[0]).not.toContain('--add-dir');
	});

	it('honours the git policy: no commit means neither mounts nor the primary are finalized', async () => {
		const deps = io();
		const outcome = await runAgentTaskJob(job({ ...payload, git: { commit: false } }), deps);

		expect(outcome.status).toBe('succeeded');
		expect(deps.finalizeMounts).not.toHaveBeenCalled();
		expect(deps.finalizeWorkspace).not.toHaveBeenCalled();
		expect('mountGit' in outcome).toBe(false);
		expect('git' in outcome).toBe(false);
	});
});

describe('runAgentTaskJob — owner question across mounts (self-build slice Q)', () => {
	const PRIMARY_QUESTION = ownerQuestionPath(primary.path);
	const TEMPLATE_QUESTION = ownerQuestionPath(withMounts.mounts![0]!.path);
	const READ_ONLY_PATH = withMounts.mounts![1]!.path;

	it('discards, then scans the primary and each writable mount — never the read-only one — before any finalizer', async () => {
		const deps = io();
		// Log into the same `order` the finalizers write to, so the relative
		// position of every question step is pinned, not just its presence.
		deps.questionFs = questionFs({}, deps.order);

		const outcome = await runAgentTaskJob(job(payload), deps);

		expect(outcome.status).toBe('succeeded');
		expect('question' in outcome).toBe(false);
		expect(deps.order).toEqual([
			// Pre-model discard: primary, then the writable mount.
			`remove:${PRIMARY_QUESTION}`,
			`remove:${TEMPLATE_QUESTION}`,
			// Post-model collect, in the same order (absent → no removal).
			`read:${PRIMARY_QUESTION}`,
			`read:${TEMPLATE_QUESTION}`,
			// Only THEN the Git work.
			'mounts',
			'primary'
		]);
		expect(deps.order.some((entry) => entry.includes(READ_ONLY_PATH))).toBe(false);
	});

	it('reports a question found only in a writable mount, naming the mount, and removes it before the mount push', async () => {
		const deps = io();
		deps.questionFs = questionFs(
			{ [TEMPLATE_QUESTION]: '# Rename the template component too?\n\nThe platform side is done.' },
			deps.order
		);
		// The file appears AFTER the discard: the double seeds it up front, so
		// the pre-model discard would wipe it. Re-seed it when the model runs.
		const spawn = deps.spawnFn as unknown as (command: string, options: unknown) => unknown;
		deps.spawnFn = ((command: string, options: unknown) => {
			if (command.includes(CLAUDE)) {
				(deps.questionFs as ReturnType<typeof questionFs>).files.set(
					TEMPLATE_QUESTION,
					'# Rename the template component too?\n\nThe platform side is done.'
				);
			}
			return spawn(command, options);
		}) as never;

		const outcome = await runAgentTaskJob(job(payload), deps);

		expect(outcome.question).toEqual({
			text: 'Rename the template component too?',
			context: 'The platform side is done.',
			truncated: false,
			mountDir: 'template'
		});
		expect(outcome.status).toBe('succeeded');
		expect(outcome.mountGit?.[0]).toMatchObject({ mountDir: 'template', pushed: true });
		expect((deps.questionFs as ReturnType<typeof questionFs>).files.size).toBe(0);
		expect(deps.order.indexOf(`remove:${TEMPLATE_QUESTION}`, 2)).toBeLessThan(deps.order.indexOf('mounts'));
	});
});
