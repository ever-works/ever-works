import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FleetTaskWorkspaceProvisioner } from './fleet-task-workspace';
import { listMountLinks, scanWorkspaceRoot, type WorkspacePoolRecord } from './workspace-inventory';
import { planWorkspaceReap, policyFromConfig, runWorkspaceReap } from './workspace-reaper';

/**
 * Reaper safety, second pass (review AO-1, AO-2, AO-3, AO-4, AO-5).
 *
 * Every case here is an irreversible delete the reaper WOULD have
 * performed on evidence that structurally could not see the thing it was
 * about to destroy: content hidden from `git status` by the node's own
 * exclude rules, a commit reachable only from a reflog, a `.mounts` that
 * is itself a junction into another Task's checkout, a relocated
 * repository cache behind a reparse point, and a lease file this build
 * cannot parse.
 *
 * They live in their own file because each needs a hand-built anomaly on
 * disk rather than the happy-path provision the main suite exercises.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const OLD = NOW - 30 * DAY;
const policy = policyFromConfig({ maxAgeDays: 14, maxCount: null });

const testTemporaryDirectory = process.env.RUNNER_TEMP ?? tmpdir();
const canonicalTemporaryDirectory = realpathSync.native(testTemporaryDirectory);

/** Junction on Windows, directory symlink elsewhere — what the provisioner itself creates. */
const linkDir = async (target: string, path: string): Promise<void> => {
	await fs.symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
};

