import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LocalWorkspacePlugin } from '../local-workspace.plugin.js';

/**
 * Hermetic loopback suite: a real local BARE repo plays "origin"
 * (file:// URL — no network, no tokens), and the plugin runs real git
 * against it. Beyond the shared workspace-contract behaviour
 * (fetch-first provision, finalize commit+push, merge simulation with
 * NAMED conflict paths), this suite pins down what makes the local
 * provider LOCAL: the persistent pool (one base clone per repo, real
 * `git worktree add` per task), worktree REUSE across runs, binding
 * self-heal by recreate, per-repo provision serialization, and GC with
 * `git worktree prune`.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let root: string;
let originDir: string;
let originUrl: string;
let seedDir: string;
let baseDir: string;
let plugin: LocalWorkspacePlugin;

const settings = () => ({ baseDir, fetchDepth: 1 });

const spec = (bindingKey: string, branch: string) => ({
	repoUrl: originUrl,
	baseRef: 'main',
	branch,
	bindingKey,
	settings: settings()
});

const seedCommit = (file: string, content: string, message: string): string => {
	writeFileSync(join(seedDir, file), content);
	git(seedDir, 'add', '-A');
	git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', message);
	git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
	return git(seedDir, 'rev-parse', 'HEAD');
};

/** The pool must hold exactly ONE base clone for the loopback origin. */
const poolRepoDir = (): string => {
	const repos = join(baseDir, 'repos');
	const entries = existsSync(repos) ? readdirSync(repos) : [];
	if (entries.length !== 1) {
		throw new Error(`expected exactly 1 pool repo, found ${entries.length}`);
	}
	return join(repos, entries[0]);
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-local-ws-'));
	originDir = join(root, 'origin.git');
	seedDir = join(root, 'seed');
	baseDir = join(root, 'workspaces');
	mkdirSync(originDir, { recursive: true });
	mkdirSync(seedDir, { recursive: true });
	git(originDir, 'init', '--bare', '--initial-branch', 'main');
	originUrl = pathToFileURL(originDir).toString();
	git(seedDir, 'init', '--initial-branch', 'main');
	seedCommit('README.md', 'hello\n', 'seed: initial');
	plugin = new LocalWorkspacePlugin();
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('provision (persistent pool + worktree)', () => {
	it('cuts a fresh worktree branch from the CURRENT origin base (fetch-first)', async () => {
		const latest = seedCommit('a.txt', 'a\n', 'seed: advance base');
		const handle = await plugin.provision(spec('lw-task-1', 'task/first-run-aaaa1111'));
		expect(handle.reused).toBe(false);
		expect(handle.baseSha).toBe(latest);
		expect(handle.path).toBe(join(baseDir, 'worktrees', 'lw-task-1'));
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(latest);
		expect(git(handle.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/first-run-aaaa1111');
		// The persisted remote must be token-free (here: the plain URL).
		expect(git(handle.path, 'remote', 'get-url', 'origin')).toBe(originUrl);
		// The checkout is a REAL linked worktree of the pool repo, not a clone.
		const gitFile = await fs.stat(join(handle.path, '.git'));
		expect(gitFile.isFile()).toBe(true);
	});

	it('REUSES the worktree across runs — same path, no teardown, no re-clone', async () => {
		const h1 = await plugin.provision(spec('lw-task-2', 'task/reuse-bbbb2222'));
		writeFileSync(join(h1.path, 'work.txt'), 'agent output\n');
		const fin = await plugin.finalize(h1, { commitMessage: 'agent: work', push: true });
		expect(fin.pushed).toBe(true);

		// Scratch state left behind by the run — a persistent worktree
		// must carry it into the next run (NOT torn down in between).
		writeFileSync(join(h1.path, 'scratch.txt'), 'uncommitted scratch\n');
		const pool = poolRepoDir();
		const configMtimeBefore = (await fs.stat(join(pool, 'config'))).mtimeMs;

		const h2 = await plugin.provision(spec('lw-task-2', 'task/reuse-bbbb2222'));
		expect(h2.path).toBe(h1.path);
		expect(h2.reused).toBe(true);
		expect(git(h2.path, 'rev-parse', 'HEAD')).toBe(fin.headSha);
		await expect(fs.readFile(join(h2.path, 'scratch.txt'), 'utf8')).resolves.toBe('uncommitted scratch\n');
		// No re-clone / remote rewrite: the pool repo config was untouched.
		const configMtimeAfter = (await fs.stat(join(pool, 'config'))).mtimeMs;
		expect(configMtimeAfter).toBe(configMtimeBefore);
	});

	it('self-heals a branch collision: same binding, different branch → recreate', async () => {
		const h1 = await plugin.provision(spec('lw-task-3', 'task/heal-cccc3333'));
		writeFileSync(join(h1.path, 'stale.txt'), 'stale\n');

		// The stamp says task/heal-cccc3333; asking for another branch on
		// the same binding is a collision → remove --force + recreate.
		const h2 = await plugin.provision(spec('lw-task-3', 'task/heal-dddd4444'));
		expect(h2.path).toBe(h1.path);
		expect(h2.reused).toBe(false);
		expect(git(h2.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/heal-dddd4444');
		expect(existsSync(join(h2.path, 'stale.txt'))).toBe(false);
	});

	it('self-heals a foreign/corrupt binding stamp instead of bricking', async () => {
		const h1 = await plugin.provision(spec('lw-task-4', 'task/stamp-eeee5555'));
		writeFileSync(join(h1.path, 'stale.txt'), 'stale\n');

		// Corrupt the stamp INSIDE the worktree's private gitdir (it must
		// live there, never in the working tree).
		const gitDir = git(h1.path, 'rev-parse', '--path-format=absolute', '--git-dir');
		expect(existsSync(join(gitDir, 'ew-workspace.json'))).toBe(true);
		writeFileSync(
			join(gitDir, 'ew-workspace.json'),
			JSON.stringify({ bindingKey: 'someone-else', branch: 'task/stamp-eeee5555' })
		);

		const h2 = await plugin.provision(spec('lw-task-4', 'task/stamp-eeee5555'));
		expect(h2.path).toBe(h1.path);
		expect(git(h2.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/stamp-eeee5555');
		expect(existsSync(join(h2.path, 'stale.txt'))).toBe(false);
	});

	it('provisions two tasks in PARALLEL into two worktrees of ONE pool repo', async () => {
		const latest = git(seedDir, 'rev-parse', 'HEAD');
		// Promise.all on one repo-key exercises the per-repo mutex —
		// unserialized concurrent `git worktree add` corrupts refs.
		const [ha, hb] = await Promise.all([
			plugin.provision(spec('lw-par-a', 'task/par-a-11112222')),
			plugin.provision(spec('lw-par-b', 'task/par-b-33334444'))
		]);
		expect(ha.path).not.toBe(hb.path);
		expect(git(ha.path, 'rev-parse', 'HEAD')).toBe(latest);
		expect(git(hb.path, 'rev-parse', 'HEAD')).toBe(latest);
		expect(git(ha.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/par-a-11112222');
		expect(git(hb.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/par-b-33334444');

		// ONE base clone serves both.
		const repos = await fs.readdir(join(baseDir, 'repos'));
		expect(repos).toHaveLength(1);
		const list = git(join(baseDir, 'repos', repos[0]), 'worktree', 'list');
		expect(list).toContain('lw-par-a');
		expect(list).toContain('lw-par-b');
	});
});

describe('finalize', () => {
	it('reports empty when the run produced no changes', async () => {
		const handle = await plugin.provision(spec('lw-task-5', 'task/empty-ffff6666'));
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: nothing', push: true });
		expect(fin.empty).toBe(true);
		expect(fin.pushed).toBe(false);
		// Run telemetry — an empty run honestly reports zero changed files.
		expect(fin.changedFiles).toBe(0);
	});

	it('commits and pushes changes to the task branch, never the base', async () => {
		const baseBefore = git(seedDir, 'rev-parse', 'HEAD');
		const handle = await plugin.provision(spec('lw-task-6', 'task/push-77778888'));
		writeFileSync(join(handle.path, 'feature.txt'), 'new feature\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: feature', push: true });
		expect(fin.pushed).toBe(true);
		expect(fin.headSha).not.toBe(handle.baseSha);
		// Run telemetry — the branch's file footprint vs the base it was
		// cut from, which is what `agent_runs.changedFilesCount` shows.
		expect(fin.changedFiles).toBe(1);

		// Remote task branch has the commit; remote main is untouched.
		const remoteBranch = git(originDir, 'rev-parse', 'refs/heads/task/push-77778888');
		expect(remoteBranch).toBe(fin.headSha);
		expect(git(originDir, 'rev-parse', 'refs/heads/main')).toBe(baseBefore);
	});
});

describe('simulateMerge', () => {
	it('reports clean when the branch applies onto the target', async () => {
		const handle = await plugin.provision(spec('lw-task-7', 'task/clean-9999aaaa'));
		writeFileSync(join(handle.path, 'clean-add.txt'), 'no conflict here\n');
		await plugin.finalize(handle, { commitMessage: 'agent: clean add', push: false });

		const sim = await plugin.simulateMerge(handle, 'main');
		expect(sim.clean).toBe(true);
		expect(sim.conflictPaths).toEqual([]);
	});

	it('NAMES the conflicting paths when base moved incompatibly', async () => {
		const handle = await plugin.provision(spec('lw-task-8', 'task/conflict-bbbbcccc'));

		// Branch edits README one way…
		writeFileSync(join(handle.path, 'README.md'), 'branch version\n');
		await plugin.finalize(handle, { commitMessage: 'agent: edit readme', push: false });

		// …meanwhile the base moves the SAME file the other way.
		seedCommit('README.md', 'base version\n', 'seed: conflicting readme');

		const sim = await plugin.simulateMerge(handle, 'main');
		expect(sim.clean).toBe(false);
		expect(sim.conflictPaths).toContain('README.md');
	});
});

describe('teardown', () => {
	it('removes the worktree AND its pool registration, keeping the pool repo', async () => {
		const handle = await plugin.provision(spec('lw-task-9', 'task/tear-ddddeeee'));
		const pool = poolRepoDir();
		expect(git(pool, 'worktree', 'list')).toContain('lw-task-9');

		await plugin.teardown(handle);
		expect(existsSync(handle.path)).toBe(false);
		expect(git(pool, 'worktree', 'list')).not.toContain('lw-task-9');
		// The pool repo itself PERSISTS — that is the whole point.
		expect(existsSync(join(pool, 'HEAD'))).toBe(true);
	});
});

describe('gc', () => {
	it('removes only worktrees older than the cutoff and prunes the pool', async () => {
		process.env.EW_WORKSPACES_DIR = baseDir;
		try {
			const oldHandle = await plugin.provision(spec('lw-gc-old', 'task/gc-old-ffff0000'));
			const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
			await fs.utimes(oldHandle.path, past, past);

			const freshHandle = await plugin.provision(spec('lw-gc-fresh', 'task/gc-fresh-00001111'));

			const { removed } = await plugin.gc({ olderThanDays: 14 });
			expect(removed).toContain('lw-gc-old');
			expect(removed).not.toContain('lw-gc-fresh');
			expect(existsSync(oldHandle.path)).toBe(false);
			expect(existsSync(freshHandle.path)).toBe(true);

			// The pool repo survives GC and its bookkeeping was pruned.
			const pool = poolRepoDir();
			expect(existsSync(join(pool, 'HEAD'))).toBe(true);
			const list = git(pool, 'worktree', 'list');
			expect(list).not.toContain('lw-gc-old');
			expect(list).toContain('lw-gc-fresh');
		} finally {
			delete process.env.EW_WORKSPACES_DIR;
		}
	});
});
