import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LocalWorkspacePlugin, assertRemoteCloneUrl } from '../local-workspace.plugin.js';

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

	it('migrates an exact pre-v2 binding stamp under the existing Git registration and reuses the worktree', async () => {
		const bindingKey = 'lw-task-v1-migrate';
		const branch = 'task/v1-migrate-10101010';
		const first = await plugin.provision(spec(bindingKey, branch));
		writeFileSync(join(first.path, 'must-remain.txt'), 'persistent task state\n');
		const gitDir = git(first.path, 'rev-parse', '--path-format=absolute', '--git-dir');
		const stampPath = join(gitDir, 'ew-workspace.json');
		writeFileSync(stampPath, JSON.stringify({ bindingKey, branch }));

		const reused = await plugin.provision(spec(bindingKey, branch));
		expect(reused.reused).toBe(true);
		expect(reused.path).toBe(first.path);
		await expect(fs.readFile(join(reused.path, 'must-remain.txt'), 'utf8')).resolves.toBe(
			'persistent task state\n'
		);
		expect(JSON.parse(await fs.readFile(stampPath, 'utf8'))).toMatchObject({
			version: 2,
			bindingKey,
			branch
		});
	});

	it('preserves a valid v1 stamp when the atomic replacement fails, then migrates on retry', async () => {
		const bindingKey = 'lw-task-v1-crash';
		const branch = 'task/v1-crash-20202020';
		const first = await plugin.provision(spec(bindingKey, branch));
		const gitDir = git(first.path, 'rev-parse', '--path-format=absolute', '--git-dir');
		const stampPath = join(gitDir, 'ew-workspace.json');
		const legacy = JSON.stringify({ bindingKey, branch });
		writeFileSync(stampPath, legacy);

		const interrupted = new LocalWorkspacePlugin({
			replaceFile: async () => {
				throw Object.assign(new Error('simulated atomic replace crash'), { code: 'EIO' });
			}
		} as never);
		await expect(interrupted.provision(spec(bindingKey, branch))).rejects.toThrow(/replace crash|owned|binding/i);
		await expect(fs.readFile(stampPath, 'utf8')).resolves.toBe(legacy);

		const retried = await new LocalWorkspacePlugin().provision(spec(bindingKey, branch));
		expect(retried.reused).toBe(true);
		expect(JSON.parse(await fs.readFile(stampPath, 'utf8'))).toMatchObject({
			version: 2,
			bindingKey,
			branch
		});
	});

	it('reconciles an exact stale Git registration when its deterministic worktree path is absent', async () => {
		const bindingKey = 'lw-task-missing-path';
		const branch = 'task/missing-path-30303030';
		const first = await plugin.provision(spec(bindingKey, branch));
		const pool = poolRepoDir();
		await fs.rm(first.path, { recursive: true, force: true, maxRetries: 3 });
		expect(git(pool, 'worktree', 'list', '--porcelain')).toContain(bindingKey);

		const retried = await new LocalWorkspacePlugin().provision(spec(bindingKey, branch));
		expect(retried.path).toBe(first.path);
		expect(git(retried.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
		const registrations = git(pool, 'worktree', 'list', '--porcelain');
		expect(registrations.match(new RegExp(bindingKey, 'g'))).toHaveLength(1);
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

	it('preserves a worktree with a foreign/corrupt binding stamp instead of deleting it', async () => {
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

		await expect(plugin.provision(spec('lw-task-4', 'task/stamp-eeee5555'))).rejects.toThrow(/owned|binding/i);
		expect(git(h1.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/stamp-eeee5555');
		expect(await fs.readFile(join(h1.path, 'stale.txt'), 'utf8')).toBe('stale\n');
	});

	it.runIf(process.platform === 'win32')(
		'rejects a junction alias and preserves the other registered worktree it targets',
		async () => {
			const victimBranch = 'task/alias-victim-11112222';
			const victim = await plugin.provision(spec('lw-alias-victim', victimBranch));
			writeFileSync(join(victim.path, 'must-survive.txt'), 'victim data\n');
			const victimGitDir = git(victim.path, 'rev-parse', '--path-format=absolute', '--git-dir');
			writeFileSync(
				join(victimGitDir, 'ew-workspace.json'),
				JSON.stringify({ bindingKey: 'lw-alias-attacker', branch: victimBranch })
			);
			const aliasPath = join(baseDir, 'worktrees', 'lw-alias-attacker');
			await fs.symlink(victim.path, aliasPath, 'junction');

			await expect(plugin.provision(spec('lw-alias-attacker', 'task/alias-attacker-33334444'))).rejects.toThrow(
				/owned|binding|path/i
			);
			expect(await fs.readFile(join(victim.path, 'must-survive.txt'), 'utf8')).toBe('victim data\n');
			expect(git(victim.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(victimBranch);
		}
	);

	it('refuses to delete a worktree registered to a different repository pool', async () => {
		const victim = await plugin.provision(spec('lw-repo-owner', 'task/repo-owner-55556666'));
		writeFileSync(join(victim.path, 'must-survive.txt'), 'original repository data\n');
		const otherOriginDir = join(root, 'other-origin.git');
		mkdirSync(otherOriginDir, { recursive: true });
		git(otherOriginDir, 'init', '--bare', '--initial-branch', 'main');
		const otherOriginUrl = pathToFileURL(otherOriginDir).toString();
		git(seedDir, 'push', otherOriginUrl, 'HEAD:refs/heads/main');

		await expect(
			plugin.provision({
				...spec('lw-repo-owner', 'task/repo-other-77778888'),
				repoUrl: otherOriginUrl
			})
		).rejects.toThrow(/owned|repository|registration/i);
		expect(await fs.readFile(join(victim.path, 'must-survive.txt'), 'utf8')).toBe('original repository data\n');
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

	it('releases settled repository and worktree mutex entries after concurrent reuse stress', async () => {
		const stressPlugin = new LocalWorkspacePlugin();
		const tasks = Array.from({ length: 8 }, (_, index) => ({
			bindingKey: `lw-lock-stress-${index}`,
			branch: `task/lock-stress-${index}-abcdef12`
		}));
		const first = await Promise.all(
			tasks.map((task) => stressPlugin.provision(spec(task.bindingKey, task.branch)))
		);

		await expect
			.poll(() => (stressPlugin as unknown as { repoLocks: Map<string, Promise<void>> }).repoLocks.size, {
				timeout: 1_000
			})
			.toBe(0);

		const reused = await Promise.all(
			tasks.map((task) => stressPlugin.provision(spec(task.bindingKey, task.branch)))
		);
		expect(reused.every((handle, index) => handle.reused && handle.path === first[index].path)).toBe(true);
		await expect
			.poll(() => (stressPlugin as unknown as { repoLocks: Map<string, Promise<void>> }).repoLocks.size, {
				timeout: 1_000
			})
			.toBe(0);
	});

	it('terminates a blocking Git process tree and settles promptly on cancellation', async () => {
		const controller = new AbortController();
		let blockingCalls = 0;
		const child = { pid: 4242, kill: () => true };
		const blockingExecFile = ((
			_command: string,
			args: string[],
			_options: Record<string, unknown>,
			callback: (error: Error | null, stdout?: string, stderr?: string) => void
		) => {
			if (args[0] === '--version') {
				queueMicrotask(() => callback(null, 'git version test', ''));
				return child;
			}
			blockingCalls += 1;
			return child;
		}) as never;
		const terminated: unknown[] = [];
		const blockingPlugin = new LocalWorkspacePlugin({
			execFile: blockingExecFile,
			terminateProcessTree: async (received) => {
				terminated.push(received);
			}
		});
		const pending = blockingPlugin.provision({
			...spec('lw-abort', 'task/abort-99990000'),
			signal: controller.signal
		} as never);

		await expect.poll(() => blockingCalls, { timeout: 500 }).toBeGreaterThan(0);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(terminated).toEqual([child]);
	});

	it('surfaces an unproven Git/helper tree cancellation for worker quarantine', async () => {
		const controller = new AbortController();
		let blockingCalls = 0;
		const child = { pid: 4343, kill: () => false };
		const blockingExecFile = ((
			_command: string,
			args: string[],
			_options: Record<string, unknown>,
			callback: (error: Error | null, stdout?: string, stderr?: string) => void
		) => {
			if (args[0] === '--version') queueMicrotask(() => callback(null, 'git version test', ''));
			else blockingCalls += 1;
			return child;
		}) as never;
		const blockingPlugin = new LocalWorkspacePlugin({
			execFile: blockingExecFile,
			terminateProcessTree: async () => {
				throw new Error('descendant still alive');
			}
		});
		const pending = blockingPlugin.provision({
			...spec('lw-abort-unproven', 'task/abort-unproven-99991111'),
			signal: controller.signal
		} as never);

		await expect.poll(() => blockingCalls, { timeout: 500 }).toBeGreaterThan(0);
		controller.abort();
		await expect(pending).rejects.toMatchObject({
			name: 'ProcessTreeTerminationError',
			message: expect.stringMatching(/could not be proven stopped/i)
		});
	});

	it('recovers the exact task workspace when cancellation lands after git worktree add', async () => {
		const controller = new AbortController();
		let abortedAfterAdd = false;
		const abortingExecFile = ((
			command: string,
			args: readonly string[],
			options: Record<string, unknown>,
			callback: (error: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => void
		) =>
			execFile(
				command,
				[...args],
				options as never,
				((error, stdout, stderr) => {
					if (!error && args[0] === 'worktree' && args[1] === 'add') {
						abortedAfterAdd = true;
						controller.abort();
					}
					callback(error, stdout, stderr);
				}) as never
			)) as unknown as typeof execFile;
		const interruptedPlugin = new LocalWorkspacePlugin({
			execFile: abortingExecFile,
			// This test owns post-add filesystem recovery. The separate live
			// process-tree harness proves the production terminator itself.
			terminateProcessTree: async () => undefined
		});
		const interruptedSpec = {
			...spec('lw-abort-after-add', 'task/abort-after-add-12121212'),
			signal: controller.signal
		};

		await expect(interruptedPlugin.provision(interruptedSpec)).rejects.toMatchObject({ name: 'AbortError' });
		expect(abortedAfterAdd).toBe(true);
		const interruptedPath = join(baseDir, 'worktrees', 'lw-abort-after-add');
		const interruptedGitDir = git(interruptedPath, 'rev-parse', '--path-format=absolute', '--git-dir');
		expect(existsSync(join(interruptedGitDir, 'ew-workspace.json'))).toBe(true);

		const retried = await new LocalWorkspacePlugin().provision({
			...interruptedSpec,
			signal: undefined
		});
		expect(retried.path).toBe(interruptedPath);
		expect(retried.branch).toBe('task/abort-after-add-12121212');
		expect(git(retried.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/abort-after-add-12121212');
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

/**
 * The publish fence. A fleet node holds its job on a LEASE, and the
 * platform re-offers the work the moment that lease lapses — while the
 * old node may still be mid-run behind a dropped Wi-Fi link or a lid
 * that was closed for an hour. Cancellation cannot help here: killing
 * `git push` does not retract a ref the remote already accepted, so two
 * nodes end up writing one task branch and the run that legitimately
 * owned the lease is the one that sees a non-fast-forward failure.
 *
 * These cases pin the only rule that holds during a total partition:
 * decide from the node's OWN clock, before the push spawns, and keep
 * the commit either way so the work is never lost.
 */
describe('finalize — publish fence (lease-bound side effects)', () => {
	const at = (clock: { ms: number }) => new LocalWorkspacePlugin({ now: () => clock.ms });

	it('withholds the push once the lease deadline has passed, keeping the commit local', async () => {
		const clock = { ms: Date.parse('2026-09-04T09:00:00.000Z') };
		const fenced = at(clock);
		const branch = 'task/fence-expired-11112222';
		const handle = await fenced.provision(spec('lw-fence-expired', branch));
		writeFileSync(join(handle.path, 'agent-output.txt'), 'work that must not be published\n');

		const fin = await fenced.finalize(handle, {
			commitMessage: 'agent: fenced by an expired lease',
			push: true,
			publishFence: { deadlineAt: clock.ms - 12_000, marginMs: 60_000 }
		});

		expect(fin.pushed).toBe(false);
		expect(fin.publishWithheld).toMatch(/lease on this work expired 12s ago/);
		// The work is COMMITTED and recoverable — only the publish is withheld.
		expect(fin.empty).toBe(false);
		expect(fin.headSha).not.toBe(handle.baseSha);
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(fin.headSha);
		expect(git(handle.path, 'status', '--porcelain')).toBe('');
		// …and the remote task branch was never created.
		expect(() => git(originDir, 'rev-parse', '--verify', `refs/heads/${branch}`)).toThrow();
	});

	it('withholds the push when less lease remains than a push needs', async () => {
		const clock = { ms: Date.parse('2026-09-04T10:00:00.000Z') };
		const fenced = at(clock);
		const branch = 'task/fence-margin-33334444';
		const handle = await fenced.provision(spec('lw-fence-margin', branch));
		writeFileSync(join(handle.path, 'agent-output.txt'), 'not enough lease left\n');

		const fin = await fenced.finalize(handle, {
			commitMessage: 'agent: fenced inside the margin',
			push: true,
			publishFence: { deadlineAt: clock.ms + 30_000, marginMs: 60_000 }
		});

		expect(fin.pushed).toBe(false);
		expect(fin.publishWithheld).toMatch(/only 30s of the lease remains, below the 60s/);
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(fin.headSha);
		expect(() => git(originDir, 'rev-parse', '--verify', `refs/heads/${branch}`)).toThrow();
	});

	it('fails CLOSED on a fence whose deadline cannot be read', async () => {
		const clock = { ms: Date.parse('2026-09-04T10:30:00.000Z') };
		const fenced = at(clock);
		const branch = 'task/fence-unreadable-55556666';
		const handle = await fenced.provision(spec('lw-fence-unreadable', branch));
		writeFileSync(join(handle.path, 'agent-output.txt'), 'deadline unknown\n');

		const fin = await fenced.finalize(handle, {
			commitMessage: 'agent: unreadable lease deadline',
			push: true,
			publishFence: { deadlineAt: Number.NaN, marginMs: 60_000 }
		});

		expect(fin.pushed).toBe(false);
		expect(fin.publishWithheld).toMatch(/lease deadline for this work is unknown/);
		expect(() => git(originDir, 'rev-parse', '--verify', `refs/heads/${branch}`)).toThrow();
	});

	it('pushes exactly as before while the lease comfortably covers the push', async () => {
		const clock = { ms: Date.parse('2026-09-04T11:00:00.000Z') };
		const fenced = at(clock);
		const branch = 'task/fence-open-77778888';
		const handle = await fenced.provision(spec('lw-fence-open', branch));
		writeFileSync(join(handle.path, 'agent-output.txt'), 'published normally\n');

		const fin = await fenced.finalize(handle, {
			commitMessage: 'agent: inside the lease',
			push: true,
			publishFence: { deadlineAt: clock.ms + 10 * 60_000, marginMs: 60_000 }
		});

		expect(fin.pushed).toBe(true);
		expect(fin.publishWithheld).toBeUndefined();
		expect(git(originDir, 'rev-parse', `refs/heads/${branch}`)).toBe(fin.headSha);
	});

	it('leaves a caller that supplies NO fence — the cloud runner — byte-for-byte unchanged', async () => {
		// The cloud path holds no lease at all, so the fence must be
		// unreachable rather than merely lenient there: same Git commands,
		// same order, same push.
		const invocations: string[][] = [];
		const recording = ((
			command: string,
			args: readonly string[],
			options: Record<string, unknown>,
			callback: (error: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => void
		) => {
			invocations.push([command, ...args]);
			return execFile(command, [...args], options as never, callback as never);
		}) as unknown as typeof execFile;
		const cloudLike = new LocalWorkspacePlugin({
			execFile: recording,
			// A clock that is ALWAYS past any conceivable deadline: if the
			// fence were ever consulted without one being supplied, this
			// finalize could not push.
			now: () => Number.MAX_SAFE_INTEGER
		});
		const branch = 'task/fence-absent-9999aaaa';
		const handle = await cloudLike.provision(spec('lw-fence-absent', branch));
		writeFileSync(join(handle.path, 'agent-output.txt'), 'cloud parity\n');
		invocations.length = 0;

		const fin = await cloudLike.finalize(handle, { commitMessage: 'agent: no lease here', push: true });

		expect(fin.pushed).toBe(true);
		expect(fin.publishWithheld).toBeUndefined();
		expect(git(originDir, 'rev-parse', `refs/heads/${branch}`)).toBe(fin.headSha);
		expect(invocations.map((argv) => argv.slice(0, 3))).toEqual([
			['git', 'add', '-A'],
			['git', 'status', '--porcelain'],
			['git', '-c', 'user.name=Ever Works Agent'],
			['git', 'rev-parse', 'HEAD'],
			['git', 'diff', '--name-only'],
			['git', 'remote', 'get-url'],
			['git', 'push', originUrl]
		]);
	});
});

describe('finalize — cancellation (agent execution v2 review follow-up)', () => {
	it('refuses an already-aborted finalize before any Git call, leaving the tree uncommitted', async () => {
		const handle = await plugin.provision(spec('task-cancel-1', 'task/cancel-1'));
		writeFileSync(join(handle.path, 'cancel.txt'), 'never committed\n');
		const controller = new AbortController();
		controller.abort(new Error('lease lost'));

		await expect(
			plugin.finalize(handle, { commitMessage: 'agent: cancelled', push: true, signal: controller.signal })
		).rejects.toMatchObject({ name: 'AbortError' });

		// Nothing was staged, committed or pushed.
		expect(git(handle.path, 'status', '--porcelain')).toContain('cancel.txt');
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(handle.baseSha);
		expect(() => git(originDir, 'rev-parse', '--verify', 'refs/heads/task/cancel-1')).toThrow();
	});

	it('surfaces a cancellation that lands during the changed-files diff instead of reporting success', async () => {
		const controller = new AbortController();
		let abortedDuringDiff = false;
		const abortingExecFile = ((
			command: string,
			args: readonly string[],
			options: Record<string, unknown>,
			callback: (error: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => void
		) =>
			execFile(
				command,
				[...args],
				options as never,
				((error, stdout, stderr) => {
					if (!error && args[0] === 'diff' && args[1] === '--name-only') {
						abortedDuringDiff = true;
						controller.abort(new Error('lease lost'));
					}
					callback(error, stdout, stderr);
				}) as never
			)) as unknown as typeof execFile;
		const interruptedPlugin = new LocalWorkspacePlugin({
			execFile: abortingExecFile,
			terminateProcessTree: async () => undefined
		});
		const handle = await interruptedPlugin.provision(spec('task-cancel-diff', 'task/cancel-diff'));
		writeFileSync(join(handle.path, 'diff.txt'), 'committed locally, then cancelled\n');

		// push:false is the path that used to return success here: the diff
		// swallowed the abort and nothing after it re-checked the signal.
		await expect(
			interruptedPlugin.finalize(handle, {
				commitMessage: 'agent: cancelled during diff',
				push: false,
				signal: controller.signal
			})
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(abortedDuringDiff).toBe(true);
		expect(() => git(originDir, 'rev-parse', '--verify', 'refs/heads/task/cancel-diff')).toThrow();
	});
});

/**
 * APW-08 T17 — the cloud path's judge-before-push: `finalize(push: false)`
 * commits, `branchChanges` reads EXACTLY that commit from git, and
 * `finalize({ push: true, publishSha })` publishes exactly the judged commit.
 * The persistent worktree makes the last point sharper here than in the
 * sandbox: processes the run started can keep writing into it.
 */
describe('judge before push (branchChanges + publishSha)', () => {
	const SPEC = '.works/works.yml';

	const seedFiles = (files: Record<string, string>, message: string): string => {
		for (const [file, content] of Object.entries(files)) {
			mkdirSync(join(seedDir, file, '..'), { recursive: true });
			writeFileSync(join(seedDir, file), content);
		}
		git(seedDir, 'add', '-A');
		git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', message);
		git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
		return git(seedDir, 'rev-parse', 'HEAD');
	};

	const write = (dir: string, file: string, content: string): void => {
		mkdirSync(join(dir, file, '..'), { recursive: true });
		writeFileSync(join(dir, file), content);
	};

	const remoteHas = (branch: string): boolean => git(seedDir, 'ls-remote', originUrl, `refs/heads/${branch}`) !== '';

	it('reads the committed paths (both sides of a rename) and the COMMITTED spec, with nothing pushed', async () => {
		seedFiles(
			{ 'bc/rename-me.txt': 'old name\n', 'bc/delete-me.txt': 'doomed\n', [SPEC]: 'spec: base\n' },
			'seed: judge-before-push fixtures'
		);
		const branch = 'task/judge-fresh-1a2b3c4d';
		const handle = await plugin.provision(spec('lw-judge-fresh', branch));

		await fs.rename(join(handle.path, 'bc/rename-me.txt'), join(handle.path, 'bc/renamed.txt'));
		await fs.rm(join(handle.path, 'bc/delete-me.txt'));
		write(handle.path, '.github/workflows/x.yml', 'on: push\n');
		write(handle.path, SPEC, 'spec: committed\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: judged', push: false });
		expect(fin.pushed).toBe(false);
		const head = fin.headSha as string;

		// The tree moves on after the commit: what is judged must be the commit.
		write(handle.path, SPEC, 'spec: tampered on disk\n');

		const changes = await plugin.branchChanges(handle, {
			headSha: head,
			readPaths: [SPEC, 'bc/delete-me.txt']
		});

		expect([...changes.paths].sort()).toEqual(
			['.github/workflows/x.yml', SPEC, 'bc/delete-me.txt', 'bc/rename-me.txt', 'bc/renamed.txt'].sort()
		);
		expect(changes.contents).toEqual({ [SPEC]: 'spec: committed\n', 'bc/delete-me.txt': null });
		expect(remoteHas(branch)).toBe(false);

		// A LATER local commit is not part of what `head` changes.
		write(handle.path, 'bc/later.txt', 'later\n');
		git(handle.path, 'add', '-A');
		git(handle.path, '-c', 'user.name=T', '-c', 'user.email=t@test.local', 'commit', '-m', 'later');
		const again = await plugin.branchChanges(handle, { headSha: head });
		expect(again.paths).not.toContain('bc/later.txt');
		expect(again.contents).toEqual({});
	});

	it('judges a REUSED worktree by its own changes, not a human edit on the base since', async () => {
		const branch = 'task/judge-reuse-5e6f7a8b';
		const first = await plugin.provision(spec('lw-judge-reuse', branch));
		write(first.path, 'bc/own-first.txt', 'first run\n');
		expect((await plugin.finalize(first, { commitMessage: 'agent: first', push: true })).pushed).toBe(true);

		// A person edits a workflow on the base branch in the meantime.
		seedFiles({ '.github/workflows/human.yml': 'on: [push]\n' }, 'seed: human workflow edit');

		const second = await plugin.provision(spec('lw-judge-reuse', branch));
		expect(second.reused).toBe(true);
		expect(second.path).toBe(first.path);
		write(second.path, 'bc/own-second.txt', 'second run\n');
		const fin = await plugin.finalize(second, { commitMessage: 'agent: second', push: false });

		const changes = await plugin.branchChanges(second, { headSha: fin.headSha as string });

		expect(changes.paths).toContain('bc/own-first.txt');
		expect(changes.paths).toContain('bc/own-second.txt');
		// A two-dot diff against the fresh base would name the human's file and
		// refuse the run for a change it never made.
		expect(changes.paths).not.toContain('.github/workflows/human.yml');
	});

	it('publishes EXACTLY the judged commit — never a file the worktree gained after it', async () => {
		const branch = 'task/judge-publish-9c0d1e2f';
		const handle = await plugin.provision(spec('lw-judge-publish', branch));
		write(handle.path, 'bc/judged.txt', 'judged\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: judged', push: false });
		const head = fin.headSha as string;

		// A process the run started keeps writing after the judgement.
		write(handle.path, '.github/workflows/evil.yml', 'on: push\n');

		const published = await plugin.finalize(handle, {
			commitMessage: 'ignored',
			push: true,
			publishSha: head
		});

		expect(published).toMatchObject({ pushed: true, headSha: head, empty: false });
		expect(git(originDir, 'rev-parse', `refs/heads/${branch}`)).toBe(head);
		expect(git(originDir, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`)).not.toContain('evil.yml');
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(head);
		expect(git(handle.path, 'status', '--porcelain')).toContain('.github/');
	});

	it('withholds a publishSha push behind the same fence as any other push', async () => {
		const clock = { ms: Date.parse('2026-09-25T09:00:00.000Z') };
		const fenced = new LocalWorkspacePlugin({ now: () => clock.ms });
		const branch = 'task/judge-fence-2b3c4d5e';
		const handle = await fenced.provision(spec('lw-judge-fence', branch));
		write(handle.path, 'bc/fenced.txt', 'fenced\n');
		const fin = await fenced.finalize(handle, { commitMessage: 'agent: fenced', push: false });

		const published = await fenced.finalize(handle, {
			commitMessage: 'ignored',
			push: true,
			publishSha: fin.headSha as string,
			publishFence: { deadlineAt: clock.ms - 5_000, marginMs: 60_000 }
		});

		expect(published.pushed).toBe(false);
		expect(published.publishWithheld).toMatch(/lease on this work expired/);
		expect(remoteHas(branch)).toBe(false);
	});

	it.each([
		['a symbolic ref', 'HEAD'],
		['a branch name', 'main'],
		['a refspec', ':refs/heads/main'],
		['an abbreviated sha', 'abc1234'],
		['an upper-case sha', 'A'.repeat(40)],
		['a well-formed sha that is not in the repository', 'd'.repeat(40)]
	])('refuses to publish %s, pushing nothing', async (_label, publishSha) => {
		const suffix = Buffer.from(publishSha).toString('hex').slice(0, 8);
		const branch = `task/judge-refuse-${suffix}`;
		const handle = await plugin.provision(spec(`lw-judge-refuse-${suffix}`, branch));
		write(handle.path, 'bc/any.txt', 'any\n');
		await plugin.finalize(handle, { commitMessage: 'agent: any', push: false });

		await expect(plugin.finalize(handle, { commitMessage: 'x', push: true, publishSha })).rejects.toThrow(
			/publishSha/
		);
		expect(remoteHas(branch)).toBe(false);
	});

	it('refuses publishSha without push: true', async () => {
		const handle = await plugin.provision(spec('lw-judge-nopush', 'task/judge-nopush-3a4b5c6d'));
		write(handle.path, 'bc/nopush.txt', 'x\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: x', push: false });

		await expect(
			plugin.finalize(handle, { commitMessage: 'x', push: false, publishSha: fin.headSha as string })
		).rejects.toThrow(/publishSha/);
	});

	/*
	 * The model can write the worktree's git dir — and through it the POOL's
	 * common dir, which every later Task on this repo shares. `git push`
	 * ignores replace refs and grafts and sends the REAL objects, so a judge
	 * that honours them judges something other than what is published. Every
	 * plant below is removed again: the pool outlives this test.
	 */
	const ident = ['-c', 'user.name=T', '-c', 'user.email=t@test.local'];
	const gitIn = (cwd: string, input: string, ...args: string[]): string =>
		execFileSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true }).trim();
	const commonDirOf = (dir: string): string => git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');

	/** A harmless commit on the base: the base's tree plus `decoy.txt`. */
	const decoyCommit = (dir: string, base: string): string => {
		const blob = gitIn(dir, 'decoy\n', 'hash-object', '-w', '--stdin');
		const tree = gitIn(dir, `${git(dir, 'ls-tree', base)}\n100644 blob ${blob}\tdecoy.txt\n`, 'mktree');
		return git(dir, ...ident, 'commit-tree', tree, '-p', base, '-m', 'decoy');
	};

	/** A parentless commit whose whole tree is `head`'s `.github` directory. */
	const orphanCommit = (dir: string, head: string): string => {
		const github = git(dir, 'rev-parse', `${head}:.github`);
		const tree = gitIn(dir, `040000 tree ${github}\t.github\n`, 'mktree');
		return git(dir, ...ident, 'commit-tree', tree, '-m', 'orphan');
	};

	it('judges the REAL commit when a replace ref in the pool swaps a decoy in for it', async () => {
		const branch = 'task/judge-replace-4d5e6f70';
		const handle = await plugin.provision(spec('lw-judge-replace', branch));
		write(handle.path, '.github/workflows/x.yml', 'on: push\n');
		write(handle.path, SPEC, 'spec: real\n');
		const head = (await plugin.finalize(handle, { commitMessage: 'agent: real', push: false })).headSha as string;
		git(handle.path, 'replace', head, decoyCommit(handle.path, handle.baseSha));
		try {
			// Armed: plain git now reads the decoy wherever it reads `head`.
			expect(git(handle.path, 'diff', '--name-only', `${handle.baseSha}...${head}`)).toBe('decoy.txt');

			const changes = await plugin.branchChanges(handle, { headSha: head, readPaths: [SPEC] });

			expect(changes.paths).toContain('.github/workflows/x.yml');
			expect(changes.paths).not.toContain('decoy.txt');
			expect(changes.contents).toEqual({ [SPEC]: 'spec: real\n' });
			// And that is what a publish delivers: the real objects, replace ref or not.
			await plugin.finalize(handle, { commitMessage: 'ignored', push: true, publishSha: head });
			expect(git(originDir, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`)).toContain(
				'.github/workflows/x.yml'
			);
		} finally {
			git(handle.path, 'replace', '-d', head);
		}
	});

	it.each([
		[
			'a replace graft',
			(dir: string, base: string, orphan: string) => {
				git(dir, 'replace', '--graft', base, orphan);
				return () => git(dir, 'replace', '-d', base);
			}
		],
		[
			"an info/grafts line in the pool's common dir",
			(dir: string, base: string, orphan: string) => {
				const grafts = join(commonDirOf(dir), 'info', 'grafts');
				mkdirSync(join(grafts, '..'), { recursive: true });
				writeFileSync(grafts, `${base} ${orphan}\n`);
				return () => rmSync(grafts, { force: true });
			}
		]
	])('never answers an empty change list for an orphan grafted under the base (%s)', async (label, plant) => {
		const handle = await plugin.provision(
			spec(`lw-judge-graft-${label.length}`, `task/judge-graft-${label.length}a1b2c3`)
		);
		write(handle.path, '.github/workflows/x.yml', 'on: push\n');
		const head = (await plugin.finalize(handle, { commitMessage: 'agent: workflow', push: false }))
			.headSha as string;
		const orphan = orphanCommit(handle.path, head);
		// A depth-1 base is parentless, which would hide the graft; the model
		// (or the judge's own `--unshallow` retry) deepens it first.
		if (git(handle.path, 'rev-parse', '--is-shallow-repository') === 'true') {
			git(handle.path, 'fetch', '--unshallow', 'origin');
		}
		const unplant = plant(handle.path, handle.baseSha, orphan);
		try {
			// Armed: plain git calls the orphan an ANCESTOR of the base, so its
			// workflow is "no change" and a gate handed `[]` allows it.
			expect(
				git(
					handle.path,
					'-c',
					'advice.graftFileDeprecated=false',
					'diff',
					'--name-only',
					`${handle.baseSha}...${orphan}`
				)
			).toBe('');

			await expect(plugin.branchChanges(handle, { headSha: orphan })).rejects.toThrow(/could not be read/);
		} finally {
			unplant();
		}
	});

	it.each([
		['a committed .gitmodules entry that says ignore = all', '\tignore = all\n', false],
		["the pool's config diff.ignoreSubmodules = all", '', true]
	])('names a submodule change at a protected path hidden by %s', async (label, ignoreLine, viaConfig) => {
		const handle = await plugin.provision(
			spec(`lw-judge-sub-${label.length}`, `task/judge-submodule-${label.length}d4e5`)
		);
		write(
			handle.path,
			'.gitmodules',
			`[submodule "infra/sub"]\n\tpath = infra/sub\n\turl = https://example.invalid/sub.git\n${ignoreLine}`
		);
		if (viaConfig) git(handle.path, 'config', 'diff.ignoreSubmodules', 'all');
		try {
			git(handle.path, 'update-index', '--add', '--cacheinfo', `160000,${handle.baseSha},infra/sub`);
			git(handle.path, 'add', '.gitmodules');
			git(handle.path, ...ident, 'commit', '-m', 'agent: submodule');
			const head = git(handle.path, 'rev-parse', 'HEAD');
			// Armed: a plain diff lists `.gitmodules` and hides the gitlink.
			expect(git(handle.path, 'diff', '--name-only', `${handle.baseSha}...${head}`).split('\n')).not.toContain(
				'infra/sub'
			);

			const changes = await plugin.branchChanges(handle, { headSha: head });

			expect(changes.paths).toContain('infra/sub');
		} finally {
			if (viaConfig) git(handle.path, 'config', '--unset', 'diff.ignoreSubmodules');
		}
	});

	it.each([
		['a symbolic head', (_head: string) => ({ headSha: 'HEAD' })],
		['a sha that is not in the repository', (_head: string) => ({ headSha: 'e'.repeat(40) })],
		['a parent-relative path', (head: string) => ({ headSha: head, readPaths: ['../outside.txt'] })],
		['an absolute path', (head: string) => ({ headSha: head, readPaths: ['/etc/passwd'] })],
		['a path with a NUL', (head: string) => ({ headSha: head, readPaths: ['a\u0000b'] })]
	])('branchChanges refuses %s', async (_label, opts) => {
		const handle = await plugin.provision(spec('lw-judge-invalid', 'task/judge-invalid-7e8f9a0b'));
		write(handle.path, `bc/invalid-${Date.now()}.txt`, 'x\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: x', push: false });

		await expect(plugin.branchChanges(handle, opts(fin.headSha as string))).rejects.toThrow(/headSha|readPath/);
	});
});

describe('clone URL refusal', () => {
	// This plugin hands `spec.repoUrl` to `git remote add` and `git fetch`, and
	// the PRIMARY workspace URL is not validated upstream — only mounts are. An
	// external reviewer caught that the first version of this guard covered only
	// the sibling `sandbox-workspace` plugin; two identical call sites with one
	// guard between them protect neither.
	it.each([
		['a transport helper whose address ext:: runs as a command', 'ext::sh -c id'],
		['a bare transport-helper prefix', '::whoami'],
		['a value git reads as an option', '--upload-pack=calc.exe'],
		['an ssh option in the scp-like host position', 'git@-oProxyCommand=calc:x'],
		['an ssh option in the URL host position', 'ssh://-oProxyCommand=calc/x.git']
	])('refuses %s', (_label, repoUrl) => {
		expect(() => assertRemoteCloneUrl(repoUrl)).toThrow(/option or a transport helper/);
	});

	it.each([
		['https', 'https://github.com/ever-works/ever-works.git'],
		['ssh://', 'ssh://git@github.com/ever-works/ever-works.git'],
		['scp-like ssh', 'git@github.com:ever-works/ever-works.git'],
		['an IPv6 host', 'https://[::1]/x.git'],
		['the file:// origin this suite uses', 'file:///tmp/origin.git']
	])('accepts %s', (_label, repoUrl) => {
		expect(() => assertRemoteCloneUrl(repoUrl)).not.toThrow();
	});

	it('refuses a hostile URL at provision, before git runs or a directory is made', async () => {
		await expect(
			plugin.provision({ ...spec('lw-hostile', 'task/hostile-aaaa1111'), repoUrl: 'ext::sh -c id' })
		).rejects.toThrow(/option or a transport helper/);
	});
});
