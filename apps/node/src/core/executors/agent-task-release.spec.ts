import { describe, expect, it, vi } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import { FleetTaskWorkspaceError } from '../workspaces/fleet-task-workspace';
import { runAgentTaskJob } from './agent-task';

/**
 * Workspace release (self-build program note §6, R8).
 *
 * The provisioner leases a worktree for the run; the executor has to hand
 * it back when the run is over — on success, on failure, on a throw — or
 * the workspace reaper would treat the checkout as busy until the process
 * dies. And a release that fails must never become the job's verdict.
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

describe('runAgentTaskJob — workspace release', () => {
	it('releases the workspace after a successful run, with the descriptor it provisioned', async () => {
		const releaseWorkspace = vi.fn(async () => undefined);
		const outcome = await runAgentTaskJob(
			job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
			{
				directoryExists: (path) => path === ABSOLUTE,
				provisionWorkspace: vi.fn().mockResolvedValue(descriptor),
				releaseWorkspace,
				spawnFn: fakeSpawn({ passing: 0 })
			}
		);

		expect(outcome.status).toBe('succeeded');
		expect(releaseWorkspace).toHaveBeenCalledOnce();
		expect(releaseWorkspace).toHaveBeenCalledWith('task-1', descriptor);
	});

	it('releases the workspace after a failed run too', async () => {
		const releaseWorkspace = vi.fn(async () => undefined);
		const outcome = await runAgentTaskJob(
			job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'failing' }] }),
			{
				directoryExists: (path) => path === ABSOLUTE,
				provisionWorkspace: vi.fn().mockResolvedValue(descriptor),
				releaseWorkspace,
				spawnFn: fakeSpawn({ failing: 1 })
			}
		);

		expect(outcome.status).toBe('failed');
		expect(releaseWorkspace).toHaveBeenCalledWith('task-1', descriptor);
	});

	it('releases the workspace even when the run THROWS after provisioning', async () => {
		const releaseWorkspace = vi.fn(async () => undefined);
		// Model execution on a node with no CLI configured throws a payload
		// error AFTER the workspace was provisioned.
		await expect(
			runAgentTaskJob(
				job({
					taskId: 'task-1',
					workspace,
					execution: { provider: 'claude-code', instructions: '# do it' }
				}),
				{
					directoryExists: (path) => path === ABSOLUTE,
					provisionWorkspace: vi.fn().mockResolvedValue(descriptor),
					releaseWorkspace,
					modelCli: {},
					spawnFn: fakeSpawn({})
				}
			)
		).rejects.toThrowError(/claude-code CLI/);

		expect(releaseWorkspace).toHaveBeenCalledWith('task-1', descriptor);
	});

	it('does not release when there was nothing provisioned (legacy workspacePath jobs)', async () => {
		const releaseWorkspace = vi.fn(async () => undefined);
		await runAgentTaskJob(
			job({ taskId: 'task-1', workspacePath: ABSOLUTE, steps: [{ id: 'run', command: 'passing' }] }),
			{ directoryExists: () => true, releaseWorkspace, spawnFn: fakeSpawn({ passing: 0 }) }
		);
		expect(releaseWorkspace).not.toHaveBeenCalled();
	});

	it('never lets a failed release change the verdict', async () => {
		const outcome = await runAgentTaskJob(
			job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }),
			{
				directoryExists: (path) => path === ABSOLUTE,
				provisionWorkspace: vi.fn().mockResolvedValue(descriptor),
				releaseWorkspace: vi.fn(async () => {
					throw new Error('EACCES: lease file');
				}),
				spawnFn: fakeSpawn({ passing: 0 })
			}
		);
		expect(outcome.status).toBe('succeeded');
	});
});

describe('runAgentTaskJob — declined provision', () => {
	it.each([
		['disk-low', 'Refusing to provision: 38 MB free on the workspace volume, below the 2.0 GiB floor'],
		['workspace-busy', 'Task workspace is being reclaimed by the workspace reaper (process 4242) and was preserved']
	] as const)('reports a %s refusal through onProvisionDeclined and still rejects with it', async (code, message) => {
		const onProvisionDeclined = vi.fn();
		const releaseWorkspace = vi.fn(async () => undefined);
		const error = new FleetTaskWorkspaceError(code, message);
		await expect(
			runAgentTaskJob(job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }), {
				directoryExists: () => true,
				provisionWorkspace: vi.fn().mockRejectedValue(error),
				releaseWorkspace,
				onProvisionDeclined,
				spawnFn: fakeSpawn({ passing: 0 })
			})
		).rejects.toBe(error);
		expect(onProvisionDeclined).toHaveBeenCalledExactlyOnceWith(message);
		// Nothing was provisioned, so there is nothing to release.
		expect(releaseWorkspace).not.toHaveBeenCalled();
	});

	it('does not report an ordinary provision failure as declined — that one IS a verdict', async () => {
		const onProvisionDeclined = vi.fn();
		await expect(
			runAgentTaskJob(job({ taskId: 'task-1', workspace, steps: [{ id: 'run', command: 'passing' }] }), {
				directoryExists: () => true,
				provisionWorkspace: vi
					.fn()
					.mockRejectedValue(new FleetTaskWorkspaceError('provision-failed', 'Git fetch failed')),
				onProvisionDeclined,
				spawnFn: fakeSpawn({ passing: 0 })
			})
		).rejects.toThrowError(/Git fetch failed/);
		expect(onProvisionDeclined).not.toHaveBeenCalled();
	});
});
