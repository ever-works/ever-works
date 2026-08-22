import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	FleetTaskWorkspaceError,
	FleetTaskWorkspaceProvisioner,
	type FleetWorkspacePlugin
} from './fleet-task-workspace';

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const SHA = 'a'.repeat(40);

describe.sequential('FleetTaskWorkspaceProvisioner — real Git worktrees', () => {
	let ownedRoot: string;
	let seedDir: string;
	let originDir: string;
	let workspaceRoot: string;
	let seedSha: string;
	let gitConfigIndex: number;
	const remoteUrl = 'https://fleet-workspace.invalid/ever/repository.git';

	const workspace = (branch: string) => ({
		repositoryId: 'ever/repository',
		repoUrl: remoteUrl,
		baseRef: 'main',
		branch
	});

	beforeAll(() => {
		ownedRoot = mkdtempSync(join(tmpdir(), 'ew-fleet-task-workspace-'));
		seedDir = join(ownedRoot, 'seed');
		originDir = join(ownedRoot, 'origin.git');
		workspaceRoot = join(ownedRoot, 'fleet-root');
		mkdirSync(seedDir, { recursive: true });
		mkdirSync(originDir, { recursive: true });
		git(originDir, 'init', '--bare', '--initial-branch', 'main');
		git(seedDir, 'init', '--initial-branch', 'main');
		writeFileSync(join(seedDir, 'README.md'), 'fleet workspace\n');
		git(seedDir, 'add', 'README.md');
		git(seedDir, '-c', 'user.name=Fleet Test', '-c', 'user.email=fleet@test.invalid', 'commit', '-m', 'seed');
		git(seedDir, 'push', pathToFileURL(originDir).toString(), 'HEAD:refs/heads/main');
		seedSha = git(seedDir, 'rev-parse', 'HEAD');

		// Exercise the production HTTPS validator and real Git without a
		// network dependency. Git rewrites this suite's fake HTTPS origin to
		// the test-owned bare repository for child processes only.
		gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT ?? '0');
		process.env.GIT_CONFIG_COUNT = String(gitConfigIndex + 1);
		process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`] = `url.${pathToFileURL(originDir).toString()}.insteadOf`;
		process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`] = remoteUrl;
	});

	afterAll(async () => {
		delete process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`];
		delete process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`];
		if (gitConfigIndex === 0) delete process.env.GIT_CONFIG_COUNT;
		else process.env.GIT_CONFIG_COUNT = String(gitConfigIndex);
		await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
	});

	it('creates one linked task worktree from the fetched base and returns a typed descriptor', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await provisioner.provision('task-0001', workspace('task/fleet-0001'));

		expect(descriptor).toMatchObject({
			repositoryId: 'ever/repository',
			baseRef: 'main',
			branch: 'task/fleet-0001',
			baseSha: seedSha,
			headSha: seedSha,
			reused: false
		});
		expect(parse(descriptor.path).root).not.toBe(descriptor.path);
		expect(relative(workspaceRoot, descriptor.path)).not.toMatch(/^\.\.(?:[\\/]|$)/);
		expect((await fs.stat(join(descriptor.path, '.git'))).isFile()).toBe(true);
		expect(git(descriptor.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/fleet-0001');
		const repositoryRoots = readdirSync(join(workspaceRoot, 'repositories'));
		expect(repositoryRoots).toHaveLength(1);
		expect(readdirSync(join(workspaceRoot, 'repositories', repositoryRoots[0], 'repos'))).toHaveLength(1);
	});

	it('is idempotent for one task and keeps its deterministic workspace', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const first = await provisioner.provision('task-0002', workspace('task/fleet-0002'));
		writeFileSync(join(first.path, 'scratch.txt'), 'survives retry\n');

		const retry = await provisioner.provision('task-0002', workspace('task/fleet-0002'));
		expect(retry.path).toBe(first.path);
		expect(retry.reused).toBe(true);
		expect(await fs.readFile(join(retry.path, 'scratch.txt'), 'utf8')).toBe('survives retry\n');
	});

	it('isolates concurrent tasks for the same repository', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const [first, second] = await Promise.all([
			provisioner.provision('task-0003', workspace('task/fleet-0003')),
			provisioner.provision('task-0004', workspace('task/fleet-0004'))
		]);

		expect(first.path).not.toBe(second.path);
		expect(first.headSha).toBe(seedSha);
		expect(second.headSha).toBe(seedSha);
		const repositoryRoots = readdirSync(join(workspaceRoot, 'repositories'));
		expect(repositoryRoots).toHaveLength(1);
		expect(readdirSync(join(workspaceRoot, 'repositories', repositoryRoots[0], 'repos'))).toHaveLength(1);
	});

	it('self-heals a stale task-owned worktree when its branch binding changes', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const first = await provisioner.provision('task-0005', workspace('task/fleet-old'));
		writeFileSync(join(first.path, 'stale.txt'), 'foreign state\n');

		const healed = await provisioner.provision('task-0005', workspace('task/fleet-new'));
		expect(healed.path).toBe(first.path);
		expect(healed.reused).toBe(false);
		expect(existsSync(join(healed.path, 'stale.txt'))).toBe(false);
		expect(git(healed.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/fleet-new');
	});
});

