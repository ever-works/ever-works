import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	FLEET_TASK_WORKSPACE_EXCLUDE_RULES,
	FleetTaskWorkspaceError,
	FleetTaskWorkspaceProvisioner,
	type FleetWorkspacePlugin
} from './fleet-task-workspace';

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const SHA = 'a'.repeat(40);

// Hosted Windows runners may expose the generic TEMP path through a reparse
// alias. Prefer their job-scoped physical temp root; dedicated tests below
// still create and reject aliases explicitly.
const testTemporaryDirectory = process.env.RUNNER_TEMP ?? tmpdir();
const canonicalTemporaryDirectory = realpathSync.native(testTemporaryDirectory);
const temporaryRoot = (prefix: string): string =>
	realpathSync.native(mkdtempSync(join(canonicalTemporaryDirectory, prefix)));

const fleetBindingKey = (taskId: string, repositoryId = 'ever/repository'): string =>
	`fleet-${createHash('sha256').update(repositoryId).update('\0').update(taskId).digest('hex').slice(0, 32)}`;

describe.sequential('FleetTaskWorkspaceProvisioner — real Git worktrees', { timeout: 20_000 }, () => {
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
		ownedRoot = temporaryRoot('ew-fleet-task-workspace-');
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

	it('keeps the owner-question directory out of the single-repository worktree (self-build slice Q)', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await provisioner.provision('task-0006', workspace('task/fleet-0006'));
		mkdirSync(join(descriptor.path, '.ever-works'), { recursive: true });
		writeFileSync(join(descriptor.path, '.ever-works', 'QUESTION.md'), '# Which database?\n');

		// Git never sees the file: not untracked, not stageable by `add -A`.
		expect(git(descriptor.path, 'status', '--porcelain')).toBe('');
		git(descriptor.path, 'add', '-A');
		expect(git(descriptor.path, 'diff', '--cached', '--name-only')).toBe('');

		// A file written from a package directory — a model that `cd`-ed into
		// one and wrote the path relative to its cwd — is just as invisible:
		// the unanchored rule (review SR-5) matches at any depth.
		mkdirSync(join(descriptor.path, 'packages', 'api', '.ever-works'), { recursive: true });
		writeFileSync(join(descriptor.path, 'packages', 'api', '.ever-works', 'QUESTION.md'), '# Nested?\n');
		expect(git(descriptor.path, 'status', '--porcelain')).toBe('');
		git(descriptor.path, 'add', '-A');
		expect(git(descriptor.path, 'diff', '--cached', '--name-only')).toBe('');

		// Every fleet rule lives in the repository's shared exclude file...
		const commonDir = git(descriptor.path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
		const excludeLines = (await fs.readFile(join(commonDir, 'info', 'exclude'), 'utf8'))
			.split(/\r?\n/)
			.map((line) => line.trim());
		expect(excludeLines).toContain('/.mounts');
		expect(excludeLines).toContain('/.ever-works');
		expect(excludeLines).toContain('.ever-works');
		for (const rule of FLEET_TASK_WORKSPACE_EXCLUDE_RULES) {
			expect(excludeLines.filter((line) => line === rule)).toHaveLength(1);
		}

		// ...and a second provision of the same task adds nothing twice.
		await provisioner.provision('task-0006', workspace('task/fleet-0006'));
		const again = (await fs.readFile(join(commonDir, 'info', 'exclude'), 'utf8'))
			.split(/\r?\n/)
			.map((line) => line.trim());
		for (const rule of FLEET_TASK_WORKSPACE_EXCLUDE_RULES) {
			expect(again.filter((line) => line === rule)).toHaveLength(1);
		}
	});

	/**
	 * CI 2026-09-04, `lint-and-test` on #2297: provisioning a workspace with
	 * NO mounts failed on Linux because `.mounts` existed as a symlink left by
	 * an earlier run. Git treats a symlink as a FILE, so the then
	 * slash-terminated `/​.mounts/` rule did not ignore it, `git check-ignore`
	 * reported the rule ineffective and the provision threw. It passed on
	 * Windows only because a junction reports as a directory there.
	 *
	 * A plain file reproduces the same condition on every platform, which is
	 * what this pins — no symlink privilege required.
	 */
	it('ignores the fleet paths when they exist as a file, not a directory', async () => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await provisioner.provision('task-0007', workspace('task/fleet-0007'));

		for (const name of ['.mounts', '.ever-works']) {
			writeFileSync(join(descriptor.path, name), 'not a directory\n');
		}

		// The rules must cover the file form, or the finalize's `git add -A`
		// would commit whatever was left behind.
		expect(git(descriptor.path, 'status', '--porcelain')).toBe('');
		// And a re-provision, which re-verifies the rules, must still succeed.
		await expect(provisioner.provision('task-0007', workspace('task/fleet-0007'))).resolves.toMatchObject({
			path: descriptor.path
		});
	});

	it('never writes a slash-terminated exclude rule', () => {
		// The probes keep their slashes; the rules must not have them, or the
		// file/symlink form above stops being covered.
		for (const rule of FLEET_TASK_WORKSPACE_EXCLUDE_RULES) {
			expect(rule.endsWith('/')).toBe(false);
		}
	});

	it.runIf(process.platform === 'win32')(
		'refuses a task-path junction alias without deleting the registered target worktree',
		async () => {
			const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
			const victimTaskId = 'task-junction-victim';
			const aliasTaskId = 'task-junction-alias';
			const victimBranch = 'task/junction-victim';
			const victim = await provisioner.provision(victimTaskId, workspace(victimBranch));
			const marker = join(victim.path, 'must-survive.txt');
			writeFileSync(marker, 'another task owns this worktree\n');

			const aliasBinding = fleetBindingKey(aliasTaskId);
			const aliasPath = join(victim.path, '..', aliasBinding);
			const victimGitDir = git(victim.path, 'rev-parse', '--path-format=absolute', '--git-dir');
			// Reproduce the reviewed exploit: the old two-field stamp was both
			// predictable and accepted any stamped branch before following the
			// junction to another task's registered worktree.
			writeFileSync(
				join(victimGitDir, 'ew-workspace.json'),
				JSON.stringify({ bindingKey: aliasBinding, branch: victimBranch })
			);
			await fs.symlink(victim.path, aliasPath, 'junction');

			await expect(provisioner.provision(aliasTaskId, workspace('task/junction-alias'))).rejects.toMatchObject({
				code: 'path-collision'
			});
			expect(await fs.readFile(marker, 'utf8')).toBe('another task owns this worktree\n');
			expect(git(victim.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(victimBranch);
		}
	);
});

describe('FleetTaskWorkspaceProvisioner — refusal and diagnostics', () => {
	const rootPath = temporaryRoot('ew-fleet-workspace-validation-');
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
		['drive-relative repository path', { ...valid, repoUrl: 'C:repo.git' }],
		['drive-relative repository path with directories', { ...valid, repoUrl: 'D:repos/repo.git' }],
		['UNC repository path', { ...valid, repoUrl: '\\\\server\\share\\repo.git' }],
		['Windows device repository path', { ...valid, repoUrl: '\\\\?\\C:\\repos\\repo.git' }],
		['Windows local-device repository path', { ...valid, repoUrl: '\\\\.\\pipe\\repo.git' }],
		['forward-slash UNC repository path', { ...valid, repoUrl: '//server/share/repo.git' }],
		['file URL', { ...valid, repoUrl: 'file:///tmp/repo.git' }],
		['HTTPS credentials', { ...valid, repoUrl: 'https://user:secret@github.com/ever/repository.git' }],
		['SSH password userinfo', { ...valid, repoUrl: 'ssh://git:secret@github.com/ever/repository.git' }],
		['SCP password-like userinfo', { ...valid, repoUrl: 'git:secret@github.com:ever/repository.git' }],
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

	it('rejects an in-root junction created by a provider during provisioning', async () => {
		const ownedRoot = temporaryRoot('ew-fleet-provider-alias-');
		let targetPath = '';
		try {
			const plugin: FleetWorkspacePlugin = {
				provision: async (received) => {
					const repositoryRoot = String(received.settings?.baseDir);
					const expectedPath = join(repositoryRoot, 'worktrees', received.bindingKey);
					targetPath = join(repositoryRoot, 'worktrees', 'other-task-target');
					await fs.mkdir(targetPath, { recursive: true });
					await fs.writeFile(join(targetPath, 'must-survive.txt'), 'other task data\n');
					await fs.symlink(targetPath, expectedPath, process.platform === 'win32' ? 'junction' : 'dir');
					return {
						path: expectedPath,
						baseSha: SHA,
						reused: false,
						branch: received.branch,
						bindingKey: received.bindingKey
					};
				}
			};
			const provisioner = new FleetTaskWorkspaceProvisioner({
				rootPath: ownedRoot,
				plugin,
				inspectHead: async () => SHA
			});

			await expect(provisioner.provision('task-0001', valid)).rejects.toMatchObject({ code: 'path-collision' });
			expect(await fs.readFile(join(targetPath, 'must-survive.txt'), 'utf8')).toBe('other task data\n');
		} finally {
			await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it('preserves an unowned directory at the deterministic path instead of letting self-heal delete it', async () => {
		const ownedRoot = temporaryRoot('ew-fleet-collision-');
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
			const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: ownedRoot });

			await expect(provisioner.provision('task-0001', valid)).rejects.toMatchObject({ code: 'path-collision' });
			expect(await fs.readFile(join(collisionPath, 'keep.txt'), 'utf8')).toBe('not owned by Fleet\n');
		} finally {
			await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	it('refuses a repository-cache junction that redirects writes outside the configured root', async () => {
		const guardedRoot = temporaryRoot('ew-fleet-root-guard-');
		const foreignRoot = temporaryRoot('ew-fleet-foreign-');
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

	it.runIf(process.platform === 'win32')(
		'refuses a configured root junction before creating cache children or invoking Git',
		async () => {
			const parent = temporaryRoot('ew-fleet-root-link-parent-');
			const foreignRoot = temporaryRoot('ew-fleet-root-link-target-');
			const linkedRoot = join(parent, 'fleet-root');
			try {
				await fs.symlink(foreignRoot, linkedRoot, 'junction');
				const plugin = { provision: vi.fn() } as unknown as FleetWorkspacePlugin;
				const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: linkedRoot, plugin });

				await expect(provisioner.provision('task-0001', valid)).rejects.toMatchObject({
					code: 'invalid-root'
				});
				expect(plugin.provision).not.toHaveBeenCalled();
				expect(await fs.readdir(foreignRoot)).toEqual([]);
			} finally {
				await fs.rm(parent, { recursive: true, force: true, maxRetries: 3 });
				await fs.rm(foreignRoot, { recursive: true, force: true, maxRetries: 3 });
			}
		}
	);

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

	it('propagates cancellation into a blocking workspace provider instead of waiting for it to finish', async () => {
		const controller = new AbortController();
		let providerEntered = false;
		let receivedSignal: AbortSignal | undefined;
		let observedAbort = false;
		const plugin: FleetWorkspacePlugin = {
			provision: (received) =>
				new Promise((_resolve, reject) => {
					providerEntered = true;
					receivedSignal = received.signal;
					if (!received.signal) {
						setTimeout(() => reject(new Error('provider never received AbortSignal')), 25);
						return;
					}
					received.signal.addEventListener(
						'abort',
						() => {
							observedAbort = true;
							reject(new DOMException('aborted', 'AbortError'));
						},
						{ once: true }
					);
				})
		};
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, plugin });

		const pending = provisioner.provision('task-0001', valid, controller.signal);
		await vi.waitFor(() => expect(providerEntered).toBe(true));
		controller.abort();

		await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
		expect(receivedSignal).toBe(controller.signal);
		expect(observedAbort).toBe(true);
	});
});

describe('FleetTaskWorkspaceProvisioner.finalize — cancellation (agent execution v2 review follow-up)', () => {
	it('forwards the abort signal to the provider and maps an abort into a cancelled error', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-fleet-finalize-'));
		const worktree = join(root, 'repositories', 'r', 'worktrees', 'w');
		mkdirSync(worktree, { recursive: true });
		const controller = new AbortController();
		const finalize = vi.fn(async (_handle: unknown, opts: { signal?: AbortSignal }) => {
			expect(opts.signal).toBe(controller.signal);
			controller.abort(new Error('lease lost'));
			const error = new Error('lease lost');
			error.name = 'AbortError';
			throw error;
		});
		const plugin = { provision: vi.fn(), finalize } as unknown as FleetWorkspacePlugin;
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: root, plugin });
		const descriptor = {
			path: worktree,
			repositoryId: 'ever/repository',
			baseRef: 'main',
			branch: 'task/cancel',
			baseSha: SHA,
			headSha: SHA,
			reused: false
		};
		try {
			await expect(
				provisioner.finalize(
					'task-0001',
					descriptor,
					{ commitMessage: 'agent: x', push: true },
					controller.signal
				)
			).rejects.toMatchObject({ code: 'cancelled' });
			expect(finalize).toHaveBeenCalledTimes(1);
			expect(finalize.mock.calls[0][1]).toMatchObject({ commitMessage: 'agent: x', push: true });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reports a provider without commit support instead of pretending to push', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-fleet-finalize-'));
		try {
			const provisioner = new FleetTaskWorkspaceProvisioner({
				rootPath: root,
				plugin: { provision: vi.fn() } as unknown as FleetWorkspacePlugin
			});
			await expect(
				provisioner.finalize(
					'task-0001',
					{
						path: root,
						repositoryId: 'ever/repository',
						baseRef: 'main',
						branch: 'b',
						baseSha: SHA,
						headSha: SHA,
						reused: false
					},
					{ commitMessage: 'x', push: false }
				)
			).rejects.toMatchObject({ code: 'git-failed' });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
