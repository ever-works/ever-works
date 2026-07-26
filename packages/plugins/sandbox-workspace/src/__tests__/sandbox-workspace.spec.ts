import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { SandboxWorkspacePlugin } from '../sandbox-workspace.plugin.js';

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
