import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkspaceProvisionSpec } from '@ever-works/plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	FLEET_TASK_WORKSPACE_MOUNTS_DIR,
	FleetTaskWorkspaceProvisioner,
	type FleetWorkspacePlugin
} from './fleet-task-workspace';

/** Remove a link the way the provisioner does: never its target. */
const removeLink = async (linkPath: string): Promise<void> => {
	try {
		await fs.unlink(linkPath);
	} catch {
		await fs.rmdir(linkPath);
	}
};

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
			code: 'path-collision',
			message: expect.stringContaining('remove it to provision this Task again')
		});
	});

	it('never writes through a `.mounts` that is a link or a file, and leaves the link target alone', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const primaryOnly = await provisioner.provision('task-m9', { ...spec('task/mounts-9'), mounts: [] });
		const mountsDir = join(primaryOnly.path, FLEET_TASK_WORKSPACE_MOUNTS_DIR);
		// What a model (or anything else sharing the service account) could
		// leave behind between two runs: `.mounts` pointing at a sibling
		// directory. A junction on Windows needs no privilege at all.
		const sibling = join(ownedRoot, 'sibling-of-m9');
		mkdirSync(sibling, { recursive: true });
		await fs.symlink(sibling, mountsDir, process.platform === 'win32' ? 'junction' : 'dir');

		await expect(provisioner.provision('task-m9', spec('task/mounts-9'))).rejects.toMatchObject({
			code: 'path-collision',
			message: expect.stringContaining('is a link or file and was preserved')
		});
		// Nothing was created or unlinked inside the sibling, the link itself is intact...
		expect(await fs.readdir(sibling)).toEqual([]);
		expect((await fs.lstat(mountsDir)).isSymbolicLink()).toBe(true);
		// ...and a workspace WITHOUT mounts is not blocked by it (nothing is written through it).
		await expect(provisioner.provision('task-m9', { ...spec('task/mounts-9'), mounts: [] })).resolves.toMatchObject(
			{
				path: primaryOnly.path
			}
		);

		await removeLink(mountsDir);
		writeFileSync(mountsDir, 'not a directory\n');
		await expect(provisioner.provision('task-m9', spec('task/mounts-9'))).rejects.toMatchObject({
			code: 'path-collision'
		});
		expect((await fs.readFile(mountsDir, 'utf8')).trim()).toBe('not a directory');
	});

	it('drops the links of mounts the current spec no longer names, keeping their worktrees', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const first = await provisioner.provision('task-m10', spec('task/mounts-10'));
		const mountsDir = join(first.path, FLEET_TASK_WORKSPACE_MOUNTS_DIR);
		const worktree = first.mounts![0]!.path;

		// The same repository under a new directory name: one link, not two.
		const renamed = await provisioner.provision('task-m10', {
			...spec('task/mounts-10'),
			mounts: [{ ...spec('task/mounts-10').mounts[0]!, mountDir: 'tpl' }]
		});
		expect(renamed.mounts![0]!.path).toBe(worktree);
		expect(await fs.readdir(mountsDir)).toEqual(['tpl']);

		// The repository removed from the Task: the link goes, the worktree
		// (the plugin's binding, reused when the repository comes back) stays.
		const none = await provisioner.provision('task-m10', { ...spec('task/mounts-10'), mounts: [] });
		expect(none.mounts).toBeUndefined();
		expect(await fs.readdir(mountsDir)).toEqual([]);
		expect((await fs.stat(worktree)).isDirectory()).toBe(true);

		// A real directory left under `.mounts/` is never removed — only links are.
		mkdirSync(join(mountsDir, 'kept-by-hand'));
		await provisioner.provision('task-m10', { ...spec('task/mounts-10'), mounts: [] });
		expect(await fs.readdir(mountsDir)).toEqual(['kept-by-hand']);
	});

	it('resets a reused read-only mount to its base commit (a writable one keeps its edits)', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const readOnly = await provisioner.provision('task-m11', spec('task/mounts-11', false));
		const link = readOnly.mounts![0]!.linkPath;
		writeFileSync(join(link, 'junk.txt'), 'left by the model\n');
		writeFileSync(join(link, 'TEMPLATE.md'), 'edited by the model\n');
		expect(git(readOnly.mounts![0]!.path, 'status', '--porcelain')).not.toBe('');

		const again = await provisioner.provision('task-m11', spec('task/mounts-11', false));
		expect(again.mounts![0]!.reused).toBe(true);
		expect(git(again.mounts![0]!.path, 'status', '--porcelain')).toBe('');
		expect(existsSync(join(link, 'junk.txt'))).toBe(false);
		expect((await fs.readFile(join(link, 'TEMPLATE.md'), 'utf8')).trim()).toBe('TEMPLATE.md');
		// The writable counterpart is the idempotency case above: `scratch.txt` survives.
	});

	it('writes the exclude rule atomically: concurrent provisions of one pool leave exactly one rule', async () => {
		// A fresh root, so the rule does not exist yet when both provisions race.
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: join(ownedRoot, 'fleet-root-concurrent') });
		const [first, second] = await Promise.all([
			provisioner.provision('task-m12a', spec('task/mounts-12a')),
			provisioner.provision('task-m12b', spec('task/mounts-12b'))
		]);
		const commonDir = git(first.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
		expect(git(second.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(commonDir);
		const rule = `/${FLEET_TASK_WORKSPACE_MOUNTS_DIR}/`;
		const exclude = await fs.readFile(join(commonDir, 'info', 'exclude'), 'utf8');
		expect(exclude.split(/\r?\n/).filter((line) => line.trim() === rule)).toHaveLength(1);
		// No temporary file is left next to it.
		expect((await fs.readdir(join(commonDir, 'info'))).filter((name) => name.startsWith('exclude.'))).toEqual([]);
		expect(git(first.path, 'status', '--porcelain')).toBe('');
	});
});

