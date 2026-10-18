import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalWorkspacePlugin } from '../local-workspace.plugin.js';

/**
 * works-security finding 3 (fleet node 0.2.7), against real Git: a pool
 * config that names a `post-checkout` hook (via `core.hooksPath`) and a filter
 * driver a tracked `.gitattributes` uses must run NEITHER during a hardened
 * provision's `git worktree add`, nor during a hardened finalize's `add -A`.
 * The unhardened control run proves the plants are live — so a green
 * hardened assertion cannot be a plant that simply never fired.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** Forward slashes: Git hands hook / filter commands to `sh`, on Windows too. */
const shPath = (path: string): string => path.replace(/\\/g, '/');

let root: string;
let originUrl: string;
let baseDir: string;
let markers: string;
let plugin: LocalWorkspacePlugin;

const spec = (bindingKey: string, branch: string, hardenRepoHooks: boolean) => ({
	repoUrl: originUrl,
	baseRef: 'main',
	branch,
	bindingKey,
	settings: { baseDir, fetchDepth: 1 },
	...(hardenRepoHooks ? { hardenRepoHooks: true } : {})
});

const marker = (name: string): string => join(markers, name);
const fired = (name: string): boolean => existsSync(marker(name));

const poolDir = (): string => {
	const repos = join(baseDir, 'repos');
	const entries = readdirSync(repos);
	expect(entries).toHaveLength(1);
	return join(repos, entries[0]!);
};

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'ew-lw-harden-'));
	const originDir = join(root, 'origin.git');
	const seedDir = join(root, 'seed');
	baseDir = join(root, 'workspaces');
	markers = join(root, 'markers');
	mkdirSync(originDir, { recursive: true });
	mkdirSync(seedDir, { recursive: true });
	mkdirSync(markers, { recursive: true });
	git(originDir, 'init', '--bare', '--initial-branch', 'main');
	originUrl = pathToFileURL(originDir).toString();
	git(seedDir, 'init', '--initial-branch', 'main');
	writeFileSync(join(seedDir, '.gitattributes'), 'payload.txt filter=evil\n');
	writeFileSync(join(seedDir, 'payload.txt'), 'raw blob content\n');
	git(seedDir, 'add', '-A');
	git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', 'seed');
	git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
	plugin = new LocalWorkspacePlugin();

	// First (hardened) provision creates the pool; then the pool config is
	// planted the way a previous run with a shell could have planted it.
	await plugin.provision(spec('harden-seed', 'task/harden-seed', true));
	const pool = poolDir();
	const hooks = join(root, 'planted-hooks');
	mkdirSync(hooks, { recursive: true });
	writeFileSync(
		join(hooks, 'post-checkout'),
		`#!/bin/sh\necho ran >> '${shPath(marker('post-checkout'))}'\n`,
		{ mode: 0o755 }
	);
	git(pool, 'config', 'core.hooksPath', shPath(hooks));
	git(pool, 'config', 'filter.evil.smudge', `echo ran >> '${shPath(marker('smudge'))}'; cat`);
	git(pool, 'config', 'filter.evil.clean', `echo ran >> '${shPath(marker('clean'))}'; cat`);
	git(pool, 'config', 'filter.evil.required', 'true');
}, 300_000);

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('hardened provision and finalize (works-security finding 3)', () => {
	it('a hardened worktree add runs no post-checkout hook and no smudge filter; the blob lands verbatim', async () => {
		const handle = await plugin.provision(spec('harden-a', 'task/harden-a', true));
		expect(fired('post-checkout')).toBe(false);
		expect(fired('smudge')).toBe(false);
		expect(readFileSync(join(handle.path, 'payload.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
			'raw blob content\n'
		);

		// A hardened finalize runs no clean filter the pool config defines.
		writeFileSync(join(handle.path, 'payload.txt'), 'changed by the run\n');
		const result = await plugin.finalize(handle, {
			commitMessage: 'test: hardened finalize',
			push: false,
			hardenRepoHooks: true
		});
		expect(result.empty).toBe(false);
		expect(fired('clean')).toBe(false);
		expect(git(handle.path, 'show', 'HEAD:payload.txt').replace(/\r\n/g, '\n')).toBe('changed by the run');
	}, 300_000);

	it('control: the same plants DO run on an unhardened provision (the cloud path is unchanged)', async () => {
		await plugin.provision(spec('harden-b', 'task/harden-b', false));
		expect(fired('post-checkout')).toBe(true);
		expect(fired('smudge')).toBe(true);
	}, 300_000);
});