describe.sequential('workspace reaper — evidence it could not see', { timeout: 90_000 }, () => {
	let ownedRoot: string;
	let seedDir: string;
	let originDir: string;
	let originUrl: string;
	let gitConfigIndex: number;
	let counter = 0;
	const remoteUrl = 'https://fleet-reaper-safety.invalid/ever/repository.git';

	const spec = (repositoryId: string, branch: string) => ({
		repositoryId,
		repoUrl: remoteUrl,
		baseRef: 'main',
		branch
	});

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

	const scanAndPlan = async (rootPath: string) => {
		const scanned = await scanWorkspaceRoot(rootPath, { refreshRemote: true, now: () => NOW });
		return { scanned, plan: planWorkspaceReap(scanned, policy, NOW) };
	};

	beforeAll(() => {
		ownedRoot = realpathSync.native(mkdtempSync(join(canonicalTemporaryDirectory, 'ew-reaper-safety-')));
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

	it('never enumerates through a `.mounts` that is ITSELF a junction (review AO-1)', async () => {
		// The model runs in the reused primary worktree as the node service
		// account and can replace `.mounts` with a junction; for a
		// single-repository task the provisioner deliberately LEAVES that
		// link in place rather than deleting it, and `/.mounts` is in the
		// pool's `info/exclude`, so `git status` reports nothing and the
		// worktree reads clean. `listMountLinks` then did a bare `readdir`,
		// which RESOLVES the junction — so the reaper listed the entries of
		// the junction's target (another Task's live checkout) and unlinked
		// them there, while reporting that it had removed only this
		// worktree.
		const rootPath = freshRoot();
		const primary = await provisionAt(rootPath, 'task-m1', 'ever/repo-m1', 'task/m1', OLD);
		const victim = await provisionAt(rootPath, 'task-m2', 'ever/repo-m2', 'task/m2', NOW - DAY);
		// The victim's own `.mounts`, with a link inside it — the shape the
		// reaper is entitled to unlink, planted where it must NOT reach.
		mkdirSync(join(victim.path, '.mounts'));
		await linkDir(seedDir, join(victim.path, '.mounts', 'seed'));
		// ...and the primary's `.mounts` is a junction to it.
		await linkDir(join(victim.path, '.mounts'), join(primary.path, '.mounts'));

		// The enumerator itself refuses to look through it.
		expect(await listMountLinks(primary.path)).toEqual([]);
		expect(await listMountLinks(victim.path)).toEqual([join(victim.path, '.mounts', 'seed')]);

		const { scanned, plan } = await scanAndPlan(rootPath);
		const record = scanned.repositories
			.flatMap((repository) => repository.worktrees)
			.find((tree) => tree.path === primary.path)!;
		expect(record.mountsDir).toBe('foreign');
		expect(record.mountLinks).toEqual([]);
		// Clean by `git status` — which is exactly why this needed its own rule.
		expect(record.dirty).toBe(false);
		expect(plan.remove.map((verdict) => verdict.record.path)).not.toContain(primary.path);
		expect(plan.keep.find((verdict) => verdict.record.path === primary.path)?.reason).toContain('`.mounts`');

		const result = await runWorkspaceReap(plan, { now: () => NOW });
		expect(result.errors).toEqual([]);
		expect(existsSync(primary.path)).toBe(true);
		// Nothing was unlinked through the junction.
		expect(existsSync(join(victim.path, '.mounts', 'seed'))).toBe(true);
		expect(existsSync(join(seedDir, 'README.md'))).toBe(true);
	});

	it('keeps a worktree holding output the node`s own exclude rules hide (review AO-4)', async () => {
		// `.ever-works/` is where the OUTPUT CONTRACT tells the model to
		// write an owner question, and the node writes that very path into
		// the pool's shared `info/exclude` — so the reaper's entire "no
		// uncommitted work" proof (`git status --porcelain
		// --untracked-files=all`) reports nothing for it. A run interrupted
		// between the model writing QUESTION.md and `collectOwnerQuestion`
		// reading it therefore looked perfectly clean, and the question the
		// owner was supposed to answer was deleted with no trace in `errors`
		// or `kept`.
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-q', 'ever/repo-q', 'task/q', OLD);
		mkdirSync(join(descriptor.path, '.ever-works'));
		writeFileSync(join(descriptor.path, '.ever-works', 'QUESTION.md'), '# Which database?\n');

		const { scanned, plan } = await scanAndPlan(rootPath);
		const [record] = scanned.repositories[0].worktrees;
		// Git genuinely cannot see it: that is the premise, asserted.
		expect(git(descriptor.path, 'status', '--porcelain', '--untracked-files=all')).toBe('');
		expect(record.dirty).toBe(false);
		expect(record.excludedOutput).toBe(true);
		expect(plan.remove).toHaveLength(0);
		expect(plan.keep[0].reason).toContain('.ever-works');

		const result = await runWorkspaceReap(plan, { now: () => NOW });
		expect(result.removed).toHaveLength(0);
		expect(existsSync(join(descriptor.path, '.ever-works', 'QUESTION.md'))).toBe(true);

		// And once the question has been collected — the normal path removes
		// the file AND the directory — the worktree is reclaimable again, so
		// this rule does not simply switch the reaper off.
		await fs.rm(join(descriptor.path, '.ever-works'), { recursive: true, force: true });
		const after = await scanAndPlan(rootPath);
		expect(after.scanned.repositories[0].worktrees[0].excludedOutput).toBe(false);
		expect(after.plan.remove).toHaveLength(1);
	});

	it('keeps a pool whose only copy of a commit is in a branch reflog (review AO-2)', async () => {
		// `rev-list --count --branches --not --remotes` sees only
		// `refs/heads/*`. The provider's own `worktree add -B <branch> <dir>
		// <startPoint>` force-resets an existing local branch, so a commit
		// from a run whose publish was withheld ends up reachable from that
		// branch's REFLOG alone — at which point `--branches` answers 0 and
		// `fs.rm(pool.path, {recursive: true})` takes the object store, the
		// commit and the reflog that was its last reference.
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-r', 'ever/repo-r', 'task/r', OLD);
		commitIn(descriptor.path, 'never-pushed.txt');
		const lost = git(descriptor.path, 'rev-parse', 'HEAD');

		const { scanned: before } = await scanAndPlan(rootPath);
		const poolPath = before.repositories[0].pools[0].path;
		// Remove the worktree, then re-cut the same branch onto the base —
		// exactly what the provider does on a retry whose branch was never
		// pushed. The commit is now reflog-only.
		git(poolPath, 'worktree', 'remove', '--force', descriptor.path);
		git(poolPath, 'branch', '--force', 'task/r', 'refs/remotes/origin/main');
		expect(git(poolPath, 'rev-list', '--count', '--branches', '--not', '--remotes')).toBe('0');
		expect(git(poolPath, 'reflog', 'show', 'task/r')).toContain(lost.slice(0, 7));

		const { scanned, plan } = await scanAndPlan(rootPath);
		expect(scanned.repositories[0].pools[0].unpushedCount).toBeGreaterThan(0);
		expect(plan.removePools).toHaveLength(0);
		expect(plan.keepPools[0].reason).toContain('not on any remote');

		const result = await runWorkspaceReap(plan, { now: () => NOW });
		expect(result.removedPools).toHaveLength(0);
		expect(existsSync(poolPath)).toBe(true);
		// The commit is still there to be recovered.
		expect(git(poolPath, 'cat-file', '-t', lost)).toBe('commit');
	});

	it('never rmdir`s a relocated `worktrees` reparse point (review AO-5)', async () => {
		// The scanner classifies a `repos`/`worktrees` that is not a plain
		// directory as unrecognised and promises unrecognised entries are
		// "reported, never touched". `removeEmptyRepositoryRoot` then
		// `rmdir`-ed both by NAME, and on Windows removing a reparse point
		// always succeeds regardless of what is behind it — so an operator
		// who moved a repository cache onto a larger volume lost the only
		// path to those checkouts while being told a pool was reclaimed.
		const rootPath = freshRoot();
		const repositoryRoot = join(rootPath, 'repositories', 'relocated');
		const poolPath = join(repositoryRoot, 'repos', 'pool.git');
		mkdirSync(poolPath, { recursive: true });
		git(poolPath, 'init', '--bare', '--initial-branch', 'main');
		// The relocated checkouts, on "another volume".
		const elsewhere = join(ownedRoot, `elsewhere-${counter}`);
		mkdirSync(elsewhere, { recursive: true });
		writeFileSync(join(elsewhere, 'checkout.txt'), 'still on disk\n');
		await linkDir(elsewhere, join(repositoryRoot, 'worktrees'));

		const pool: WorkspacePoolRecord = {
			path: poolPath,
			repositoryRoot,
			remoteUrl: null,
			registeredWorktrees: 0,
			pendingIntents: 0,
			lastUsedAt: OLD,
			sizeBytes: 0,
			owned: true,
			ownershipNote: null,
			defaultBranch: 'main',
			remoteRefreshed: true,
			unpushedCount: 0
		};
		const result = await runWorkspaceReap(
			{
				policy,
				plannedAt: NOW,
				remove: [],
				keep: [],
				removePools: [{ pool, reason: 'no worktree registered; unused for 30 d' }],
				keepPools: [],
				reclaimableBytes: 0
			},
			{ now: () => NOW }
		);
		expect(result.errors).toEqual([]);
		expect(result.removedPools).toHaveLength(1);
		expect(existsSync(poolPath)).toBe(false);
		// The reparse point and everything behind it survived.
		expect(existsSync(join(repositoryRoot, 'worktrees'))).toBe(true);
		expect(existsSync(join(elsewhere, 'checkout.txt'))).toBe(true);
	});

	it('keeps a worktree whose lease this build cannot parse (review AO-3)', async () => {
		// A staged CLI upgrade leaves two builds on one machine — the worker
		// runs as a Windows service while an operator runs `gc` from a shell
		// — so the running job's lease can be a `version` this build does not
		// know, or a torn write from a hard kill. `acquireWorkspaceLease`
		// used to delete anything it could not parse and take the slot, and
		// the re-checks that follow catch nothing while the model is between
		// commits, so `teardown` ran `git worktree remove --force` on a live
		// job.
		const rootPath = freshRoot();
		const descriptor = await provisionAt(rootPath, 'task-l', 'ever/repo-l', 'task/l', OLD);
		const { scanned, plan } = await scanAndPlan(rootPath);
		expect(plan.remove).toHaveLength(1);
		const gitDir = scanned.repositories[0].worktrees[0].gitDir!;
		const torn = '{"version":1,"purpose":"jo';
		await fs.writeFile(join(gitDir, 'ew-workspace-lease.json'), torn);

		// The pid oracle says nothing is alive: the old rule reclaimed on
		// exactly that basis.
		const result = await runWorkspaceReap(plan, { now: () => NOW, isProcessAlive: () => false });
		expect(result.removed).toHaveLength(0);
		expect(result.kept[0].reason).toContain('unreadable');
		expect(existsSync(descriptor.path)).toBe(true);
		// The foreign lease was neither replaced nor deleted.
		expect(await fs.readFile(join(gitDir, 'ew-workspace-lease.json'), 'utf8')).toBe(torn);
	});
});
