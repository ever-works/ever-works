import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import git from 'isomorphic-git';
import { GitOperations } from '../git-operations.js';

/**
 * APW-02 T48 (FR-63, ACC-02-27) — the seven optional `IGitOperations` members a private copy's
 * upstream sync is built from.
 *
 * The local half (`resolveRef`, `hasCommit`, `findMergeBase`, `countCommitsBetween`,
 * `writeBranchRef`, `removeWorkingCopy`) runs against a REAL repository written to a temp
 * directory, so the counts are isomorphic-git's own reading of real commits. `fetchBranch` is
 * the one network call: it is observed through a spy on `git.fetch`, which is where the
 * credential rule lives — the URL is the provider's, the remote is named, the CORS proxy is empty.
 */

const AUTHOR = { name: 'Test', email: 'test@example.com' };

let baseDir: string;
let repoDir: string;

function makeOps(): GitOperations {
	return new GitOperations(
		() => ({ username: 'x-access-token', password: 'token' }),
		(owner, repo) => `https://github.example/${owner}/${repo}.git`,
		{ baseDir }
	);
}

let clock = 1_700_000_000;
async function commit(message: string, parents?: string[]): Promise<string> {
	clock += 60;
	const file = path.join(repoDir, 'file.txt');
	await fs.promises.writeFile(file, `${message}\n`);
	await git.add({ fs, dir: repoDir, filepath: 'file.txt' });
	return git.commit({
		fs,
		dir: repoDir,
		message,
		author: { ...AUTHOR, timestamp: clock, timezoneOffset: 0 },
		committer: { ...AUTHOR, timestamp: clock, timezoneOffset: 0 },
		...(parents ? { parent: parents } : {})
	});
}

beforeEach(async () => {
	baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ew-copy-sync-'));
	repoDir = path.join(baseDir, 'work');
	await fs.promises.mkdir(repoDir, { recursive: true });
	await git.init({ fs, dir: repoDir, defaultBranch: 'main' });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.promises.rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('GitOperations — private copy sync helpers (APW-02 T48)', () => {
	it('counts both sides of a divergence from the merge base and names the base', async () => {
		const ops = makeOps();
		await commit('b1');
		const base = await commit('b2');
		// upstream: three commits on top of the base
		const u1 = await commit('u1', [base]);
		const u2 = await commit('u2', [u1]);
		const upstreamHead = await commit('u3', [u2]);
		// the copy: one commit of its own on top of the base
		const copyHead = await commit('m1', [base]);

		await expect(ops.findMergeBase(repoDir, [copyHead, upstreamHead])).resolves.toBe(base);
		await expect(
			ops.countCommitsBetween(repoDir, { include: upstreamHead, exclude: copyHead, max: 10_000 })
		).resolves.toEqual({ count: 3, capped: false });
		await expect(
			ops.countCommitsBetween(repoDir, { include: copyHead, exclude: upstreamHead, max: 10_000 })
		).resolves.toEqual({ count: 1, capped: false });
		await expect(
			ops.countCommitsBetween(repoDir, { include: upstreamHead, exclude: copyHead, max: 2 })
		).resolves.toEqual({ count: 2, capped: true });
	});

	it('writes a LOCAL branch at an exact commit and resolves it back', async () => {
		const ops = makeOps();
		const first = await commit('one');
		await commit('two');

		await ops.writeBranchRef(repoDir, 'ever-works-sync-push', first);
		await expect(ops.resolveRef(repoDir, 'refs/heads/ever-works-sync-push')).resolves.toBe(first);
		await expect(ops.resolveRef(repoDir, 'refs/heads/does-not-exist')).resolves.toBeNull();
		await expect(ops.writeBranchRef(repoDir, 'refs/heads/main', first)).rejects.toThrow(/Refusing/);
		await expect(ops.writeBranchRef(repoDir, 'a..b', first)).rejects.toThrow(/Refusing/);
	});

	it('tells a present commit from an absent one', async () => {
		const ops = makeOps();
		const sha = await commit('one');
		await expect(ops.hasCommit(repoDir, sha)).resolves.toBe(true);
		await expect(ops.hasCommit(repoDir, 'f'.repeat(40))).resolves.toBe(false);
		await expect(ops.hasCommit(repoDir, 'not-a-sha')).resolves.toBe(false);
	});

	it('removes a working copy under its base directory, and refuses anything else', async () => {
		const ops = makeOps();
		await ops.removeWorkingCopy(repoDir);
		expect(fs.existsSync(repoDir)).toBe(false);
		await expect(ops.removeWorkingCopy(baseDir)).rejects.toThrow(/outside/);
		await expect(ops.removeWorkingCopy(os.tmpdir())).rejects.toThrow(/outside/);
		expect(fs.existsSync(baseDir)).toBe(true);
	});

	it('fetches one branch from the provider URL, with a named remote and no CORS proxy', async () => {
		const ops = makeOps();
		const fetchSpy = vi
			.spyOn(git, 'fetch')
			.mockResolvedValue({ fetchHead: 'a'.repeat(40) } as Awaited<ReturnType<typeof git.fetch>>);

		await expect(
			ops.fetchBranch({ dir: repoDir, owner: 'up', repo: 'app', branch: 'trunk', token: 't' })
		).resolves.toBe('a'.repeat(40));

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const args = fetchSpy.mock.calls[0][0] as Record<string, unknown>;
		expect(args.url).toBe('https://github.example/up/app.git');
		expect(args.remote).toBe('upstream');
		expect(args.ref).toBe('trunk');
		expect(args.remoteRef).toBe('trunk');
		expect(args.singleBranch).toBe(true);
		expect(args.tags).toBe(false);
		expect(args.corsProxy).toBe('');
	});

	it('answers null for a branch the repository does not have, and rethrows anything else', async () => {
		const ops = makeOps();
		vi.spyOn(git, 'fetch').mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'NotFoundError' }));
		await expect(
			ops.fetchBranch({ dir: repoDir, owner: 'up', repo: 'app', branch: 'gone', token: 't' })
		).resolves.toBeNull();

		vi.spyOn(git, 'fetch').mockRejectedValueOnce(new Error('HTTP Error: 500'));
		await expect(
			ops.fetchBranch({ dir: repoDir, owner: 'up', repo: 'app', branch: 'trunk', token: 't' })
		).rejects.toThrow('500');

		await expect(
			ops.fetchBranch({ dir: repoDir, owner: 'up', repo: 'app', branch: 'trunk', token: '' })
		).rejects.toThrow(/token/);
	});
});