/**
 * Cancellation mid-mount. The Git work is faked so the abort can be raised
 * from inside a specific mount step; what must hold is that a cancellation
 * is NOT re-labelled as that mount's failure (`mount '<dir>' (...)`) — the
 * executor and the platform key on the `cancelled` code — and that
 * `finalizeMounts` stops at it instead of recording an `error` entry and
 * moving on to the next repository.
 */
describe('FleetTaskWorkspaceProvisioner — mounts and cancellation (faked Git)', () => {
	const SHA = 'a'.repeat(40);
	const primaryUrl = 'https://fleet-cancel.invalid/ever/platform.git';
	const mountSpecs = [
		{
			repositoryId: 'ever/template',
			repoUrl: 'https://fleet-cancel.invalid/ever/template.git',
			baseRef: 'main',
			branch: 'task/cancel',
			mountDir: 'template',
			writable: true
		},
		{
			repositoryId: 'ever/docs',
			repoUrl: 'https://fleet-cancel.invalid/ever/docs.git',
			baseRef: 'main',
			branch: 'task/cancel',
			mountDir: 'docs',
			writable: true
		}
	];
	const workspaceSpec = {
		repositoryId: 'ever/platform',
		repoUrl: primaryUrl,
		baseRef: 'main',
		branch: 'task/cancel',
		mounts: mountSpecs
	};

	const abortError = (): Error => {
		const error = new Error('git was interrupted');
		error.name = 'AbortError';
		return error;
	};

	const fakePlugin = (hooks: {
		onProvision?: (received: WorkspaceProvisionSpec, path: string) => void;
		onFinalize?: (path: string) => void;
	}): FleetWorkspacePlugin => ({
		provision: async (received) => {
			const path = join(String(received.settings?.baseDir), 'worktrees', received.bindingKey);
			await fs.mkdir(path, { recursive: true });
			hooks.onProvision?.(received, path);
			return { path, baseSha: SHA, reused: false, branch: received.branch, bindingKey: received.bindingKey };
		},
		finalize: async (handle) => {
			hooks.onFinalize?.(handle.path);
			return { pushed: true, headSha: SHA, empty: false, changedFiles: 1 };
		}
	});

	it('propagates a cancellation raised while a mount is provisioned, unprefixed, with nothing linked', async () => {
		const root = temporaryRoot('ew-fleet-mounts-cancel-');
		try {
			const controller = new AbortController();
			let primaryPath = '';
			const provisioned: string[] = [];
			const plugin = fakePlugin({
				onProvision: (received, path) => {
					provisioned.push(received.repositoryId ?? '');
					if (received.repositoryId === 'ever/platform') {
						primaryPath = path;
						return;
					}
					// The lease is lost while the FIRST mount is being fetched.
					controller.abort();
					throw abortError();
				}
			});
			const provisioner = new FleetTaskWorkspaceProvisioner({
				rootPath: root,
				plugin,
				inspectHead: async () => SHA
			});

			await expect(provisioner.provision('task-cancel', workspaceSpec, controller.signal)).rejects.toMatchObject({
				code: 'cancelled',
				message: expect.not.stringMatching(/^mount '/)
			});
			expect(provisioned).toEqual(['ever/platform', 'ever/template']);
			// `.mounts` was prepared but no link was written into it (and the
			// exclude step, which would have needed real Git, was never reached).
			expect(await fs.readdir(join(primaryPath, FLEET_TASK_WORKSPACE_MOUNTS_DIR))).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it('stops finalizing mounts at a cancellation instead of recording it as a mount failure', async () => {
		const root = temporaryRoot('ew-fleet-mounts-cancel-finalize-');
		try {
			const controller = new AbortController();
			const finalized: string[] = [];
			const plugin = fakePlugin({
				onFinalize: (path) => {
					finalized.push(path);
					controller.abort();
					throw abortError();
				}
			});
			const provisioner = new FleetTaskWorkspaceProvisioner({
				rootPath: root,
				plugin,
				inspectHead: async () => SHA
			});
			const worktree = (name: string) => join(root, 'repositories', 'pool', 'worktrees', name);
			for (const name of ['primary', 'template', 'docs']) {
				await fs.mkdir(worktree(name), { recursive: true });
			}
			const descriptor = {
				path: worktree('primary'),
				repositoryId: 'ever/platform',
				baseRef: 'main',
				branch: 'task/cancel',
				baseSha: SHA,
				headSha: SHA,
				reused: false,
				mounts: mountSpecs.map((mount) => ({
					path: worktree(mount.mountDir),
					linkPath: join(worktree('primary'), FLEET_TASK_WORKSPACE_MOUNTS_DIR, mount.mountDir),
					repositoryId: mount.repositoryId,
					baseRef: mount.baseRef,
					branch: mount.branch,
					baseSha: SHA,
					headSha: SHA,
					reused: false,
					mountDir: mount.mountDir,
					writable: true
				}))
			};

			await expect(
				provisioner.finalizeMounts(
					'task-cancel',
					descriptor,
					{ commitMessage: 'Task cancel: mounts', push: true },
					controller.signal
				)
			).rejects.toMatchObject({ code: 'cancelled' });
			// The first mount was attempted; the second never was.
			expect(finalized).toEqual([await fs.realpath(worktree('template'))]);
		} finally {
			await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
		}
	});
});
