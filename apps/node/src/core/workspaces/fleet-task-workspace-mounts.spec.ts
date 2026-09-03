import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLEET_TASK_WORKSPACE_MOUNTS_DIR, FleetTaskWorkspaceProvisioner } from './fleet-task-workspace';

/**
 * Multi-repo Task workspaces (self-build slice C) against real Git.
 *
 * Two bare origins stand in for the primary repository and one mounted
 * repository. What must hold: the mount is its OWN binding under the fleet
 * root (own pool, own worktree, own Task branch), it is reachable from the
 * primary worktree at `.mounts/<dir>`, the primary's Git never sees it, and
 * `finalizeMounts` commits and pushes the mount's branch to ITS origin —
 * while a read-only mount is never touched.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const temporaryRoot = (prefix: string): string =>
	realpathSync.native(mkdtempSync(join(realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir()), prefix)));

describe.sequential('FleetTaskWorkspaceProvisioner — mounts (real Git)', { timeout: 30_000 }, () => {
	let ownedRoot: string;
	let workspaceRoot: string;
	let primaryOrigin: string;
	let mountOrigin: string;
	let primarySeedSha: string;
	let mountSeedSha: string;
	let configIndex: number;
	const primaryUrl = 'https://fleet-mounts.invalid/ever/platform.git';
	const mountUrl = 'https://fleet-mounts.invalid/ever/template.git';

	const seed = (dir: string, origin: string, file: string): string => {
		mkdirSync(dir, { recursive: true });
		git(dir, 'init', '--initial-branch', 'main');
		writeFileSync(join(dir, file), `${file}\n`);
		git(dir, 'add', file);
		git(dir, '-c', 'user.name=Fleet Test', '-c', 'user.email=fleet@test.invalid', 'commit', '-m', 'seed');
		git(dir, 'push', pathToFileURL(origin).toString(), 'HEAD:refs/heads/main');
		return git(dir, 'rev-parse', 'HEAD');
	};

	const spec = (branch: string, writable = true) => ({
		repositoryId: 'ever/platform',
		repoUrl: primaryUrl,
		baseRef: 'main',
		branch,
		mounts: [
			{
				repositoryId: 'ever/template',
				repoUrl: mountUrl,
				baseRef: 'main',
				branch,
				mountDir: 'template',
				writable
			}
		]
	});

	beforeAll(() => {
		ownedRoot = temporaryRoot('ew-fleet-mounts-');
		workspaceRoot = join(ownedRoot, 'fleet-root');
		primaryOrigin = join(ownedRoot, 'platform.git');
		mountOrigin = join(ownedRoot, 'template.git');
		mkdirSync(primaryOrigin, { recursive: true });
		mkdirSync(mountOrigin, { recursive: true });
		git(primaryOrigin, 'init', '--bare', '--initial-branch', 'main');
		git(mountOrigin, 'init', '--bare', '--initial-branch', 'main');
		primarySeedSha = seed(join(ownedRoot, 'seed-platform'), primaryOrigin, 'PLATFORM.md');
		mountSeedSha = seed(join(ownedRoot, 'seed-template'), mountOrigin, 'TEMPLATE.md');

		// Same trick as the single-repository suite: the production HTTPS
		// validator sees remote URLs, Git rewrites them to the bare origins.
		configIndex = Number(process.env.GIT_CONFIG_COUNT ?? '0');
		process.env.GIT_CONFIG_COUNT = String(configIndex + 2);
		process.env[`GIT_CONFIG_KEY_${configIndex}`] = `url.${pathToFileURL(primaryOrigin).toString()}.insteadOf`;
		process.env[`GIT_CONFIG_VALUE_${configIndex}`] = primaryUrl;
		process.env[`GIT_CONFIG_KEY_${configIndex + 1}`] = `url.${pathToFileURL(mountOrigin).toString()}.insteadOf`;
		process.env[`GIT_CONFIG_VALUE_${configIndex + 1}`] = mountUrl;
	});

	afterAll(async () => {
		for (const offset of [0, 1]) {
			delete process.env[`GIT_CONFIG_KEY_${configIndex + offset}`];
			delete process.env[`GIT_CONFIG_VALUE_${configIndex + offset}`];
		}
		if (configIndex === 0) delete process.env.GIT_CONFIG_COUNT;
		else process.env.GIT_CONFIG_COUNT = String(configIndex);
		await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
	});

	it('provisions the mount as its own binding and links it into the primary worktree', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await provisioner.provision('task-m1', spec('task/mounts-1'));

		expect(descriptor).toMatchObject({
			repositoryId: 'ever/platform',
			baseSha: primarySeedSha,
			branch: 'task/mounts-1'
		});
		expect(descriptor.mounts).toHaveLength(1);
		const mount = descriptor.mounts![0]!;
		expect(mount).toMatchObject({
			repositoryId: 'ever/template',
			mountDir: 'template',
			writable: true,
			baseRef: 'main',
			branch: 'task/mounts-1',
			baseSha: mountSeedSha,
			headSha: mountSeedSha,
			reused: false
		});
		// The mount's real worktree lives under the fleet root, not inside the primary.
		expect(relative(workspaceRoot, mount.path)).not.toMatch(/^\.\.(?:[\\/]|$)/);
		expect(relative(descriptor.path, mount.path)).toMatch(/^\.\./);
		// ...and the link inside the primary resolves to it.
		expect(mount.linkPath).toBe(join(descriptor.path, FLEET_TASK_WORKSPACE_MOUNTS_DIR, 'template'));
		expect((await fs.lstat(mount.linkPath)).isSymbolicLink()).toBe(true);
		expect(await fs.realpath(mount.linkPath)).toBe(mount.path);
		// `trim()`: Git's autocrlf may check the seed out with CRLF on Windows.
		expect((await fs.readFile(join(mount.linkPath, 'TEMPLATE.md'), 'utf8')).trim()).toBe('TEMPLATE.md');
		expect(git(mount.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/mounts-1');
		// Two repositories, two pools.
		expect((await fs.readdir(join(workspaceRoot, 'repositories'))).length).toBe(2);
	});

	it('keeps the mounts directory out of the primary repository entirely', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await provisioner.provision('task-m2', spec('task/mounts-2'));
		const mount = descriptor.mounts![0]!;

		writeFileSync(join(mount.linkPath, 'edited-through-the-link.txt'), 'hello\n');

		// The primary sees nothing: no untracked `.mounts`, nothing to add.
		expect(git(descriptor.path, 'status', '--porcelain')).toBe('');
		git(descriptor.path, 'add', '-A');
		expect(git(descriptor.path, 'diff', '--cached', '--name-only')).toBe('');
		// The rule lives in the repository's shared exclude file, never in a tracked .gitignore.
		const commonDir = git(descriptor.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
		expect(await fs.readFile(join(commonDir, 'info', 'exclude'), 'utf8')).toContain(
			`/${FLEET_TASK_WORKSPACE_MOUNTS_DIR}/`
		);
		// While the mount itself does see the edit.
		expect(git(mount.path, 'status', '--porcelain')).toContain('edited-through-the-link.txt');
	});

	it('commits and pushes a writable mount to its own origin and reports the verdict', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await provisioner.provision('task-m3', spec('task/mounts-3'));
		const mount = descriptor.mounts![0]!;
		writeFileSync(join(mount.linkPath, 'CHANGE.md'), 'changed in the mount\n');

		const results = await provisioner.finalizeMounts('task-m3', descriptor, {
			commitMessage: 'Task mounts-3: template change',
			push: true
		});

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			repositoryId: 'ever/template',
			mountDir: 'template',
			branch: 'task/mounts-3',
			baseSha: mountSeedSha,
			pushed: true,
			empty: false
		});
		expect(results[0]!.headSha).toMatch(/^[0-9a-f]{40}$/);
		expect(results[0]!.error).toBeUndefined();
		// The branch exists on the MOUNT's origin with the commit...
		expect(git(mountOrigin, 'rev-parse', 'refs/heads/task/mounts-3')).toBe(results[0]!.headSha);
		// ...and the primary's origin never heard of it.
		expect(() => git(primaryOrigin, 'rev-parse', '--verify', 'refs/heads/task/mounts-3')).toThrow();
	});

	it('reports an untouched writable mount as empty and never touches a read-only mount', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const untouched = await provisioner.provision('task-m4', spec('task/mounts-4'));
		const emptyResults = await provisioner.finalizeMounts('task-m4', untouched, {
			commitMessage: 'noop',
			push: true
		});
		expect(emptyResults).toHaveLength(1);
		expect(emptyResults[0]).toMatchObject({ empty: true, pushed: false });

		const readOnly = await provisioner.provision('task-m5', spec('task/mounts-5', false));
		writeFileSync(join(readOnly.mounts![0]!.linkPath, 'ignored.txt'), 'never committed\n');
		expect(await provisioner.finalizeMounts('task-m5', readOnly, { commitMessage: 'noop', push: true })).toEqual(
			[]
		);
		expect(() => git(mountOrigin, 'rev-parse', '--verify', 'refs/heads/task/mounts-5')).toThrow();
	});

	it('is idempotent: a re-provision reuses the mount binding and keeps the link', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const first = await provisioner.provision('task-m6', spec('task/mounts-6'));
		writeFileSync(join(first.mounts![0]!.linkPath, 'scratch.txt'), 'survives retry\n');

		const retry = await provisioner.provision('task-m6', spec('task/mounts-6'));
		expect(retry.path).toBe(first.path);
		expect(retry.mounts![0]!.path).toBe(first.mounts![0]!.path);
		expect(retry.mounts![0]!.reused).toBe(true);
		expect(await fs.readFile(join(retry.mounts![0]!.linkPath, 'scratch.txt'), 'utf8')).toBe('survives retry\n');
	});

	it('refuses a mount that is the primary repository, before touching Git', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const bad = spec('task/mounts-7');
		await expect(
			provisioner.provision('task-m7', {
				...bad,
				mounts: [{ ...bad.mounts[0]!, repositoryId: 'ever/platform', repoUrl: primaryUrl }]
			})
		).rejects.toMatchObject({ code: 'invalid-spec' });
	});

	it('refuses a mount link path already occupied by a real directory', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const primaryOnly = await provisioner.provision('task-m8', { ...spec('task/mounts-8'), mounts: [] });
		mkdirSync(join(primaryOnly.path, FLEET_TASK_WORKSPACE_MOUNTS_DIR, 'template'), { recursive: true });

		await expect(provisioner.provision('task-m8', spec('task/mounts-8'))).rejects.toMatchObject({
			code: 'path-collision'
		});
	});
});
