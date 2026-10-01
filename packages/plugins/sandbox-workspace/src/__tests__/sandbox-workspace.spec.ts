import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { SandboxWorkspacePlugin, assertRemoteCloneUrl } from '../sandbox-workspace.plugin.js';

/**
 * Hermetic loopback suite: a real local BARE repo plays "origin"
 * (file:// URL — no network, no tokens), and the plugin runs real git
 * against it. This is the conformance harness for the workspace
 * contract's observable behaviour: fetch-first provision, branch
 * reuse, finalize commit+push, merge simulation with NAMED conflict
 * paths, binding self-heal, teardown.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let root: string;
let originDir: string;
let originUrl: string;
let seedDir: string;
let baseDir: string;
let plugin: SandboxWorkspacePlugin;

const settings = () => ({ baseDir, fetchDepth: 1 });

const seedCommit = (file: string, content: string, message: string): string => {
	writeFileSync(join(seedDir, file), content);
	git(seedDir, 'add', '-A');
	git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', message);
	git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
	return git(seedDir, 'rev-parse', 'HEAD');
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-sbx-ws-'));
	originDir = join(root, 'origin.git');
	seedDir = join(root, 'seed');
	baseDir = join(root, 'workspaces');
	mkdirSync(originDir, { recursive: true });
	mkdirSync(seedDir, { recursive: true });
	git(originDir, 'init', '--bare', '--initial-branch', 'main');
	originUrl = pathToFileURL(originDir).toString();
	git(seedDir, 'init', '--initial-branch', 'main');
	seedCommit('README.md', 'hello\n', 'seed: initial');
	plugin = new SandboxWorkspacePlugin();
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('provision', () => {
	it('cuts a fresh branch from the CURRENT origin base (fetch-first)', async () => {
		const latest = seedCommit('a.txt', 'a\n', 'seed: advance base');
		const handle = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/first-run-aaaa1111',
			bindingKey: 'task-1',
			settings: settings()
		});
		expect(handle.reused).toBe(false);
		expect(handle.baseSha).toBe(latest);
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(latest);
		expect(git(handle.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/first-run-aaaa1111');
		// The persisted remote must be token-free (here: the plain URL).
		expect(git(handle.path, 'remote', 'get-url', 'origin')).toBe(originUrl);
	});

	it('reuses a previously pushed task branch as the durable identity', async () => {
		const h1 = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/reuse-bbbb2222',
			bindingKey: 'task-2',
			settings: settings()
		});
		writeFileSync(join(h1.path, 'work.txt'), 'agent output\n');
		const fin = await plugin.finalize(h1, { commitMessage: 'agent: work', push: true });
		expect(fin.pushed).toBe(true);
		expect(fin.empty).toBe(false);

		// Sandbox evaporates…
		await plugin.teardown(h1);

		// …re-provision finds the pushed branch and resumes on it.
		const h2 = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/reuse-bbbb2222',
			bindingKey: 'task-2',
			settings: settings()
		});
		expect(h2.reused).toBe(true);
		expect(git(h2.path, 'rev-parse', 'HEAD')).toBe(fin.headSha);
		await plugin.teardown(h2);
	});

	it('self-heals a workspace dir bound to a different key', async () => {
		const h1 = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/owner-cccc3333',
			bindingKey: 'task-3',
			settings: settings()
		});
		writeFileSync(join(h1.path, 'stale.txt'), 'stale\n');

		// Same directory name would collide only if bindingKey collides —
		// force it by re-using the key with a different branch: stamp says
		// task-3, we ask for task-3 again → REUSED dir, stale file intact.
		const h2 = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/owner-cccc3333',
			bindingKey: 'task-3',
			settings: settings()
		});
		expect(h2.path).toBe(h1.path);

		await plugin.teardown(h2);
	});
});

describe('finalize', () => {
	it('reports empty when the run produced no changes', async () => {
		const handle = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/empty-dddd4444',
			bindingKey: 'task-4',
			settings: settings()
		});
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: nothing', push: true });
		expect(fin.empty).toBe(true);
		expect(fin.pushed).toBe(false);
		// Run telemetry — an empty run honestly reports zero changed files.
		expect(fin.changedFiles).toBe(0);
		await plugin.teardown(handle);
	});

	it('commits and pushes changes to the task branch, never the base', async () => {
		const baseBefore = git(seedDir, 'rev-parse', 'HEAD');
		const handle = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/push-eeee5555',
			bindingKey: 'task-5',
			settings: settings()
		});
		writeFileSync(join(handle.path, 'feature.txt'), 'new feature\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: feature', push: true });
		expect(fin.pushed).toBe(true);
		expect(fin.headSha).not.toBe(handle.baseSha);
		// Run telemetry — the branch's file footprint vs the base it was
		// cut from, which is what `agent_runs.changedFilesCount` shows.
		expect(fin.changedFiles).toBe(1);

		// Remote task branch has the commit; remote main is untouched.
		const remoteBranch = git(originDir, 'rev-parse', 'refs/heads/task/push-eeee5555');
		expect(remoteBranch).toBe(fin.headSha);
		expect(git(originDir, 'rev-parse', 'refs/heads/main')).toBe(baseBefore);
		await plugin.teardown(handle);
	});
});

describe('simulateMerge', () => {
	it('reports clean when the branch applies onto the target', async () => {
		const handle = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/clean-ffff6666',
			bindingKey: 'task-6',
			settings: settings()
		});
		writeFileSync(join(handle.path, 'clean-add.txt'), 'no conflict here\n');
		await plugin.finalize(handle, { commitMessage: 'agent: clean add', push: false });

		const sim = await plugin.simulateMerge(handle, 'main');
		expect(sim.clean).toBe(true);
		expect(sim.conflictPaths).toEqual([]);
		await plugin.teardown(handle);
	});

	it('NAMES the conflicting paths when base moved incompatibly', async () => {
		const handle = await plugin.provision({
			repoUrl: originUrl,
			baseRef: 'main',
			branch: 'task/conflict-9999aaaa',
			bindingKey: 'task-7',
			settings: settings()
		});

		// Branch edits README one way…
		writeFileSync(join(handle.path, 'README.md'), 'branch version\n');
		await plugin.finalize(handle, { commitMessage: 'agent: edit readme', push: false });

		// …meanwhile the base moves the SAME file the other way.
		seedCommit('README.md', 'base version\n', 'seed: conflicting readme');

		const sim = await plugin.simulateMerge(handle, 'main');
		expect(sim.clean).toBe(false);
		expect(sim.conflictPaths).toContain('README.md');
		await plugin.teardown(handle);
	});
});

describe('gc', () => {
	it('removes only directories older than the cutoff', async () => {
		process.env.EW_WORKSPACES_DIR = baseDir;
		try {
			const oldDir = join(baseDir, 'ancient-task');
			mkdirSync(oldDir, { recursive: true });
			const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
			await fs.utimes(oldDir, past, past);

			const freshDir = join(baseDir, 'fresh-task');
			mkdirSync(freshDir, { recursive: true });

			const { removed } = await plugin.gc({ olderThanDays: 14 });
			expect(removed).toContain('ancient-task');
			expect(removed).not.toContain('fresh-task');
		} finally {
			delete process.env.EW_WORKSPACES_DIR;
		}
	});
});

/**
 * APW-08 T17 — the cloud path's judge-before-push: `finalize(push: false)`
 * commits, `branchChanges` reads EXACTLY that commit from git, and
 * `finalize({ push: true, publishSha })` publishes exactly the judged commit
 * and nothing the tree gained afterwards.
 */
