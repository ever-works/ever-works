import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	FleetTaskWorkspaceProvisioner,
	readWorkspaceLease,
	readWorkspaceUsage,
	type FleetWorkspacePlugin
} from './fleet-task-workspace';

/**
 * Provisioner housekeeping (self-build program note §6): the disk floor
 * re-check right before anything is written, and the lease / usage files
 * that let the workspace reaper tell a busy checkout from an abandoned one.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const testTemporaryDirectory = process.env.RUNNER_TEMP ?? tmpdir();
const canonicalTemporaryDirectory = realpathSync.native(testTemporaryDirectory);
const temporaryRoot = (prefix: string): string =>
	realpathSync.native(mkdtempSync(join(canonicalTemporaryDirectory, prefix)));

const valid = {
	repositoryId: 'ever/repository',
	repoUrl: 'https://github.com/ever/repository.git',
	baseRef: 'develop',
	branch: 'task/example-12345678'
};

describe('FleetTaskWorkspaceProvisioner — disk floor re-check', () => {
	const rootPath = temporaryRoot('ew-fleet-disk-floor-');

	afterAll(async () => {
		await fs.rm(rootPath, { recursive: true, force: true, maxRetries: 3 });
	});

	it('refuses with disk-low before any Git call when the volume is below the default floor', async () => {
		const plugin = { provision: vi.fn() } as unknown as FleetWorkspacePlugin;
		const probed: string[] = [];
		const provisioner = new FleetTaskWorkspaceProvisioner({
			rootPath: join(rootPath, 'not-created-yet'),
			plugin,
			diskProbe: {
				freeBytes: (path) => {
					probed.push(path);
					return 100 * MIB;
				}
			}
		});

		const failure = await provisioner.provision('task-0001', valid).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: 'disk-low' });
		expect(String((failure as Error).message)).toContain('100 MB');
		expect(String((failure as Error).message)).toContain('2.0 GiB');
		expect(plugin.provision).not.toHaveBeenCalled();
		// The root does not exist yet: the reading was taken on its nearest
		// existing ancestor, never skipped as "unknown".
		expect(probed).toEqual([rootPath]);
	});

	it('honours a configured floor and an explicit opt-out', async () => {
		const strict = new FleetTaskWorkspaceProvisioner({
			rootPath,
			plugin: { provision: vi.fn() } as unknown as FleetWorkspacePlugin,
			diskProbe: { freeBytes: () => 3 * GIB },
			minFreeDiskBytes: 4 * GIB
		});
		await expect(strict.provision('task-0001', valid)).rejects.toMatchObject({ code: 'disk-low' });

		const off = { provision: vi.fn(async () => null) } as unknown as FleetWorkspacePlugin;
		const unguarded = new FleetTaskWorkspaceProvisioner({
			rootPath,
			plugin: off,
			diskProbe: { freeBytes: () => 10 * MIB },
			minFreeDiskBytes: null
		});
		// The provider IS reached (and then refuses its bogus null handle).
		await expect(unguarded.provision('task-0001', valid)).rejects.toMatchObject({ code: 'provision-failed' });
		expect(off.provision).toHaveBeenCalledOnce();
	});

	it('admits when the reading is unknown — an unreadable volume must not fail every job', async () => {
		const plugin = { provision: vi.fn(async () => null) } as unknown as FleetWorkspacePlugin;
		const provisioner = new FleetTaskWorkspaceProvisioner({
			rootPath,
			plugin,
			diskProbe: { freeBytes: () => null }
		});
		await expect(provisioner.provision('task-0001', valid)).rejects.toMatchObject({ code: 'provision-failed' });
		expect(plugin.provision).toHaveBeenCalledOnce();
	});

	it('keeps a pre-cancelled request from reading the disk or reaching Git', async () => {
		const plugin = { provision: vi.fn() } as unknown as FleetWorkspacePlugin;
		const freeBytes = vi.fn(() => 10 * MIB);
		const controller = new AbortController();
		controller.abort();
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, plugin, diskProbe: { freeBytes } });
		await expect(provisioner.provision('task-0001', valid, controller.signal)).rejects.toMatchObject({
			code: 'cancelled'
		});
		expect(freeBytes).not.toHaveBeenCalled();
		expect(plugin.provision).not.toHaveBeenCalled();
	});
});

describe.sequential('FleetTaskWorkspaceProvisioner — lease and usage files (real Git)', { timeout: 30_000 }, () => {
	let ownedRoot: string;
	let originDir: string;
	let workspaceRoot: string;
	let gitConfigIndex: number;
	const remoteUrl = 'https://fleet-housekeeping.invalid/ever/repository.git';

	const workspace = (branch: string) => ({
		repositoryId: 'ever/repository',
		repoUrl: remoteUrl,
		baseRef: 'main',
		branch
	});

	const gitDirOf = (worktree: string): string => git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir');

	beforeAll(() => {
		ownedRoot = temporaryRoot('ew-fleet-housekeeping-');
		const seedDir = join(ownedRoot, 'seed');
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

	it('leases a fresh worktree for this process, stamps its usage, and release hands it back', async () => {
		const t0 = Date.parse('2026-09-01T10:00:00.000Z');
		let now = t0;
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot, now: () => now });
		const descriptor = await provisioner.provision('task-lease-1', workspace('task/lease-1'));
		const gitDir = gitDirOf(descriptor.path);

		const lease = await readWorkspaceLease(gitDir);
		expect(lease).toMatchObject({ version: 1, purpose: 'job', pid: process.pid, taskId: 'task-lease-1' });
		expect(await readWorkspaceUsage(gitDir)).toMatchObject({
			version: 1,
			lastUsedAt: new Date(t0).toISOString(),
			taskId: 'task-lease-1'
		});
		expect([...provisioner.activeBindingKeys()]).toHaveLength(1);
		// Neither file is anywhere Git could stage it.
		expect(git(descriptor.path, 'status', '--porcelain', '--untracked-files=all')).toBe('');

		now = t0 + 60_000;
		await provisioner.release('task-lease-1', descriptor);
		expect(await readWorkspaceLease(gitDir)).toBeNull();
		expect(await readWorkspaceUsage(gitDir)).toMatchObject({ lastUsedAt: new Date(now).toISOString() });
		expect(provisioner.activeBindingKeys().size).toBe(0);
	});

	it('re-leases a reused worktree and refreshes its usage on every provision', async () => {
		const t0 = Date.parse('2026-09-02T10:00:00.000Z');
		let now = t0;
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot, now: () => now });
		const first = await provisioner.provision('task-lease-2', workspace('task/lease-2'));
		await provisioner.release('task-lease-2', first);

		now = t0 + 3_600_000;
		const again = await provisioner.provision('task-lease-2', workspace('task/lease-2'));
		expect(again.reused).toBe(true);
		const gitDir = gitDirOf(again.path);
		expect(await readWorkspaceLease(gitDir)).toMatchObject({ pid: process.pid, purpose: 'job' });
		expect(await readWorkspaceUsage(gitDir)).toMatchObject({ lastUsedAt: new Date(now).toISOString() });
		await provisioner.release('task-lease-2', again);
	});

	it('preserves a worktree leased by a LIVE foreign process, and reclaims one whose holder is dead', async () => {
		const owner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await owner.provision('task-lease-3', workspace('task/lease-3'));
		await owner.release('task-lease-3', descriptor);
		const gitDir = gitDirOf(descriptor.path);
		writeFileSync(join(descriptor.path, 'keep.txt'), 'must survive\n');
		await fs.writeFile(
			join(gitDir, 'ew-workspace-lease.json'),
			JSON.stringify({ version: 1, purpose: 'job', pid: 424_242, since: '2026-09-01T00:00:00.000Z' })
		);

		const contended = new FleetTaskWorkspaceProvisioner({
			rootPath: workspaceRoot,
			isProcessAlive: () => true
		});
		const failure = await contended
			.provision('task-lease-3', workspace('task/lease-3'))
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: 'path-collision' });
		expect(String((failure as Error).message)).toContain('424242');
		expect(await fs.readFile(join(descriptor.path, 'keep.txt'), 'utf8')).toBe('must survive\n');
		// The foreign lease is still there, untouched.
		expect(await readWorkspaceLease(gitDir)).toMatchObject({ pid: 424_242 });

		const reclaiming = new FleetTaskWorkspaceProvisioner({
			rootPath: workspaceRoot,
			isProcessAlive: () => false
		});
		const reclaimed = await reclaiming.provision('task-lease-3', workspace('task/lease-3'));
		expect(reclaimed.path).toBe(descriptor.path);
		expect(await readWorkspaceLease(gitDir)).toMatchObject({ pid: process.pid });
		await reclaiming.release('task-lease-3', reclaimed);
	});

	it('preserves a worktree the reaper is reclaiming in THIS process (gc lease, same pid)', async () => {
		const owner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await owner.provision('task-lease-4', workspace('task/lease-4'));
		await owner.release('task-lease-4', descriptor);
		await fs.writeFile(
			join(gitDirOf(descriptor.path), 'ew-workspace-lease.json'),
			JSON.stringify({ version: 1, purpose: 'gc', pid: process.pid, since: '2026-09-01T00:00:00.000Z' })
		);

		const failure = await owner
			.provision('task-lease-4', workspace('task/lease-4'))
			.catch((error: unknown) => error);
		// Transient, not a collision: the executor hands the job back and a
		// retry lands on a fresh checkout once the reaper is done.
		expect(failure).toMatchObject({ code: 'workspace-busy' });
		expect(String((failure as Error).message)).toContain('reaper');
		expect(String((failure as Error).message)).toContain(String(process.pid));
	});

	it('drops the lease again when the provision fails after taking it', async () => {
		const owner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot });
		const descriptor = await owner.provision('task-lease-5', workspace('task/lease-5'));
		await owner.release('task-lease-5', descriptor);
		const gitDir = gitDirOf(descriptor.path);

		// HEAD inspection fails AFTER the provider returned (and the lease
		// was taken on the reused worktree before the provider ran).
		const failing = new FleetTaskWorkspaceProvisioner({
			rootPath: workspaceRoot,
			inspectHead: async () => {
				throw new Error('git rev-parse exploded');
			}
		});
		await expect(failing.provision('task-lease-5', workspace('task/lease-5'))).rejects.toMatchObject({
			code: 'git-failed'
		});
		expect(await readWorkspaceLease(gitDir)).toBeNull();
		expect(failing.activeBindingKeys().size).toBe(0);
	});
});
