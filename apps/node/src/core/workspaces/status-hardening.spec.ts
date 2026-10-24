import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARDENED_DIRTY_STATUS_ARGS, statusHardeningEnv } from './status-hardening';

/**
 * works-security (node 0.2.7, control 21 follow-up): the housekeeping dirty
 * check (inventory scan + reaper re-check) runs no filter driver, no
 * fsmonitor and no child status inside a populated submodule. Real Git:
 * each plant writes a marker file when it runs, and a control run without
 * the hardening proves the plant is live.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const shPath = (path: string): string => path.replace(/\\/g, '/');
const commit = (cwd: string, message: string): void => {
	git(cwd, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '--quiet', '-m', message);
};

let root: string;
let repo: string;
let markers: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-node-status-harden-'));
	markers = join(root, 'markers');
	mkdirSync(markers);
	repo = join(root, 'repo');
	mkdirSync(repo);
	git(repo, 'init', '--quiet', '--initial-branch', 'main');
	writeFileSync(join(repo, '.gitattributes'), 'payload.txt filter=evil\n');
	writeFileSync(join(repo, 'payload.txt'), 'raw blob content\n');
	git(repo, 'add', '-A');
	commit(repo, 'seed');
	// A populated submodule the run made: its own repository, whose config
	// names a filter driver the parent's overlay cannot see.
	const sub = join(repo, 'sub');
	mkdirSync(sub);
	git(sub, 'init', '--quiet', '--initial-branch', 'main');
	writeFileSync(join(sub, '.gitattributes'), 'inner.txt filter=inner\n');
	writeFileSync(join(sub, 'inner.txt'), 'inner\n');
	git(sub, 'add', '-A');
	commit(sub, 'inner seed');
	git(sub, 'config', 'filter.inner.clean', `echo ran >> '${shPath(join(markers, 'inner-clean'))}'; cat`);
	git(repo, 'add', 'sub');
	commit(repo, 'gitlink');
	// The parent's planted driver (the shared pool config's scope).
	git(repo, 'config', 'filter.evil.clean', `echo ran >> '${shPath(join(markers, 'clean'))}'; cat`);
	git(repo, 'config', 'filter.evil.required', 'true');
}, 300_000);

afterAll(() => {
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function statusWith(env: Record<string, string> | null, args: readonly string[]): string {
	return execFileSync('git', [...args], {
		cwd: repo,
		encoding: 'utf8',
		windowsHide: true,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env ?? {}) }
	});
}

describe('statusHardeningEnv + HARDENED_DIRTY_STATUS_ARGS', () => {
	it('reports a modified file without running the planted filter or entering the submodule', async () => {
		// Stat data that no longer matches the index is what makes Git run
		// `clean` to hash the file.
		writeFileSync(join(repo, 'payload.txt'), 'edited by a model\n');
		writeFileSync(join(repo, 'sub', 'inner.txt'), 'inner, edited\n');
		const env = await statusHardeningEnv(repo);
		const out = statusWith(env, HARDENED_DIRTY_STATUS_ARGS);
		expect(out).toContain('payload.txt');
		expect(existsSync(join(markers, 'clean'))).toBe(false);
		expect(existsSync(join(markers, 'inner-clean'))).toBe(false);
	}, 300_000);

	it('still counts the tree dirty when only a file the filter would hash changed (never reads as clean)', async () => {
		const env = await statusHardeningEnv(repo);
		expect(statusWith(env, HARDENED_DIRTY_STATUS_ARGS).trim().length).toBeGreaterThan(0);
	}, 300_000);

	it('control: a plain status runs both planted drivers', () => {
		writeFileSync(join(repo, 'payload.txt'), 'edited again\n');
		writeFileSync(join(repo, 'sub', 'inner.txt'), 'inner, edited again\n');
		statusWith(null, ['status', '--porcelain', '--untracked-files=all']);
		expect(existsSync(join(markers, 'clean'))).toBe(true);
		expect(existsSync(join(markers, 'inner-clean'))).toBe(true);
	}, 300_000);
});