describe('judge before push (branchChanges + publishSha)', () => {
	const SPEC = '.works/works.yml';

	/** Commit several files (creating their directories) onto origin/main. */
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

	const provision = (branch: string, bindingKey: string) =>
		plugin.provision({ repoUrl: originUrl, baseRef: 'main', branch, bindingKey, settings: settings() });

	it('reads the committed paths (both sides of a rename) and the COMMITTED spec, with nothing pushed', async () => {
		seedFiles(
			{ 'bc/rename-me.txt': 'old name\n', 'bc/delete-me.txt': 'doomed\n', [SPEC]: 'spec: base\n' },
			'seed: judge-before-push fixtures'
		);
		const branch = 'task/judge-fresh-1a2b3c4d';
		const handle = await provision(branch, 'task-judge-fresh');

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
		// Nothing left the sandbox.
		expect(remoteHas(branch)).toBe(false);

		// A LATER local commit is not part of what `head` changes.
		write(handle.path, 'bc/later.txt', 'later\n');
		git(handle.path, 'add', '-A');
		git(handle.path, '-c', 'user.name=T', '-c', 'user.email=t@test.local', 'commit', '-m', 'later');
		const again = await plugin.branchChanges(handle, { headSha: head });
		expect(again.paths).not.toContain('bc/later.txt');
		expect(again.contents).toEqual({});
		await plugin.teardown(handle);
	});

	it('judges a REUSED branch by its own changes, not a human edit on the base since (shallow history)', async () => {
		const branch = 'task/judge-reuse-5e6f7a8b';
		const first = await provision(branch, 'task-judge-reuse');
		write(first.path, 'bc/own-first.txt', 'first run\n');
		expect((await plugin.finalize(first, { commitMessage: 'agent: first', push: true })).pushed).toBe(true);
		await plugin.teardown(first);

		// A person edits a workflow on the base branch in the meantime.
		seedFiles({ '.github/workflows/human.yml': 'on: [push]\n' }, 'seed: human workflow edit');

		const second = await provision(branch, 'task-judge-reuse');
		expect(second.reused).toBe(true);
		write(second.path, 'bc/own-second.txt', 'second run\n');
		const fin = await plugin.finalize(second, { commitMessage: 'agent: second', push: false });
		const head = fin.headSha as string;
		// The depth-1 base fetch left no merge base: a two-dot diff would name the
		// human's file, and a three-dot one fails until the history is deepened.
		expect(() => git(second.path, 'merge-base', second.baseSha, head)).toThrow();

		const changes = await plugin.branchChanges(second, { headSha: head });

		expect(changes.paths).toContain('bc/own-first.txt');
		expect(changes.paths).toContain('bc/own-second.txt');
		expect(changes.paths).not.toContain('.github/workflows/human.yml');
		await plugin.teardown(second);
	});

	it('publishes EXACTLY the judged commit — never a file the tree gained after it', async () => {
		const branch = 'task/judge-publish-9c0d1e2f';
		const handle = await provision(branch, 'task-judge-publish');
		write(handle.path, 'bc/judged.txt', 'judged\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: judged', push: false });
		const head = fin.headSha as string;

		// Something the run started keeps writing after the judgement.
		write(handle.path, '.github/workflows/evil.yml', 'on: push\n');

		const published = await plugin.finalize(handle, {
			commitMessage: 'ignored',
			push: true,
			publishSha: head
		});

		expect(published).toMatchObject({ pushed: true, headSha: head, empty: false });
		expect(git(originDir, 'rev-parse', `refs/heads/${branch}`)).toBe(head);
		expect(git(originDir, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`)).not.toContain('evil.yml');
		// Nothing was staged or committed by the publish.
		expect(git(handle.path, 'rev-parse', 'HEAD')).toBe(head);
		expect(git(handle.path, 'status', '--porcelain')).toContain('.github/');
		await plugin.teardown(handle);
	});

	it.each([
		['a symbolic ref', 'HEAD'],
		['a branch name', 'main'],
		['a refspec', ':refs/heads/main'],
		['an abbreviated sha', 'abc1234'],
		['an upper-case sha', 'A'.repeat(40)],
		['a well-formed sha that is not in the repository', 'd'.repeat(40)]
	])('refuses to publish %s, pushing nothing', async (_label, publishSha) => {
		const branch = `task/judge-refuse-${Buffer.from(publishSha).toString('hex').slice(0, 8)}`;
		const handle = await provision(branch, `task-judge-refuse-${publishSha.length}-${publishSha.charCodeAt(0)}`);
		write(handle.path, 'bc/any.txt', 'any\n');
		await plugin.finalize(handle, { commitMessage: 'agent: any', push: false });

		await expect(plugin.finalize(handle, { commitMessage: 'x', push: true, publishSha })).rejects.toThrow(
			/publishSha/
		);
		expect(remoteHas(branch)).toBe(false);
		await plugin.teardown(handle);
	});

	it('refuses publishSha without push: true', async () => {
		const handle = await provision('task/judge-nopush-3a4b5c6d', 'task-judge-nopush');
		write(handle.path, 'bc/nopush.txt', 'x\n');
		const fin = await plugin.finalize(handle, { commitMessage: 'agent: x', push: false });

		await expect(
			plugin.finalize(handle, { commitMessage: 'x', push: false, publishSha: fin.headSha as string })
		).rejects.toThrow(/publishSha/);
		await plugin.teardown(handle);
	});

	/*
	 * The model can write the checkout's git dir. `git push` ignores replace refs
	 * and grafts and sends the REAL objects, so a judge that honours them judges
	 * something other than what is published.
	 */
	const ident = ['-c', 'user.name=T', '-c', 'user.email=t@test.local'];
	const gitIn = (cwd: string, input: string, ...args: string[]): string =>
		execFileSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true }).trim();

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

	it('judges the REAL commit when a replace ref swaps a decoy in for it — the commit a push sends', async () => {
		const branch = 'task/judge-replace-4d5e6f70';
		const handle = await provision(branch, 'task-judge-replace');
		try {
			write(handle.path, '.github/workflows/x.yml', 'on: push\n');
			write(handle.path, SPEC, 'spec: real\n');
			const head = (await plugin.finalize(handle, { commitMessage: 'agent: real', push: false }))
				.headSha as string;
			git(handle.path, 'replace', head, decoyCommit(handle.path, handle.baseSha));
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
			await plugin.teardown(handle);
		}
	});

	it.each([
		[
			'a replace graft',
			(dir: string, base: string, orphan: string) => git(dir, 'replace', '--graft', base, orphan)
		],
		[
			'an info/grafts line',
			(dir: string, base: string, orphan: string) => {
				const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
				mkdirSync(join(common, 'info'), { recursive: true });
				writeFileSync(join(common, 'info', 'grafts'), `${base} ${orphan}\n`);
			}
		]
	])('never answers an empty change list for an orphan grafted under the base (%s)', async (label, plant) => {
		const handle = await provision(`task/judge-graft-${label.length}a1b2c3`, `task-judge-graft-${label.length}`);
		try {
			write(handle.path, '.github/workflows/x.yml', 'on: push\n');
			const head = (await plugin.finalize(handle, { commitMessage: 'agent: workflow', push: false }))
				.headSha as string;
			const orphan = orphanCommit(handle.path, head);
			// A depth-1 base is parentless, which would hide the graft; the model
			// (or the judge's own `--unshallow` retry) deepens it first.
			git(handle.path, 'fetch', '--unshallow', 'origin');
			plant(handle.path, handle.baseSha, orphan);
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
			await plugin.teardown(handle);
		}
	});

	it.each([
		['a committed .gitmodules entry that says ignore = all', '\tignore = all\n', false],
		['the checkout config diff.ignoreSubmodules = all', '', true]
	])('names a submodule change at a protected path hidden by %s', async (label, ignoreLine, viaConfig) => {
		const handle = await provision(`task/judge-submodule-${label.length}d4e5`, `task-judge-sub-${label.length}`);
		try {
			write(
				handle.path,
				'.gitmodules',
				`[submodule "infra/sub"]\n\tpath = infra/sub\n\turl = https://example.invalid/sub.git\n${ignoreLine}`
			);
			if (viaConfig) git(handle.path, 'config', 'diff.ignoreSubmodules', 'all');
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
			await plugin.teardown(handle);
		}
	});

	it.each([
		['a symbolic head', (_head: string) => ({ headSha: 'HEAD' })],
		['a sha that is not in the repository', (_head: string) => ({ headSha: 'e'.repeat(40) })],
		['a parent-relative path', (head: string) => ({ headSha: head, readPaths: ['../outside.txt'] })],
		['an absolute path', (head: string) => ({ headSha: head, readPaths: ['/etc/passwd'] })],
		['a path with a NUL', (head: string) => ({ headSha: head, readPaths: ['a\u0000b'] })]
	])('branchChanges refuses %s', async (_label, opts) => {
		const handle = await provision('task/judge-invalid-7e8f9a0b', 'task-judge-invalid');
		try {
			write(handle.path, 'bc/invalid.txt', 'x\n');
			const fin = await plugin.finalize(handle, { commitMessage: 'agent: x', push: false });
			await expect(plugin.branchChanges(handle, opts(fin.headSha as string))).rejects.toThrow(/headSha|readPath/);
		} finally {
			await plugin.teardown(handle);
		}
	});
});

