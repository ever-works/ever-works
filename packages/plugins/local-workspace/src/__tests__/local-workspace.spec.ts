import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
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
