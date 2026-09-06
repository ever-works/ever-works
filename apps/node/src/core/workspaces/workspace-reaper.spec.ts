import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../heartbeat';
import { FleetTaskWorkspaceProvisioner, readWorkspaceLease } from './fleet-task-workspace';
import {
	scanWorkspaceRoot,
	type WorkspaceInventory,
	type WorkspacePoolRecord,
	type WorkspaceRecord
} from './workspace-inventory';
import {
	DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS,
	DEFAULT_WORKSPACE_REAPER_INTERVAL_MS,
	planWorkspaceReap,
	policyFromConfig,
	runWorkspaceReap,
	startWorkspaceReaperTimer,
	WORKSPACE_REAPER_BUSY_RETRY_MS,
	type WorkspaceReapPlan,
	type WorkspaceReapResult
} from './workspace-reaper';

/**
 * The workspace reaper (self-build program note §6, R8).
 *
 * The property that matters is that the reaper NEVER removes a worktree
 * it cannot prove safe: each safety rule is pinned in isolation on
 * fabricated evidence, and then the whole thing — inventory, plan,
 * teardown through the real provider — is run against real Git worktrees
 * with a real (file-backed) remote.
 */

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const OLD = NOW - 30 * DAY;

function record(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
	return {
		path: '/root/repositories/r/worktrees/fleet-abc',
		repositoryRoot: '/root/repositories/r',
		poolPath: '/root/repositories/r/repos/pool',
		gitDir: '/root/repositories/r/repos/pool/worktrees/fleet-abc',
		bindingKey: 'fleet-abc',
		branch: 'task/abc',
		headSha: 'a'.repeat(40),
		owned: true,
		ownershipNote: null,
		lastUsedAt: OLD,
		hasUsageRecord: true,
		sizeBytes: 1_000,
		dirty: false,
		hasLocks: false,
		unpushedCount: 0,
		remoteBranch: 'absent',
		mergedIntoDefault: 'unknown',
		intentPending: false,
		lease: null,
		mountLinks: [],
		...overrides
	};
}

function pool(overrides: Partial<WorkspacePoolRecord> = {}): WorkspacePoolRecord {
	return {
		path: '/root/repositories/r/repos/pool',
		repositoryRoot: '/root/repositories/r',
		remoteUrl: 'https://example.invalid/ever/repository.git',
		registeredWorktrees: 0,
		pendingIntents: 0,
		lastUsedAt: OLD,
		sizeBytes: 5_000,
		owned: true,
		ownershipNote: null,
		defaultBranch: 'main',
		remoteRefreshed: true,
		unpushedCount: 0,
		...overrides
	};
}

function inventory(worktrees: WorkspaceRecord[], pools: WorkspacePoolRecord[] = []): WorkspaceInventory {
	return {
		rootPath: '/root',
		exists: true,
		scannedAt: NOW,
		remoteRefreshed: true,
		repositories: [{ repositoryRoot: '/root/repositories/r', pools, worktrees, unrecognised: [] }],
		totalBytes:
			worktrees.reduce((sum, tree) => sum + tree.sizeBytes, 0) + pools.reduce((sum, p) => sum + p.sizeBytes, 0),
		unrecognised: []
	};
}

const policy = policyFromConfig({ maxAgeDays: 14, maxCount: null });

