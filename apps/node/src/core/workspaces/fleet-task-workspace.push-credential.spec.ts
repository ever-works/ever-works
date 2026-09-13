import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FleetTaskWorkspaceProvisioner, type FleetWorkspacePlugin } from './fleet-task-workspace';
import { PushCredentialSession } from './push-credential';

/**
 * Scoped push credentials at the PROVISIONER boundary (self-build slice
 * AM, EW-810).
 *
 * This is where the fleet's fail-closed rule lives: a node publishes with
 * a repository-scoped credential minted for this job, or it does not
 * publish. The alternative it used to take — letting Git answer with the
 * machine's own credential helper, a long-lived personal access token
 * with write access to every repository that OS user can reach — is the
 * gap the slice closes, so every case here checks that nothing reaches
 * the provider unless the credential did.
 */

const SHA = 'a'.repeat(40);
const NODE_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'ghs_0123456789abcdefghijklmnopqrstuvwxyz';
const ORIGIN = 'https://github.com/ever-works/ever-works.git';

const descriptorFor = (path: string) => ({
	path,
	repositoryId: 'ever-works/ever-works',
	baseRef: 'main',
	branch: 'task/scoped-push',
	baseSha: SHA,
	headSha: SHA,
	reused: false
});

const session = (repositories: string[] = ['ever-works/ever-works'], push = true) =>
	new PushCredentialSession({
		jobId: JOB_ID,
		client: {
			mintPushCredential: async () => ({
				attribution: {
					nodeId: NODE_ID,
					nodeName: 'studio-win',
					agentId: null,
					agentName: null,
					agentEmail: null,
					jobId: JOB_ID,
					runId: null
				},
				push: push
					? {
							token: TOKEN,
							username: 'x-access-token',
							expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
							repositories
						}
					: null
			})
		}
	});

