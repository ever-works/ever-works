import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * APW-02 P0 (Wave 0 PR 0.2) — a repository that is expected to exist must never become an empty
 * local one.
 *
 * `cloneOrPull` used to swallow a missing/empty remote (`NotFoundError` / "Could not find" /
 * "empty") and fall back to `git init` + `addRemote`. That is correct for "initialise a brand-new
 * repository we are about to populate", and silently wrong for "read a repository that must be
 * there": a typo'd name, a deleted repository or a permissions failure produced an empty local
 * repository that LOOKED successful, and the platform then committed into nothing.
 *
 * The opt-in `expectExisting: true` turns that fallback into a clear error. The lenient default is
 * unchanged — these tests pin BOTH halves.
 */

const cloneMock = vi.fn();
const initMock = vi.fn();
const addRemoteMock = vi.fn();
const currentBranchMock = vi.fn();
const listBranchesMock = vi.fn();

vi.mock('isomorphic-git', () => ({
	default: {
		clone: (...args: unknown[]) => cloneMock(...args),
		init: (...args: unknown[]) => initMock(...args),
		addRemote: (...args: unknown[]) => addRemoteMock(...args),
		currentBranch: (...args: unknown[]) => currentBranchMock(...args),
		listBranches: (...args: unknown[]) => listBranchesMock(...args)
	}
}));

const { GitOperations } = await import('../git-operations.js');

/** An `isomorphic-git` NotFoundError, shaped exactly as the clone path sees it. */
function notFoundError(): Error {
	const error = new Error('Could not find acme/missing-repo');
	(error as Error & { code?: string }).code = 'NotFoundError';
	return error;
}

/** The other message shape the old fallback matched. */
function emptyRemoteError(): Error {
	return new Error('remote repository is empty');
}

let baseDir: string;

function makeOps(): InstanceType<typeof GitOperations> {
	return new GitOperations(
		() => ({ username: 'x-access-token', password: 'token' }),
		(owner, repo) => `https://github.com/${owner}/${repo}.git`,
		{
			baseDir
		}
	);
}

beforeEach(() => {
	baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-expect-existing-'));
	cloneMock.mockReset().mockRejectedValue(notFoundError());
	initMock.mockReset().mockResolvedValue(undefined);
	addRemoteMock.mockReset().mockResolvedValue(undefined);
	currentBranchMock.mockReset().mockResolvedValue(null);
	listBranchesMock.mockReset().mockResolvedValue([]);
});

describe('GitOperations.cloneOrPull — expectExisting', () => {
	it('THROWS for a missing remote when a repository is expected, and leaves no checkout behind', async () => {
		const ops = makeOps();

		let caught: unknown;
		try {
			await ops.cloneOrPull({
				owner: 'acme',
				repo: 'missing-repo',
				token: 'token',
				expectExisting: true
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const error = caught as Error & { code?: string };
		// The error names the repository, so the operator can act on it.
		expect(error.message).toContain('missing-repo');
		expect(error.message).toContain('acme');
		expect(error.code).toBe('repository_not_ready');
		expect(error.name).toBe('RepositoryNotReadyError');

		// No directory, and definitely no silent `git init`.
		expect(fs.existsSync(ops.getLocalDir('acme', 'missing-repo'))).toBe(false);
		expect(initMock).not.toHaveBeenCalled();
		expect(addRemoteMock).not.toHaveBeenCalled();
	});

	it('THROWS for an empty remote when a repository is expected', async () => {
		cloneMock.mockRejectedValue(emptyRemoteError());
		const ops = makeOps();

		await expect(
			ops.cloneOrPull({
				owner: 'acme',
				repo: 'empty-repo',
				token: 'token',
				expectExisting: true
			})
		).rejects.toThrow(/acme\/empty-repo/);

		expect(fs.existsSync(ops.getLocalDir('acme', 'empty-repo'))).toBe(false);
		expect(initMock).not.toHaveBeenCalled();
	});

	it('exposes the typed RepositoryNotReadyError from the git module', async () => {
		const mod: Record<string, unknown> = await import('../git-operations.js');
		expect(typeof mod.RepositoryNotReadyError).toBe('function');

		const ops = makeOps();
		const Ctor = mod.RepositoryNotReadyError as new (...args: never[]) => Error;

		let caught: unknown;
		try {
			await ops.cloneOrPull({
				owner: 'acme',
				repo: 'missing-repo',
				token: 'token',
				expectExisting: true
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Ctor);
	});

	it('KEEPS the lenient default: no flag means the empty local repository is initialised', async () => {
		const ops = makeOps();

		const dir = await ops.cloneOrPull({ owner: 'acme', repo: 'brand-new', token: 'token' });

		expect(dir).toBe(ops.getLocalDir('acme', 'brand-new'));
		expect(fs.existsSync(dir)).toBe(true);
		expect(initMock).toHaveBeenCalledTimes(1);
		expect(initMock.mock.calls[0][0]).toMatchObject({ dir, defaultBranch: 'main' });
		expect(addRemoteMock).toHaveBeenCalledTimes(1);
		expect(addRemoteMock.mock.calls[0][0]).toMatchObject({
			dir,
			remote: 'origin',
			url: 'https://github.com/acme/brand-new.git'
		});
	});

	it('KEEPS the lenient default when expectExisting is explicitly false', async () => {
		const ops = makeOps();

		const dir = await ops.cloneOrPull({
			owner: 'acme',
			repo: 'brand-new-explicit',
			token: 'token',
			expectExisting: false
		});

		expect(fs.existsSync(dir)).toBe(true);
		expect(initMock).toHaveBeenCalledTimes(1);
	});

	it('rethrows an unrelated clone failure on BOTH paths (no fallback for real errors)', async () => {
		cloneMock.mockRejectedValue(new Error('ECONNRESET while cloning'));

		const lenient = makeOps();
		await expect(lenient.cloneOrPull({ owner: 'acme', repo: 'flaky', token: 'token' })).rejects.toThrow(
			/ECONNRESET/
		);
		expect(initMock).not.toHaveBeenCalled();

		const strict = makeOps();
		await expect(
			strict.cloneOrPull({ owner: 'acme', repo: 'flaky', token: 'token', expectExisting: true })
		).rejects.toThrow(/ECONNRESET/);
		expect(initMock).not.toHaveBeenCalled();
	});
});