describe('planWorkspaceReap — eligibility', () => {
	it('removes an old, clean, owned worktree whose branch is gone from the remote', () => {
		const plan = planWorkspaceReap(inventory([record()]), policy, NOW);
		expect(plan.remove).toHaveLength(1);
		expect(plan.keep).toHaveLength(0);
		expect(plan.remove[0].reason).toContain('branch gone from the remote');
		expect(plan.remove[0].reason).toContain('30 d');
		expect(plan.reclaimableBytes).toBe(1_000);
	});

	it('removes one whose pushed branch was merged into the default branch', () => {
		const plan = planWorkspaceReap(
			inventory([record({ remoteBranch: 'present', mergedIntoDefault: true })]),
			policy,
			NOW
		);
		expect(plan.remove).toHaveLength(1);
		expect(plan.remove[0].reason).toContain('merged into the default branch');
	});

	it('does not count a lease held by a DEAD pid as busy', () => {
		const plan = planWorkspaceReap(
			inventory([
				record({
					lease: { version: 1, purpose: 'job', pid: 999, since: '2026-08-01T00:00:00.000Z', alive: false }
				})
			]),
			policy,
			NOW
		);
		expect(plan.remove).toHaveLength(1);
	});

	it.each<[string, Partial<WorkspaceRecord>, string]>([
		['ownership is unproven', { owned: false, ownershipNote: 'binding stamp missing' }, 'ownership unproven'],
		['a provisioning intent is pending', { intentPending: true }, 'intent pending'],
		[
			'a live job lease exists',
			{ lease: { version: 1, purpose: 'job', pid: 4242, since: '2026-09-05T11:00:00.000Z', alive: true } },
			'leased by pid 4242'
		],
		[
			'the reaper in another process holds it',
			{ lease: { version: 1, purpose: 'gc', pid: 4243, since: '2026-09-05T11:00:00.000Z', alive: true } },
			'reaper'
		],
		['there are uncommitted changes', { dirty: true }, 'uncommitted changes'],
		['the working tree state is unknown', { dirty: 'unknown' }, 'state unknown'],
		['a git lock file is present', { hasLocks: true }, 'lock file'],
		['commits are not on any remote', { unpushedCount: 2 }, '2 commit(s) not on any remote'],
		['the unpushed count is unknown', { unpushedCount: 'unknown' }, 'unpushed commit count unknown'],
		['the remote could not be consulted', { remoteBranch: 'unknown' }, 'remote state unknown'],
		[
			'the branch is still open on the remote',
			{ remoteBranch: 'present', mergedIntoDefault: false },
			'still open on the remote'
		],
		[
			'the branch is on the remote and its merge state is unknown',
			{ remoteBranch: 'present', mergedIntoDefault: 'unknown' },
			'merge state unknown'
		],
		['it was used within the max age', { lastUsedAt: NOW - 2 * DAY }, 'within the max age'],
		['its last use is unknown', { lastUsedAt: null }, 'last use unknown']
	])('keeps a worktree when %s', (_name, overrides, reason) => {
		const plan = planWorkspaceReap(inventory([record(overrides)]), policy, NOW);
		expect(plan.remove).toHaveLength(0);
		expect(plan.keep).toHaveLength(1);
		expect(plan.keep[0].reason).toContain(reason);
	});

	it('keeps a binding this process is using right now, lease file or not', () => {
		const plan = planWorkspaceReap(inventory([record()]), policy, NOW, new Set(['fleet-abc']));
		expect(plan.remove).toHaveLength(0);
		expect(plan.keep[0].reason).toContain('in use by this process');
	});

	it('keeps a worktree with no usage record when asked to (a worker session may predate leases)', () => {
		const unmarked = record({ hasUsageRecord: false });
		expect(planWorkspaceReap(inventory([unmarked]), policy, NOW).remove).toHaveLength(1);
		const cautious = planWorkspaceReap(inventory([unmarked]), { ...policy, requireUsageRecord: true }, NOW);
		expect(cautious.remove).toHaveLength(0);
		expect(cautious.keep[0].reason).toContain('no usage record');
	});
});

describe('planWorkspaceReap — count budget', () => {
	it('trims the least recently used SAFE worktrees beyond the budget, never an unsafe one', () => {
		const young = (days: number, key: string) => record({ bindingKey: key, lastUsedAt: NOW - days * DAY });
		const plan = planWorkspaceReap(
			inventory([
				young(1, 'one'),
				young(3, 'three'),
				young(2, 'two'),
				record({ bindingKey: 'dirty', lastUsedAt: NOW - 10 * DAY, dirty: true })
			]),
			{ ...policy, maxCount: 2 },
			NOW
		);
		expect(plan.remove.map((verdict) => verdict.record.bindingKey)).toEqual(['three', 'two']);
		expect(plan.remove[0].reason).toContain('budget');
		expect(plan.keep.map((verdict) => verdict.record.bindingKey).sort()).toEqual(['dirty', 'one']);
	});

	it('removes nothing for the budget when every worktree fails a safety rule', () => {
		const plan = planWorkspaceReap(
			inventory([record({ dirty: true }), record({ bindingKey: 'b', unpushedCount: 1 })]),
			{ ...policy, maxCount: 1 },
			NOW
		);
		expect(plan.remove).toHaveLength(0);
	});

	it('counts age-based removals against the budget before trimming', () => {
		const plan = planWorkspaceReap(
			inventory([record(), record({ bindingKey: 'young', lastUsedAt: NOW - DAY })]),
			{ ...policy, maxCount: 1 },
			NOW
		);
		// The old one goes by age, which already meets the budget of one.
		expect(plan.remove.map((verdict) => verdict.record.bindingKey)).toEqual(['fleet-abc']);
	});
});