function harness(options: { originUrl?: string; finalizeImpl?: () => Promise<unknown> } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'ew-fleet-scoped-push-'));
	const worktree = join(root, 'repositories', 'r', 'worktrees', 'w');
	mkdirSync(worktree, { recursive: true });
	const finalize = vi.fn(
		(options.finalizeImpl ?? (async () => ({ pushed: true, headSha: SHA, empty: false, changedFiles: 1 }))) as (
			handle: unknown,
			opts: Record<string, unknown>
		) => Promise<unknown>
	);
	const plugin = { provision: vi.fn(), finalize } as unknown as FleetWorkspacePlugin;
	const provisioner = new FleetTaskWorkspaceProvisioner({
		rootPath: root,
		plugin,
		readOriginUrl: async () => options.originUrl ?? ORIGIN
	});
	return { root, worktree, finalize, provisioner, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('FleetTaskWorkspaceProvisioner.finalize — a fleet publish is never token-free', () => {
	it('REFUSES to publish when no credential provider is wired, and the provider is never called', async () => {
		const { worktree, finalize, provisioner, cleanup } = harness();
		try {
			await expect(
				provisioner.finalize('task-0001', descriptorFor(worktree), {
					commitMessage: 'feat: x',
					push: true
				})
			).rejects.toMatchObject({ code: 'push-credential' });
			// Not "committed but not pushed": the provider never ran at all,
			// so there is no chance of a `git push` reaching the network
			// with whatever this machine's credential helper answers.
			expect(finalize).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it('names the reason an operator can act on', async () => {
		const { worktree, provisioner, cleanup } = harness();
		try {
			await expect(
				provisioner.finalize('task-0001', descriptorFor(worktree), {
					commitMessage: 'feat: x',
					push: true
				})
			).rejects.toThrow(/never pushes with the machine/);
		} finally {
			cleanup();
		}
	});

	it('still allows a COMMIT-ONLY finalize without a provider — there is nothing to authorise', async () => {
		const { worktree, finalize, provisioner, cleanup } = harness({
			finalizeImpl: async () => ({ pushed: false, headSha: SHA, empty: false })
		});
		try {
			const result = await provisioner.finalize('task-0001', descriptorFor(worktree), {
				commitMessage: 'feat: x',
				push: false
			});
			expect(result.pushed).toBe(false);
			expect(finalize).toHaveBeenCalledTimes(1);
			// No identity and no credential: exactly the shape a caller with
			// no job channel (a test, an embedder) always got.
			expect(Object.keys(finalize.mock.calls[0]![1]).sort()).toEqual(['commitMessage', 'push']);
		} finally {
			cleanup();
		}
	});

	it('hands the provider the scoped credential and the attributed message', async () => {
		const { worktree, finalize, provisioner, cleanup } = harness();
		try {
			await provisioner.finalize('task-0001', descriptorFor(worktree), {
				commitMessage: 'feat: x',
				push: true,
				pushCredentials: session()
			});

			const opts = finalize.mock.calls[0]![1] as unknown as {
				commitMessage: string;
				pushCredential: { token: string; remoteUrl: string; username: string };
				identity: { committerName: string };
			};
			expect(opts.pushCredential).toEqual({
				username: 'x-access-token',
				token: TOKEN,
				// The remote READ FROM THE CHECKOUT, not one carried down
				// from the job spec: the credential must be keyed to what
				// Git is actually about to write.
				remoteUrl: ORIGIN
			});
			expect(opts.identity.committerName).toBe('Ever Works node studio-win');
			expect(opts.commitMessage).toContain(`Ever-Works-Node: studio-win (${NODE_ID})`);
		} finally {
			cleanup();
		}
	});

	it('REFUSES when the checkout points at a repository the credential does not cover', async () => {
		const { worktree, finalize, provisioner, cleanup } = harness({
			originUrl: 'https://github.com/someone-else/private.git'
		});
		try {
			await expect(
				provisioner.finalize('task-0001', descriptorFor(worktree), {
					commitMessage: 'feat: x',
					push: true,
					pushCredentials: session()
				})
			).rejects.toMatchObject({ code: 'push-credential' });
			expect(finalize).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it('REFUSES when the checkout has no readable origin at all', async () => {
		const { worktree, finalize, provisioner, cleanup } = harness();
		const broken = new FleetTaskWorkspaceProvisioner({
			rootPath: (provisioner as unknown as { rootPath: string }).rootPath,
			plugin: { provision: vi.fn(), finalize } as unknown as FleetWorkspacePlugin,
			readOriginUrl: async () => {
				throw new Error('not a git repository');
			}
		});
		try {
			await expect(
				broken.finalize('task-0001', descriptorFor(worktree), {
					commitMessage: 'feat: x',
					push: true,
					pushCredentials: session()
				})
			).rejects.toMatchObject({ code: 'push-credential' });
			expect(finalize).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it('REFUSES a payload commit message that forged a reserved trailer', async () => {
		// Attribution that a Task title could write is attribution that
		// means nothing. Refused before any Git command runs.
		const { worktree, finalize, provisioner, cleanup } = harness();
		try {
			await expect(
				provisioner.finalize('task-0001', descriptorFor(worktree), {
					commitMessage: 'feat: x\n\nEver-Works-Node: someone-elses-laptop (deadbeef)',
					push: true,
					pushCredentials: session()
				})
			).rejects.toMatchObject({ code: 'push-credential' });
			expect(finalize).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it('REFUSES when the platform says this job does not push but the caller believes it does', async () => {
		const { worktree, finalize, provisioner, cleanup } = harness();
		try {
			await expect(
				provisioner.finalize('task-0001', descriptorFor(worktree), {
					commitMessage: 'feat: x',
					push: true,
					pushCredentials: session(['ever-works/ever-works'], false)
				})
			).rejects.toMatchObject({ code: 'push-credential' });
			expect(finalize).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it('attributes a commit-only run and mints no write credential for it', async () => {
		const { worktree, finalize, provisioner, cleanup } = harness({
			finalizeImpl: async () => ({ pushed: false, headSha: SHA, empty: false })
		});
		try {
			await provisioner.finalize('task-0001', descriptorFor(worktree), {
				commitMessage: 'feat: x',
				push: false,
				pushCredentials: session(['ever-works/ever-works'], false)
			});
			const opts = finalize.mock.calls[0]![1];
			expect(opts.identity).toBeDefined();
			expect(opts.pushCredential).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it('scrubs the token out of a Git failure before it can reach the job result', async () => {
		// `FleetAgentTaskGitResult.error` is stored verbatim in
		// `fleet_jobs.result` and rendered on the Task page.
		const { worktree, provisioner, cleanup } = harness({
			finalizeImpl: async () => {
				throw new Error(`git push failed: remote rejected (token ${TOKEN})`);
			}
		});
		try {
			await expect(
				provisioner.finalize('task-0001', descriptorFor(worktree), {
					commitMessage: 'feat: x',
					push: true,
					pushCredentials: session()
				})
			).rejects.toThrow(
				expect.objectContaining({
					message: expect.not.stringContaining(TOKEN)
				}) as Error
			);
		} finally {
			cleanup();
		}
	});
});
