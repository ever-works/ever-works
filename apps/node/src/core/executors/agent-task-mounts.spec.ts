import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { join } from 'node:path';
import { runAgentTaskJob, type AgentTaskIo, type AgentTaskScratchFs } from './agent-task';

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

function spawnOk() {
	return ((command: string) => {
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => handlers.get('close')?.(0));
		void command;
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
		finalizeMounts: vi.fn(async (_taskId, descriptor) => {
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