describe('FleetTaskWorkspaceProvisioner — refusal and diagnostics', () => {
	const rootPath = mkdtempSync(join(tmpdir(), 'ew-fleet-workspace-validation-'));
	const valid = {
		repositoryId: 'ever/repository',
		repoUrl: 'https://github.com/ever/repository.git',
		baseRef: 'develop',
		branch: 'task/example-12345678'
	};

	afterAll(async () => {
		await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 3 });
	});

	it('requires a nested absolute root, never a relative path or drive/filesystem root', () => {
		expect(() => new FleetTaskWorkspaceProvisioner({ rootPath: 'relative/workspaces' })).toThrowError(
			FleetTaskWorkspaceError
		);
		expect(() => new FleetTaskWorkspaceProvisioner({ rootPath: parse(rootPath).root })).toThrowError(
			/filesystem root/
		);
	});

	it.each([
		['missing repository metadata', { ...valid, repositoryId: '' }],
		['repository traversal', { ...valid, repositoryId: '../other' }],
		['absolute task id', valid, parse(rootPath).root],
		['task traversal', valid, '../task'],
		['option-like base ref', { ...valid, baseRef: '--upload-pack=bad' }],
		['ref traversal', { ...valid, branch: 'task/../escape' }],
		['local repository path', { ...valid, repoUrl: join(rootPath, 'repo.git') }],
		['file URL', { ...valid, repoUrl: 'file:///tmp/repo.git' }],
		['HTTPS credentials', { ...valid, repoUrl: 'https://user:secret@github.com/ever/repository.git' }],
		['URL query credentials', { ...valid, repoUrl: 'https://github.com/ever/repository.git?token=secret' }],
		['raw URL path traversal', { ...valid, repoUrl: 'https://github.com/ever/../repository.git' }],
		['encoded URL path traversal', { ...valid, repoUrl: 'https://github.com/ever/%2e%2e/repository.git' }]
	])('refuses %s before invoking Git', async (_name, spec, taskId = 'task-0001') => {
		const plugin = { provision: vi.fn() } as unknown as FleetWorkspacePlugin;
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, plugin });

		await expect(provisioner.provision(taskId, spec)).rejects.toBeInstanceOf(FleetTaskWorkspaceError);
		expect(plugin.provision).not.toHaveBeenCalled();
	});

	it('rejects a plugin path outside the configured task root', async () => {
		const plugin: FleetWorkspacePlugin = {
			provision: async () => ({
				path: join(rootPath, '..', 'foreign-workspace'),
				baseSha: SHA,
				reused: false,
				branch: valid.branch,
				bindingKey: 'foreign'
			})
		};
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, plugin });

		await expect(provisioner.provision('task-0001', valid)).rejects.toMatchObject({ code: 'path-collision' });
	});

	it('preserves an unowned directory at the deterministic path instead of letting self-heal delete it', async () => {
		const ownedRoot = mkdtempSync(join(tmpdir(), 'ew-fleet-collision-'));
		try {
			const repositoryKey = createHash('sha256')
				.update(valid.repositoryId)
				.update('\0')
				.update(valid.repoUrl)
				.digest('hex')
				.slice(0, 32);
			const bindingKey = `fleet-${createHash('sha256')
				.update(valid.repositoryId)
				.update('\0')
				.update('task-0001')
				.digest('hex')
				.slice(0, 32)}`;
			const collisionPath = join(ownedRoot, 'repositories', repositoryKey, 'worktrees', bindingKey);
			mkdirSync(collisionPath, { recursive: true });
			writeFileSync(join(collisionPath, 'keep.txt'), 'not owned by Fleet\n');
			const plugin = { provision: vi.fn() } as unknown as FleetWorkspacePlugin;
			const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: ownedRoot, plugin });

			await expect(provisioner.provision('task-0001', valid)).rejects.toMatchObject({ code: 'path-collision' });
			expect(plugin.provision).not.toHaveBeenCalled();
			expect(await fs.readFile(join(collisionPath, 'keep.txt'), 'utf8')).toBe('not owned by Fleet\n');
		} finally {
			await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it('refuses a repository-cache junction that redirects writes outside the configured root', async () => {
		const guardedRoot = mkdtempSync(join(tmpdir(), 'ew-fleet-root-guard-'));
		const foreignRoot = mkdtempSync(join(tmpdir(), 'ew-fleet-foreign-'));
		try {
			await fs.symlink(
				foreignRoot,
				join(guardedRoot, 'repositories'),
				process.platform === 'win32' ? 'junction' : 'dir'
			);
			const plugin = { provision: vi.fn() } as unknown as FleetWorkspacePlugin;
			const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: guardedRoot, plugin });

			await expect(provisioner.provision('task-0001', valid)).rejects.toMatchObject({ code: 'path-collision' });
			expect(plugin.provision).not.toHaveBeenCalled();
			expect(await fs.readdir(foreignRoot)).toEqual([]);
		} finally {
			await fs.rm(guardedRoot, { recursive: true, force: true, maxRetries: 3 });
			await fs.rm(foreignRoot, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it('sanitizes fetch/authentication failures without echoing a clone URL or secret', async () => {
		const plugin: FleetWorkspacePlugin = {
			provision: async () => {
				throw new Error('fatal: https://user:super-secret@example.invalid/private.git authentication failed');
			}
		};
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, plugin });

		const failure = await provisioner.provision('task-0001', valid).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: 'provision-failed' });
		expect(String((failure as Error).message)).not.toContain('super-secret');
		expect(String((failure as Error).message)).not.toContain(valid.repoUrl);
	});

	it('fails a pre-cancelled request without provisioning anything', async () => {
		const plugin = { provision: vi.fn() } as unknown as FleetWorkspacePlugin;
		const controller = new AbortController();
		controller.abort();
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, plugin });

		await expect(provisioner.provision('task-0001', valid, controller.signal)).rejects.toMatchObject({
			code: 'cancelled'
		});
		expect(plugin.provision).not.toHaveBeenCalled();
	});

	it('reports cancellation that arrives during provisioning and leaves the task workspace reusable', async () => {
		const controller = new AbortController();
		const expectedPath = join(rootPath, 'worktrees', 'owned-task-worktree');
		const plugin: FleetWorkspacePlugin = {
			provision: async () => {
				controller.abort();
				return {
					path: expectedPath,
					baseSha: SHA,
					reused: false,
					branch: valid.branch,
					bindingKey: 'owned-task-worktree'
				};
			}
		};
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, plugin });

		await expect(provisioner.provision('task-0001', valid, controller.signal)).rejects.toMatchObject({
			code: 'cancelled'
		});
	});
});