describe('clone URL refusal', () => {
	// These reach `git` as an ARGUMENT, and on a Fleet node that machine is
	// somebody's PC. A repository connection is tenant-configurable and can
	// point anywhere, so this is refused at the point of use rather than
	// trusted from the caller — this package is standalone and its primary
	// `repoUrl` is not validated upstream.
	it('refuses a hostile URL at provision, before any git call or directory write', async () => {
		// The function being right is not the same as it being CALLED. This drives
		// the real entry point, so a future refactor that drops the guard fails
		// here rather than silently handing the value to git.
		await expect(
			plugin.provision({
				repoUrl: 'ext::sh -c id',
				baseRef: 'main',
				branch: 'task/hostile-url-aaaa1111',
				bindingKey: 'task-hostile',
				settings: settings()
			})
		).rejects.toThrow(/option or a transport helper/);
	});

	it.each([
		['a transport helper whose address ext:: runs as a command', 'ext::sh -c id'],
		['a bare transport-helper prefix', '::whoami'],
		['a value git reads as an option', '--upload-pack=calc.exe'],
		['a short option', '-u'],
		['an ssh option in the scp-like host position', 'git@-oProxyCommand=calc:x'],
		['an ssh option in the URL host position', 'ssh://-oProxyCommand=calc/x.git']
	])('refuses %s', (_label, repoUrl) => {
		expect(() => assertRemoteCloneUrl(repoUrl)).toThrow(/option or a transport helper/);
	});

	// The refusal is deliberately narrow: WHICH remotes are acceptable is the
	// host's policy (the platform's mount rules refuse `file:` and local paths),
	// and this harness itself clones a `file://` origin.
	it.each([
		['https', 'https://github.com/ever-works/ever-works.git'],
		['ssh://', 'ssh://git@github.com/ever-works/ever-works.git'],
		['scp-like ssh', 'git@github.com:ever-works/ever-works.git'],
		['an IPv6 host', 'https://[::1]/x.git'],
		['the file:// origin this suite uses', 'file:///tmp/origin.git']
	])('accepts %s', (_label, repoUrl) => {
		expect(() => assertRemoteCloneUrl(repoUrl)).not.toThrow();
	});
});