describe('planWorkspaceReap — pools', () => {
	it('removes an old bare pool that no worktree is registered to', () => {
		const plan = planWorkspaceReap(inventory([], [pool()]), policy, NOW);
		expect(plan.removePools).toHaveLength(1);
		expect(plan.reclaimableBytes).toBe(5_000);
	});

	it.each<[string, Partial<WorkspacePoolRecord>, string]>([
		['Git still lists a worktree', { registeredWorktrees: 1 }, 'still registered'],
		['an intent is pending', { pendingIntents: 1 }, 'intent(s) pending'],
		['it was used recently', { lastUsedAt: NOW - DAY }, 'within the max age'],
		['its last use is unknown', { lastUsedAt: null }, 'last use unknown'],
		['ownership is unproven', { owned: false, ownershipNote: 'no HEAD' }, 'no HEAD'],
		// `git worktree remove` leaves the branch in the pool: an emptied pool
		// can still hold the only copy of a commit.
		[
			'a local branch carries commits not on any remote',
			{ unpushedCount: 2 },
			'2 commit(s) on local branches not on any remote'
		],
		['the local branch state is unknown', { unpushedCount: 'unknown' }, 'local branch state unknown'],
		['the remote was not consulted', { remoteRefreshed: false }, 'remote state unknown']
	])('keeps a pool when %s', (_name, overrides, reason) => {
		const plan = planWorkspaceReap(inventory([], [pool(overrides)]), policy, NOW);
		expect(plan.removePools).toHaveLength(0);
		expect(plan.keepPools[0].reason).toContain(reason);
	});

	it('keeps a pool that a scanned worktree points at, even if Git lists none', () => {
		const plan = planWorkspaceReap(inventory([record({ dirty: true })], [pool()]), policy, NOW);
		expect(plan.removePools).toHaveLength(0);
	});
});

describe('runWorkspaceReap — dry run', () => {
	it('performs no write at all and reports the plan as the result', async () => {
		const teardown = vi.fn();
		// A second, unreferenced pool: the one the record points at is kept.
		const plan = planWorkspaceReap(
			inventory([record()], [pool({ path: '/root/repositories/r/repos/orphan' })]),
			{ ...policy, dryRun: true },
			NOW
		);
		const result = await runWorkspaceReap(plan, { plugin: { teardown } });
		expect(result.dryRun).toBe(true);
		expect(teardown).not.toHaveBeenCalled();
		expect(result.removed.map((entry) => entry.record.bindingKey)).toEqual(['fleet-abc']);
		expect(result.removedPools).toHaveLength(1);
		expect(result.freedBytes).toBe(6_000);
	});
});

