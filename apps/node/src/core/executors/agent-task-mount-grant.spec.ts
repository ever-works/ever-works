import { join } from 'node:path';
import type { AgentTaskIo, AgentTaskScratchFs } from './agent-task';
import type { FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { describe, expect, it, vi } from 'vitest';
import { runAgentTaskJob } from './agent-task';

/**
 * The spawn-site grant assertion is WIRED, not merely written.
 *
 * The provisioner's write probe cannot cover the sandbox grant — it writes
 * from the node process, which no model CLI sandboxes, so it passes with
 * and without `--add-dir`. The grant lives in argv, and this file pins that
 * the executor really does check argv before spawning: `buildModelCliCommand`
 * is stubbed to resolve the mounts and then drop them on the way to the
 * command line, which is precisely the regression a refactor or a new
 * provider branch would introduce. Without the assertion that run spawns
 * happily, reports success and silently discards every cross-repository
 * edit; with it the job fails naming the mount.
 */
const stub = vi.hoisted(() => ({ dropMounts: true }));

vi.mock('./model-cli', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./model-cli')>();
	return {
		...actual,
		buildModelCliCommand: (input: Parameters<typeof actual.buildModelCliCommand>[0]) =>
			actual.buildModelCliCommand(stub.dropMounts ? { ...input, mounts: [] } : input)
	};
});

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
	reused: false,
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
		}
	]
};

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
	execution: { provider: 'claude-code', instructions: '# Task\nChange both.' }
};

const job: FleetJobView = {
	id: 'job-79',
	kind: 'agent-task',
	status: 'leased',
	nodeId: 'node-1',
	requiredCapabilities: [],
	payload: payload as unknown as Record<string, unknown>,
	leaseExpiresAt: null,
	attempts: 1,
	maxAttempts: 3,
	createdAt: null,
	startedAt: null,
	completedAt: null
};

const envelope = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' });

function scratchFs(): AgentTaskScratchFs {
	return {
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async () => undefined,
		readFile: async (path) => (path.endsWith('model-output.json') ? envelope : null),
		remove: async () => undefined
	};
}

const spawnOk = ((command: string, _args: unknown, _options: unknown) => {
	void command;
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

function io(): AgentTaskIo {
	return {
		directoryExists: () => true,
		spawnFn: spawnOk,
		provisionWorkspace: vi.fn(async () => descriptor),
		finalizeWorkspace: vi.fn(async () => ({
			pushed: true,
			headSha: 'b'.repeat(40),
			empty: false,
			changedFiles: 1
		})),
		finalizeMounts: vi.fn(async () => []),
		modelCli: { 'claude-code': CLAUDE, codex: null },
		scratchRoot: SCRATCH,
		scratchFs: scratchFs()
	} as AgentTaskIo;
}

describe('runAgentTaskJob — the mount grant is checked before the spawn', () => {
	it('fails the job naming the mount when the built command carries no grant', async () => {
		stub.dropMounts = true;
		await expect(runAgentTaskJob(job, io())).rejects.toThrowError(
			/'template' \(ever-works\/directory-web-template\) is not granted on the claude-code command line/
		);
	});

	it('runs normally when the command the builder produced does carry it', async () => {
		stub.dropMounts = false;
		const outcome = await runAgentTaskJob(job, io());
		expect(outcome.status).toBe('succeeded');
	});
});
