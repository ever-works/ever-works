import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalWorkspacePlugin } from '@ever-works/local-workspace-plugin';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	assertLinkedWorktreePointer,
	FleetTaskWorkspaceError,
	FleetTaskWorkspaceProvisioner,
	resetReadOnlyMount
} from './fleet-task-workspace';

/**
 * works-security finding 3 (fleet node 0.2.7) — the node's OWN git commands
 * over an attacker-authored checkout:
 *
 *  - a reused read-only mount's `reset --hard` / `clean` runs no filter driver
 *    and no fsmonitor a planted pool config names (the provider's provision
 *    and finalize get the same treatment; see the local-workspace plugin's
 *    `local-workspace.hardening.spec.ts`);
 *  - a worktree whose `.git` was rewritten to point at a directory the model
 *    wrote is refused before ANY git command runs in it.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const shPath = (path: string): string => path.replace(/\\/g, '/');

let root: string;
let pool: string;
let worktree: string;
let markers: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-node-harden-'));
	markers = join(root, 'markers');
	mkdirSync(markers);
	const origin = join(root, 'origin.git');
	const seed = join(root, 'seed');
	mkdirSync(origin);
	mkdirSync(seed);
	git(origin, 'init', '--bare', '--initial-branch', 'main');
	git(seed, 'init', '--initial-branch', 'main');
	writeFileSync(join(seed, '.gitattributes'), 'payload.txt filter=evil\n');
	writeFileSync(join(seed, 'payload.txt'), 'raw blob content\n');
	git(seed, 'add', '-A');
	git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', 'seed');
	git(seed, 'push', pathToFileURL(origin).toString(), 'HEAD:refs/heads/main');
	// The provider's layout: <repositoryRoot>/repos/<pool> + <repositoryRoot>/worktrees/<binding>.
	const repositoryRoot = join(root, 'repositories', 'r1');
	pool = join(repositoryRoot, 'repos', 'pool');
	worktree = join(repositoryRoot, 'worktrees', 'binding');
	mkdirSync(join(repositoryRoot, 'worktrees'), { recursive: true });
	git(root, 'clone', '--bare', '--quiet', pathToFileURL(origin).toString(), pool);
	git(pool, 'worktree', 'add', '--quiet', worktree, 'main');
	// Planted the way an earlier run with a shell could have planted it.
	git(pool, 'config', 'filter.evil.smudge', `echo ran >> '${shPath(join(markers, 'smudge'))}'; cat`);
	git(pool, 'config', 'filter.evil.clean', `echo ran >> '${shPath(join(markers, 'clean'))}'; cat`);
	git(pool, 'config', 'filter.evil.required', 'true');
}, 300_000);

afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('resetReadOnlyMount — hardened checkout', () => {
	it('restores the base content without running a planted filter driver', async () => {
		writeFileSync(join(worktree, 'payload.txt'), 'left behind by a model\n');
		writeFileSync(join(worktree, 'untracked.txt'), 'scratch\n');
		await resetReadOnlyMount(worktree);
		expect(readFileSync(join(worktree, 'payload.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('raw blob content\n');
		expect(existsSync(join(worktree, 'untracked.txt'))).toBe(false);
		expect(existsSync(join(markers, 'smudge'))).toBe(false);
		expect(existsSync(join(markers, 'clean'))).toBe(false);
	}, 300_000);

	it('control: the same reset WITHOUT the hardening runs the planted driver', () => {
		writeFileSync(join(worktree, 'payload.txt'), 'left behind again\n');
		git(worktree, 'reset', '--hard', '--quiet', 'HEAD');
		expect(existsSync(join(markers, 'smudge'))).toBe(true);
	}, 300_000);
});

describe('assertLinkedWorktreePointer', () => {
	function layout(name: string) {
		const repositoryRoot = join(root, 'pointer', name);
		const gitDir = join(repositoryRoot, 'repos', 'p', 'worktrees', 'id');
		const wt = join(repositoryRoot, 'worktrees', 'b');
		mkdirSync(gitDir, { recursive: true });
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, '.git'), `gitdir: ${shPath(gitDir)}\n`);
		writeFileSync(join(gitDir, 'gitdir'), `${shPath(join(wt, '.git'))}\n`);
		return { repositoryRoot, gitDir, wt };
	}

	it('accepts the provider layout, absolute or relative', async () => {
		const { wt } = layout('ok');
		await expect(assertLinkedWorktreePointer(wt)).resolves.toBeUndefined();
		writeFileSync(join(wt, '.git'), 'gitdir: ../../repos/p/worktrees/id\n');
		await expect(assertLinkedWorktreePointer(wt)).resolves.toBeUndefined();
	});

	it('refuses a `.git` redirected to a directory inside the checkout', async () => {
		const { wt } = layout('redirect');
		const evil = join(wt, 'evil-gitdir');
		mkdirSync(evil);
		writeFileSync(join(evil, 'gitdir'), `${shPath(join(wt, '.git'))}\n`);
		writeFileSync(join(wt, '.git'), `gitdir: ${shPath(evil)}\n`);
		await expect(assertLinkedWorktreePointer(wt)).rejects.toThrowError(/outside its own repository pool/);
	});

	it('refuses another worktree’s gitdir, a `.git` directory and a multi-line pointer', async () => {
		const other = layout('other');
		const { wt } = layout('victim');
		writeFileSync(join(wt, '.git'), `gitdir: ${shPath(other.gitDir)}\n`);
		await expect(assertLinkedWorktreePointer(wt)).rejects.toThrowError(/outside its own repository pool/);

		const sibling = layout('sibling');
		const second = join(sibling.repositoryRoot, 'repos', 'p', 'worktrees', 'id2');
		mkdirSync(second, { recursive: true });
		writeFileSync(join(second, 'gitdir'), `${shPath(join(sibling.repositoryRoot, 'worktrees', 'zz', '.git'))}\n`);
		mkdirSync(join(sibling.repositoryRoot, 'worktrees', 'zz'), { recursive: true });
		writeFileSync(join(sibling.repositoryRoot, 'worktrees', 'zz', '.git'), 'gitdir: x\n');
		writeFileSync(join(sibling.wt, '.git'), `gitdir: ${shPath(second)}\n`);
		await expect(assertLinkedWorktreePointer(sibling.wt)).rejects.toThrowError(/belongs to another worktree/);

		const dir = layout('dir');
		rmSync(join(dir.wt, '.git'));
		mkdirSync(join(dir.wt, '.git'));
		await expect(assertLinkedWorktreePointer(dir.wt)).rejects.toThrowError(/not a plain file/);

		const multi = layout('multi');
		writeFileSync(join(multi.wt, '.git'), `gitdir: ${shPath(multi.gitDir)}\n[core]\n\tfsmonitor = evil\n`);
		await expect(assertLinkedWorktreePointer(multi.wt)).rejects.toThrowError(/single gitdir line/);
	});

	it('finalize refuses a redirected worktree before the provider runs a single git command', async () => {
		const { wt } = layout('finalize');
		const evil = join(wt, 'evil-gitdir');
		mkdirSync(evil);
		writeFileSync(join(wt, '.git'), `gitdir: ${shPath(evil)}\n`);
		const plugin = new LocalWorkspacePlugin();
		const finalize = vi.spyOn(plugin, 'finalize');
		const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: join(root, 'pointer'), plugin });
		const failure = await provisioner
			.finalize(
				'task-0001',
				{
					path: wt,
					repositoryId: 'ever/repository',
					baseRef: 'main',
					branch: 'task/pointer',
					baseSha: 'a'.repeat(40),
					headSha: 'a'.repeat(40),
					reused: true
				},
				{ commitMessage: 'feat: x', push: false }
			)
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(FleetTaskWorkspaceError);
		expect((failure as FleetTaskWorkspaceError).code).toBe('path-collision');
		expect(finalize).not.toHaveBeenCalled();
	});
});