describe('startWorkspaceReaperTimer', () => {
	function controllableScheduler(): Scheduler & {
		delays: number[];
		cleared: unknown[];
		fire(): void;
		pending: number;
	} {
		const queue: Array<{ id: number; callback: () => void }> = [];
		const delays: number[] = [];
		const cleared: unknown[] = [];
		let nextId = 1;
		return {
			delays,
			cleared,
			get pending() {
				return queue.length;
			},
			setTimeout(callback, ms) {
				delays.push(ms);
				const id = nextId++;
				queue.push({ id, callback });
				return id;
			},
			clearTimeout(handle) {
				cleared.push(handle);
				const index = queue.findIndex((entry) => entry.id === handle);
				if (index >= 0) queue.splice(index, 1);
			},
			fire() {
				queue.shift()?.callback();
			}
		};
	}

	const emptyResult = (): WorkspaceReapResult => ({
		dryRun: false,
		removed: [],
		kept: [],
		removedPools: [],
		keptPools: [],
		freedBytes: 0,
		errors: []
	});

	it('runs after the initial delay, hands the plan to the executor, and re-arms at the cadence', async () => {
		const scheduler = controllableScheduler();
		const scan = vi.fn(async () => inventory([record()]));
		const reap = vi.fn(async (plan: WorkspaceReapPlan) => {
			expect(plan.remove).toHaveLength(1);
			expect(plan.policy.maxAgeMs).toBe(policy.maxAgeMs);
			return emptyResult();
		});
		const timer = startWorkspaceReaperTimer({
			rootPath: '/root',
			policy,
			scheduler,
			scan,
			reap,
			now: () => NOW,
			activeBindings: () => new Set()
		});
		expect(scheduler.delays).toEqual([DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS]);
		expect(scan).not.toHaveBeenCalled();

		scheduler.fire();
		await vi.waitFor(() => expect(reap).toHaveBeenCalledOnce());
		expect(scan).toHaveBeenCalledWith('/root', expect.objectContaining({ refreshRemote: true }));
		await vi.waitFor(() =>
			expect(scheduler.delays).toEqual([
				DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS,
				DEFAULT_WORKSPACE_REAPER_INTERVAL_MS
			])
		);

		timer.stop();
		expect(scheduler.pending).toBe(0);
	});

	it('skips a cycle while the worker is busy and retries sooner', async () => {
		const scheduler = controllableScheduler();
		const scan = vi.fn(async () => inventory([]));
		const timer = startWorkspaceReaperTimer({
			rootPath: '/root',
			policy,
			scheduler,
			scan,
			reap: vi.fn(async () => emptyResult()),
			isBusy: () => true
		});
		scheduler.fire();
		await vi.waitFor(() =>
			expect(scheduler.delays).toEqual([
				DEFAULT_WORKSPACE_REAPER_INITIAL_DELAY_MS,
				WORKSPACE_REAPER_BUSY_RETRY_MS
			])
		);
		expect(scan).not.toHaveBeenCalled();
		timer.stop();
	});

	it('stop() clears the pending timer, and runNow() runs a cycle on demand', async () => {
		const scheduler = controllableScheduler();
		const reap = vi.fn(async () => emptyResult());
		const timer = startWorkspaceReaperTimer({
			rootPath: '/root',
			policy,
			scheduler,
			scan: vi.fn(async () => inventory([])),
			reap
		});
		await timer.runNow();
		expect(reap).toHaveBeenCalledOnce();
		timer.stop();
		expect(scheduler.cleared).toHaveLength(1);
		expect(scheduler.pending).toBe(0);
		expect(await timer.runNow()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Real Git
// ---------------------------------------------------------------------------

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const testTemporaryDirectory = process.env.RUNNER_TEMP ?? tmpdir();
const canonicalTemporaryDirectory = realpathSync.native(testTemporaryDirectory);
const temporaryRoot = (prefix: string): string =>
	realpathSync.native(mkdtempSync(join(canonicalTemporaryDirectory, prefix)));

describe.sequential('workspace reaper — real Git worktrees and a real remote', { timeout: 60_000 }, () => {
	let ownedRoot: string;
	let seedDir: string;
	let originDir: string;
	let originUrl: string;
	let gitConfigIndex: number;
	let counter = 0;
	const remoteUrl = 'https://fleet-reaper.invalid/ever/repository.git';

	const spec = (repositoryId: string, branch: string) => ({
		repositoryId,
		repoUrl: remoteUrl,
		baseRef: 'main',
		branch
	});

	/** A workspace root of its own per case, so each scan sees exactly one repository. */
	const freshRoot = (): string => join(ownedRoot, `root-${(counter += 1)}`);

	const provisionAt = async (rootPath: string, taskId: string, repositoryId: string, branch: string, at: number) => {
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath, now: () => at });
		const descriptor = await provisioner.provision(taskId, spec(repositoryId, branch));
		await provisioner.release(taskId, descriptor);
		return descriptor;
	};

	const commitIn = (worktree: string, name: string): void => {
		writeFileSync(join(worktree, name), `${name}\n`);
		git(worktree, 'add', name);
		git(worktree, '-c', 'user.name=Fleet Test', '-c', 'user.email=fleet@test.invalid', 'commit', '-m', name);
	};

	const scanAndPlan = async (rootPath: string, refreshRemote = true) => {
		const scanned = await scanWorkspaceRoot(rootPath, { refreshRemote, now: () => NOW });
		return { scanned, plan: planWorkspaceReap(scanned, policy, NOW) };
	};

	beforeAll(() => {
		ownedRoot = temporaryRoot('ew-workspace-reaper-');
		seedDir = join(ownedRoot, 'seed');
		originDir = join(ownedRoot, 'origin.git');
		originUrl = pathToFileURL(originDir).toString();
		mkdirSync(seedDir, { recursive: true });
		mkdirSync(originDir, { recursive: true });
		git(originDir, 'init', '--bare', '--initial-branch', 'main');
		git(seedDir, 'init', '--initial-branch', 'main');
		writeFileSync(join(seedDir, 'README.md'), 'fleet workspace\n');
		git(seedDir, 'add', 'README.md');
		git(seedDir, '-c', 'user.name=Fleet Test', '-c', 'user.email=fleet@test.invalid', 'commit', '-m', 'seed');
		git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');

		gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT ?? '0');
		process.env.GIT_CONFIG_COUNT = String(gitConfigIndex + 1);
		process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`] = `url.${originUrl}.insteadOf`;
		process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`] = remoteUrl;
	});

	afterAll(async () => {
		delete process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`];
		delete process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`];
		if (gitConfigIndex === 0) delete process.env.GIT_CONFIG_COUNT;
		else process.env.GIT_CONFIG_COUNT = String(gitConfigIndex);
		await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
	});

	it('removes an old, clean, never-pushed worktree through the provider, then the pool it emptied', async () => {
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-a', 'ever/repo-a', 'task/a', OLD);
		const { scanned, plan } = await scanAndPlan(rootPath);
		const [tree] = scanned.repositories[0].worktrees;
		expect(tree).toMatchObject({
			owned: true,
			dirty: false,
			unpushedCount: 0,
			remoteBranch: 'absent',
			hasUsageRecord: true,
			lease: null
		});
		expect(tree.lastUsedAt).toBe(OLD);
		expect(plan.remove).toHaveLength(1);
		expect(plan.keep).toHaveLength(0);

		const result = await runWorkspaceReap(plan, { now: () => NOW });
		expect(result.errors).toEqual([]);
		expect(result.removed).toHaveLength(1);
		expect(existsSync(descriptor.path)).toBe(false);
		// The pool held nothing that is not on the remote, so it followed.
		expect(result.removedPools).toHaveLength(1);
		expect(existsSync(scanned.repositories[0].pools[0].path)).toBe(false);
		expect(existsSync(scanned.repositories[0].repositoryRoot)).toBe(false);
	});

	it('keeps a worktree with a commit that is not on any remote', async () => {
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-b', 'ever/repo-b', 'task/b', OLD);
		commitIn(descriptor.path, 'local-only.txt');

		const { plan } = await scanAndPlan(rootPath);
		expect(plan.remove).toHaveLength(0);
		expect(plan.keep[0].reason).toContain('1 commit(s) not on any remote');
		await runWorkspaceReap(plan, { now: () => NOW });
		expect(existsSync(join(descriptor.path, 'local-only.txt'))).toBe(true);
	});

	it('keeps a pushed branch that is still open on the remote, and removes it once merged', async () => {
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-c', 'ever/repo-c', 'task/c', OLD);
		commitIn(descriptor.path, 'pushed.txt');
		// The node pushes to a URL, exactly as finalize does — this does NOT
		// update refs/remotes/origin/task/c in the pool. The scan has to.
		git(descriptor.path, 'push', originUrl, 'HEAD:refs/heads/task/c');

		const open = await scanAndPlan(rootPath);
		expect(open.scanned.repositories[0].worktrees[0]).toMatchObject({
			remoteBranch: 'present',
			unpushedCount: 0,
			mergedIntoDefault: false
		});
		expect(open.plan.remove).toHaveLength(0);
		expect(open.plan.keep[0].reason).toContain('still open on the remote');

		// Merge it into the default branch on the remote (a fast-forward).
		git(seedDir, 'fetch', originUrl, 'task/c');
		git(seedDir, 'merge', '--ff-only', 'FETCH_HEAD');
		git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');

		const merged = await scanAndPlan(rootPath);
		expect(merged.scanned.repositories[0].worktrees[0]).toMatchObject({
			remoteBranch: 'present',
			mergedIntoDefault: true
		});
		expect(merged.plan.remove).toHaveLength(1);
		expect(merged.plan.remove[0].reason).toContain('merged into the default branch');
		const result = await runWorkspaceReap(merged.plan, { now: () => NOW });
		expect(result.errors).toEqual([]);
		expect(existsSync(descriptor.path)).toBe(false);
	});

	it('keeps a dirty worktree, a young one, and one a live process holds a lease on', async () => {
		const rootPath = freshRoot();
		const dirty = await provisionAt(rootPath, 'task-d', 'ever/repo-d', 'task/d', OLD);
		writeFileSync(join(dirty.path, 'scratch.txt'), 'uncommitted\n');
		const young = await provisionAt(rootPath, 'task-e', 'ever/repo-e', 'task/e', NOW - DAY);
		// Provisioned but never released: this process still holds the lease.
		const busy = new FleetTaskWorkspaceProvisioner({ rootPath, now: () => OLD });
		const leased = await busy.provision('task-f', spec('ever/repo-f', 'task/f'));

		const { plan } = await scanAndPlan(rootPath);
		expect(plan.remove).toHaveLength(0);
		const reasons = new Map(plan.keep.map((verdict) => [verdict.record.path, verdict.reason]));
		expect(reasons.get(dirty.path)).toContain('uncommitted changes');
		expect(reasons.get(young.path)).toContain('within the max age');
		expect(reasons.get(leased.path)).toContain(`leased by pid ${process.pid}`);

		const result = await runWorkspaceReap(plan, { now: () => NOW });
		expect(result.removed).toHaveLength(0);
		for (const path of [dirty.path, young.path, leased.path]) expect(existsSync(path)).toBe(true);
		await busy.release('task-f', leased);
	});

	it('unlinks a mount link before removal so the mounted worktree survives untouched', async () => {
		const rootPath = freshRoot();
		const primary = await provisionAt(rootPath, 'task-g', 'ever/repo-g', 'task/g', OLD);
		const mounted = await provisionAt(rootPath, 'task-h', 'ever/repo-h', 'task/h', NOW - DAY);
		mkdirSync(join(primary.path, '.mounts'));
		await fs.symlink(
			mounted.path,
			join(primary.path, '.mounts', 'h'),
			process.platform === 'win32' ? 'junction' : 'dir'
		);

		const { scanned, plan } = await scanAndPlan(rootPath);
		const primaryRecord = scanned.repositories
			.flatMap((repository) => repository.worktrees)
			.find((tree) => tree.path === primary.path)!;
		expect(primaryRecord.mountLinks).toEqual([join(primary.path, '.mounts', 'h')]);
		// The link is excluded from the primary's Git, so it is still clean.
		expect(primaryRecord.dirty).toBe(false);
		expect(plan.remove.map((verdict) => verdict.record.path)).toEqual([primary.path]);

		const result = await runWorkspaceReap(plan, { now: () => NOW });
		expect(result.errors).toEqual([]);
		expect(existsSync(primary.path)).toBe(false);
		expect(existsSync(join(mounted.path, 'README.md'))).toBe(true);
		expect(git(mounted.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/h');
	});

	it('re-checks right before acting: a job lease that appears after planning keeps the worktree', async () => {
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-i', 'ever/repo-i', 'task/i', OLD);
		const { scanned, plan } = await scanAndPlan(rootPath);
		expect(plan.remove).toHaveLength(1);
		const gitDir = scanned.repositories[0].worktrees[0].gitDir!;
		await fs.writeFile(
			join(gitDir, 'ew-workspace-lease.json'),
			JSON.stringify({ version: 1, purpose: 'job', pid: 777_777, since: new Date(NOW).toISOString() })
		);

		const result = await runWorkspaceReap(plan, { now: () => NOW, isProcessAlive: () => true });
		expect(result.removed).toHaveLength(0);
		expect(result.kept[0].reason).toContain('leased by pid 777777');
		expect(existsSync(descriptor.path)).toBe(true);
		// The foreign lease was not replaced by the reaper's own.
		expect(await readWorkspaceLease(gitDir)).toMatchObject({ pid: 777_777, purpose: 'job' });
	});

	it('removes nothing offline — every remote fact is unknown', async () => {
		const rootPath = freshRoot();
		await provisionAt(rootPath, 'task-j', 'ever/repo-j', 'task/j', OLD);
		const { scanned, plan } = await scanAndPlan(rootPath, false);
		expect(scanned.remoteRefreshed).toBe(false);
		expect(scanned.repositories[0].worktrees[0].remoteBranch).toBe('unknown');
		expect(plan.remove).toHaveLength(0);
		expect(plan.keep[0].reason).toContain('remote state unknown');
	});

	it('keeps an emptied pool whose local branch still carries a commit not on any remote', async () => {
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-l', 'ever/repo-l', 'task/l', OLD);
		commitIn(descriptor.path, 'never-pushed.txt');
		// The provider's branch-change re-cut (and any manual clean-up) removes
		// the worktree but leaves refs/heads/task/l — and its commit — in the
		// bare pool. The pool is now the only copy of that work.
		const { scanned: before } = await scanAndPlan(rootPath);
		const poolPath = before.repositories[0].pools[0].path;
		git(poolPath, 'worktree', 'remove', '--force', descriptor.path);
		expect(existsSync(descriptor.path)).toBe(false);

		const { scanned, plan } = await scanAndPlan(rootPath);
		expect(scanned.repositories[0].worktrees).toHaveLength(0);
		expect(scanned.repositories[0].pools[0]).toMatchObject({
			registeredWorktrees: 0,
			remoteRefreshed: true,
			unpushedCount: 1
		});
		expect(plan.removePools).toHaveLength(0);
		expect(plan.keepPools[0].reason).toContain('1 commit(s) on local branches not on any remote');
		const result = await runWorkspaceReap(plan, { now: () => NOW });
		expect(result.removedPools).toHaveLength(0);
		expect(existsSync(poolPath)).toBe(true);
		expect(git(poolPath, 'rev-parse', '--verify', 'refs/heads/task/l')).toMatch(/^[0-9a-f]{40}$/);

		// Offline the same pool is kept too, for the honest reason: without
		// the remote nothing is removable, pools included.
		const offline = await scanAndPlan(rootPath, false);
		expect(offline.scanned.repositories[0].pools[0].remoteRefreshed).toBe(false);
		expect(offline.plan.removePools).toHaveLength(0);
		expect(offline.plan.keepPools[0].reason).toContain('remote state unknown');
	});

	it('reports a foreign directory at a worktree path as unowned and never touches it', async () => {
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-k', 'ever/repo-k', 'task/k', OLD);
		const foreign = join(descriptor.path, '..', 'fleet-not-ours');
		mkdirSync(foreign);
		writeFileSync(join(foreign, 'keep.txt'), "not the fleet's\n");

		const { scanned, plan } = await scanAndPlan(rootPath);
		const record = scanned.repositories[0].worktrees.find((tree) => tree.path === foreign)!;
		expect(record.owned).toBe(false);
		expect(plan.keep.find((verdict) => verdict.record.path === foreign)?.reason).toContain('ownership unproven');
		await runWorkspaceReap(plan, { now: () => NOW });
		expect(existsSync(join(foreign, 'keep.txt'))).toBe(true);
	});
});
