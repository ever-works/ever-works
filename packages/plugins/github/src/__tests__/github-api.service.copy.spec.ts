import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { GitProviderRequestError } from '@ever-works/plugin/git';
import type { GitCloneBranchOptions, IGitOperations } from '@ever-works/plugin/git';

/**
 * APW-02 T19 — `GitHubApiService.createRepositoryCopy` (plan §4.3, FR-21,
 * ACC-02-15).
 *
 * Four things this suite keeps true, each of them a way the copy can go wrong
 * silently:
 *
 * 1. **The two refusals happen before any git work.** A source over the
 *    caller's `maxSizeKb` ceiling, and a root `.gitattributes` that sends files
 *    to Git LFS, are both `unprocessable` — and both must be answered without a
 *    single clone, because a clone that cannot be finished leaves a working
 *    copy of somebody else's repository on disk for nothing. Every refusal test
 *    asserts the double was never called.
 * 2. **A second run with equal heads copies nothing.** When the target branch
 *    already points at the source head, no clone and no push happen at all and
 *    the answer says `alreadyUpToDate` (FR-21: "safe to run twice").
 * 3. **The push is never a force-push.** The request the double received has no
 *    `force` member at all — the strongest form of ACC-02-10's rule — and the
 *    suite records every push it made anywhere so the last test can assert none
 *    of them was a force push (the T19 "done when").
 * 4. **The working copy is removed on every path**, error included. The
 *    directory is this call's own (`cloneBranch` names it uniquely) and holds a
 *    full checkout of the source, so leaving it behind on a failed push is a
 *    leak the plan explicitly forbids. It is observed where it happens: the
 *    service removes the directory with `node:fs`, because `IGitOperations`
 *    exposes no removal for a `cloneBranch` directory — so `fs.promises.rm` is
 *    spied on, and the double's `removeLocalDir` is a tripwire that must never
 *    be called (it resolves a DIFFERENT directory: another caller's checkout).
 *
 * The `GitOperations` double below records every call, so "no clone" and "one
 * push" are assertions about behaviour rather than about mocks that were never
 * wired up. Octokit is mocked exactly as the sibling
 * `github-api.service.*.spec.ts` suites do: nothing here can reach the network.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const reposGetMock = vi.fn();
const getContentMock = vi.fn();
const getBranchMock = vi.fn();

/**
 * Every request the suite made, across every test. `mockReset()` in
 * `beforeEach` clears a mock's own call log, so the "no force push anywhere"
 * assertions declared last read the module-level records instead — the whole
 * file's history, not the last test's.
 */
const allRequests: Record<string, unknown>[] = [];

/** Every push request every double received, for the same reason. */
const allPushRequests: Array<Record<string, unknown>> = [];

/** Every directory the copy removed, in order. */
const removedDirs: string[] = [];

function record(args: unknown[]): void {
	if (args[0] && typeof args[0] === 'object') allRequests.push(args[0] as Record<string, unknown>);
}

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				get: (...args: unknown[]) => {
					record(args);
					return reposGetMock(...args);
				},
				getContent: (...args: unknown[]) => {
					record(args);
					return getContentMock(...args);
				},
				getBranch: (...args: unknown[]) => {
					record(args);
					return getBranchMock(...args);
				}
			}
		};
		constructor(public opts: unknown) {}
	}

	class FakeRequestError extends Error {
		status?: number;
		response?: { data?: unknown; headers?: Record<string, string | number> };
	}

	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { RequestError } = await import('octokit');
const { GitHubApiService } = await import('../github-api.service.js');
const { GitHubPlugin } = await import('../github.plugin.js');

const SOURCE_OWNER = 'upstream-org';
const SOURCE_REPO = 'app';
const SOURCE_BRANCH = 'trunk';
const TARGET_OWNER = 'ever-works';
const TARGET_REPO = 'app-data';
const TOKEN = 'ghp_secret';
const SOURCE_HEAD = '1111111111111111111111111111111111111111';
const TARGET_HEAD = '2222222222222222222222222222222222222222';
const CLONED_DIR = 'C:/tmp/ever-works-repos/app-trunk-1700000000000';
const MAX_SIZE_KB = 512_000;

/** A GitHub status error, shaped the way Octokit raises one. */
function statusError(status: number, message: string, headers: Record<string, string | number> = {}): Error {
	const ctor = RequestError as unknown as new (message: string) => Error;
	const error = new ctor(message);
	const shaped = error as Error & { status?: number; response?: unknown };
	shaped.status = status;
	shaped.response = { data: { message }, headers };
	return error;
}

/** The repository payload `getRepository` reads, with only the fields it maps. */
function repositoryPayload(owner: string, name: string, sizeKb = 1024, overrides: Record<string, unknown> = {}) {
	return {
		owner: { login: owner },
		name,
		full_name: `${owner}/${name}`,
		description: null,
		default_branch: 'trunk',
		private: true,
		html_url: `https://github.com/${owner}/${name}`,
		clone_url: `https://github.com/${owner}/${name}.git`,
		fork: false,
		size: sizeKb,
		...overrides
	};
}

/** A `.gitattributes` payload, base64-encoded as GitHub returns it. */
function attributesPayload(text: string) {
	return {
		data: {
			type: 'file',
			name: '.gitattributes',
			path: '.gitattributes',
			encoding: 'base64',
			content: Buffer.from(text, 'utf8').toString('base64')
		}
	};
}

interface Calls {
	cloneBranch: GitCloneBranchOptions[];
	replaceRemote: Array<{ dir: string; remote: string; url: string }>;
	push: Array<Record<string, unknown>>;
}

/** The `GitOperations` double: records everything, never touches a disk or a network. */
function createGitOpsDouble(): { calls: Calls; double: IGitOperations } {
	const calls: Calls = { cloneBranch: [], replaceRemote: [], push: [] };

	const double = {
		cloneBranch: vi.fn(async (options: GitCloneBranchOptions) => {
			calls.cloneBranch.push(options);
			return CLONED_DIR;
		}),
		replaceRemote: vi.fn(async (dir: string, remote: string, url: string) => {
			calls.replaceRemote.push({ dir, remote, url });
		}),
		push: vi.fn(async (options: Record<string, unknown>) => {
			calls.push.push(options);
			allPushRequests.push(options);
		}),
		// Not part of the copy path — `removeLocalDir` resolves a DIFFERENT
		// directory (the per-repository checkout), so its presence is a tripwire: a
		// call to it would mean the copy is deleting somebody else's working copy.
		removeLocalDir: vi.fn(async () => undefined)
	};

	return { calls, double: double as unknown as IGitOperations };
}

/** Does this request carry `force: true` anywhere in it? */
function carriesForceTrue(value: unknown, seen = new Set<unknown>()): boolean {
	if (value === null || typeof value !== 'object') return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((entry) => carriesForceTrue(entry, seen));
	return Object.entries(value as Record<string, unknown>).some(
		([key, entry]) => (key === 'force' && entry === true) || carriesForceTrue(entry, seen)
	);
}

const input = (overrides: Record<string, unknown> = {}) => ({
	sourceOwner: SOURCE_OWNER,
	sourceRepo: SOURCE_REPO,
	sourceBranch: SOURCE_BRANCH,
	targetOwner: TARGET_OWNER,
	targetRepo: TARGET_REPO,
	maxSizeKb: MAX_SIZE_KB,
	...overrides
});

let svc: InstanceType<typeof GitHubApiService>;
let restoreRm: (() => void) | undefined;

beforeEach(() => {
	svc = new GitHubApiService();
	removedDirs.length = 0;
	reposGetMock
		.mockReset()
		.mockImplementation(({ owner, repo }: { owner: string; repo: string }) =>
			Promise.resolve({ data: repositoryPayload(owner, repo) })
		);
	getContentMock.mockReset().mockRejectedValue(statusError(404, 'Not Found'));
	getBranchMock.mockReset().mockImplementation(({ owner }: { owner: string }) =>
		Promise.resolve({
			data: { name: SOURCE_BRANCH, commit: { sha: owner === SOURCE_OWNER ? SOURCE_HEAD : TARGET_HEAD } }
		})
	);

	// The copy removes its working copy with `node:fs` (there is no `IGitOperations`
	// member that can remove a `cloneBranch` directory), so the removal is observed
	// where it happens.
	const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target: unknown) => {
		removedDirs.push(String(target));
	});
	restoreRm = () => spy.mockRestore();
});

afterEach(() => {
	restoreRm?.();
});

describe('GitHubApiService.createRepositoryCopy — refusals before any git work (FR-21)', () => {
	it('refuses a source over the size ceiling, with no clone', async () => {
		reposGetMock.mockImplementation(({ owner, repo }: { owner: string; repo: string }) =>
			Promise.resolve({ data: repositoryPayload(owner, repo, MAX_SIZE_KB + 1) })
		);
		const { calls, double } = createGitOpsDouble();

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('unprocessable');
		expect(error.status).toBe(422);
		// The plan's own code for this refusal (§4.3: "`unprocessable` + `too_large`").
		expect(error.message).toBe('too_large');
		expect(calls.cloneBranch).toEqual([]);
		expect(calls.push).toEqual([]);
	});

	it('refuses a source whose size the provider never reported', async () => {
		// Fail closed: the ceiling is the caller's authorisation, and a size that
		// cannot be compared with it cannot be shown to be within it.
		reposGetMock.mockImplementation(({ owner, repo }: { owner: string; repo: string }) =>
			Promise.resolve({ data: { ...repositoryPayload(owner, repo), size: undefined } })
		);
		const { calls, double } = createGitOpsDouble();

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		expect(error.message).toBe('too_large');
		expect(calls.cloneBranch).toEqual([]);
	});

	it('refuses a root .gitattributes that uses Git LFS, with no clone', async () => {
		getContentMock.mockResolvedValue(attributesPayload('*.psd filter=lfs diff=lfs merge=lfs -text\n'));
		const { calls, double } = createGitOpsDouble();

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('unprocessable');
		expect(error.message).toBe('uses_lfs');
		expect(calls.cloneBranch).toEqual([]);
	});

	it('reads .gitattributes from the branch being copied, not the default branch', async () => {
		const { double } = createGitOpsDouble();

		await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(getContentMock).toHaveBeenCalledWith({
			owner: SOURCE_OWNER,
			repo: SOURCE_REPO,
			path: '.gitattributes',
			ref: SOURCE_BRANCH
		});
	});

	it('copies when .gitattributes names LFS only in a comment', async () => {
		getContentMock.mockResolvedValue(attributesPayload('# filter=lfs was removed in 2024\n*.txt text\n'));
		const { calls, double } = createGitOpsDouble();

		const result = await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(result.alreadyUpToDate).toBe(false);
		expect(calls.push).toHaveLength(1);
	});

	it('copies a repository with no .gitattributes at all', async () => {
		const { calls, double } = createGitOpsDouble();

		await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(calls.cloneBranch).toHaveLength(1);
	});

	it('refuses when the source repository cannot be read', async () => {
		// `getRepository` answers null on 404, so this is the copy's own not_found.
		reposGetMock.mockRejectedValue(statusError(404, 'Not Found'));
		const { calls, double } = createGitOpsDouble();

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('not_found');
		expect(error.status).toBe(404);
		expect(calls.cloneBranch).toEqual([]);
	});

	it('refuses when git operations cannot clone at all', async () => {
		// `cloneBranch` is optional on `IGitOperations`; a capability that cannot run
		// must not read a repository first.
		const error = await svc
			.createRepositoryCopy(input(), TOKEN, undefined, {} as IGitOperations)
			.catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.message).toBe('git_operations_unavailable');
		expect(reposGetMock).not.toHaveBeenCalled();
	});

	it('refuses when no git operations were handed over at all', async () => {
		const error = await svc.createRepositoryCopy(input(), TOKEN).catch((err) => err);

		expect(error.message).toBe('git_operations_unavailable');
	});
});

describe('GitHubApiService.createRepositoryCopy — the copy itself', () => {
	it('clones the source branch, repoints origin at the target and pushes once without force', async () => {
		const { calls, double } = createGitOpsDouble();

		const result = await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(calls.cloneBranch).toEqual([
			{ owner: SOURCE_OWNER, repo: SOURCE_REPO, branch: SOURCE_BRANCH, token: TOKEN }
		]);
		expect(calls.replaceRemote).toEqual([
			{ dir: CLONED_DIR, remote: 'origin', url: `https://github.com/${TARGET_OWNER}/${TARGET_REPO}.git` }
		]);
		expect(calls.push).toEqual([{ dir: CLONED_DIR, token: TOKEN, ref: SOURCE_BRANCH, remoteRef: SOURCE_BRANCH }]);
		expect('force' in calls.push[0]).toBe(false);
		expect(result).toEqual({ pushedSha: SOURCE_HEAD, alreadyUpToDate: false });
	});

	it('pushes under branchName when the caller names one', async () => {
		const { calls, double } = createGitOpsDouble();

		await svc.createRepositoryCopy(input({ branchName: 'main' }), TOKEN, undefined, double);

		expect(calls.push[0].remoteRef).toBe('main');
		expect(calls.push[0].ref).toBe(SOURCE_BRANCH);
	});

	it('does nothing when the target branch already points at the source head', async () => {
		// FR-21's "safe to run twice": equal heads mean there is nothing to copy.
		getBranchMock.mockImplementation(() =>
			Promise.resolve({ data: { name: SOURCE_BRANCH, commit: { sha: SOURCE_HEAD } } })
		);
		const { calls, double } = createGitOpsDouble();

		const result = await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(result).toEqual({ pushedSha: SOURCE_HEAD, alreadyUpToDate: true });
		expect(calls.cloneBranch).toEqual([]);
		expect(calls.push).toEqual([]);
		// The short-circuit is a real read of the TARGET branch, not an assumption.
		expect(getBranchMock).toHaveBeenCalledWith({ owner: TARGET_OWNER, repo: TARGET_REPO, branch: SOURCE_BRANCH });
	});

	it('copies when the target branch exists at a different head', async () => {
		const { calls, double } = createGitOpsDouble();

		const result = await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(result.alreadyUpToDate).toBe(false);
		expect(calls.push).toHaveLength(1);
	});

	it('copies when the target branch does not exist yet (the empty repository)', async () => {
		getBranchMock.mockImplementation(({ owner }: { owner: string }) =>
			owner === SOURCE_OWNER
				? Promise.resolve({ data: { name: SOURCE_BRANCH, commit: { sha: SOURCE_HEAD } } })
				: Promise.reject(statusError(404, 'Branch not found'))
		);
		const { calls, double } = createGitOpsDouble();

		const result = await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(result).toEqual({ pushedSha: SOURCE_HEAD, alreadyUpToDate: false });
		expect(calls.cloneBranch).toHaveLength(1);
	});

	it('refuses when the target repository is not there', async () => {
		reposGetMock.mockImplementation(({ owner, repo }: { owner: string; repo: string }) =>
			owner === SOURCE_OWNER
				? Promise.resolve({ data: repositoryPayload(owner, repo) })
				: Promise.reject(statusError(404, 'Not Found'))
		);
		const { calls, double } = createGitOpsDouble();

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('not_found');
		expect(calls.cloneBranch).toEqual([]);
	});

	it('names contents when a branch read is refused', async () => {
		getBranchMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		const { double } = createGitOpsDouble();

		await expect(svc.createRepositoryCopy(input(), TOKEN, undefined, double)).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'contents' }
		});
	});

	it('names contents when the .gitattributes read is refused', async () => {
		// `getFileContent` rethrows non-404s raw; the copy classifies them, because
		// every new plugin method throws only the contract's error.
		getContentMock.mockRejectedValue(statusError(403, 'Resource not accessible by personal access token'));

		const { calls, double } = createGitOpsDouble();

		await expect(svc.createRepositoryCopy(input(), TOKEN, undefined, double)).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'contents' }
		});
		expect(calls.cloneBranch).toEqual([]);
	});
});

describe('GitHubApiService.createRepositoryCopy — the working copy is always removed', () => {
	it('removes the directory after a successful copy', async () => {
		const { double } = createGitOpsDouble();

		await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(removedDirs).toEqual([CLONED_DIR]);
		// …and never through `removeLocalDir`, which resolves a different directory
		// (another caller's per-repository checkout).
		expect(
			(double as unknown as { removeLocalDir: ReturnType<typeof vi.fn> }).removeLocalDir
		).not.toHaveBeenCalled();
	});

	it('removes the directory when the push fails, and reports it as the contract error', async () => {
		const { calls, double } = createGitOpsDouble();
		(double as unknown as { push: ReturnType<typeof vi.fn> }).push.mockRejectedValue(new Error('unpack failed'));

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		// A git-layer failure is not a GitHub API error, so it degrades to
		// `unprocessable` with no HTTP status — and the original travels as `cause`
		// (§4.2's documented fallback; §4.2 also says new plugin methods throw only
		// this error type).
		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('unprocessable');
		expect(error.status).toBe(0);
		expect((error.cause as Error).message).toBe('unpack failed');
		expect(calls.cloneBranch).toHaveLength(1);
		expect(removedDirs).toEqual([CLONED_DIR]);
	});

	it('removes the directory when repointing the remote fails', async () => {
		const { calls, double } = createGitOpsDouble();
		(double as unknown as { replaceRemote: ReturnType<typeof vi.fn> }).replaceRemote.mockRejectedValue(
			new Error('remote not found')
		);

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(calls.push).toEqual([]);
		expect(removedDirs).toEqual([CLONED_DIR]);
	});

	it('reports a failed clone as the contract error, with no directory to remove', async () => {
		const { double } = createGitOpsDouble();
		(double as unknown as { cloneBranch: ReturnType<typeof vi.fn> }).cloneBranch.mockRejectedValue(
			new Error('could not read from remote')
		);

		const error = await svc.createRepositoryCopy(input(), TOKEN, undefined, double).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('unprocessable');
		expect((error.cause as Error).message).toBe('could not read from remote');
		expect(removedDirs).toEqual([]);
	});

	it('removes nothing when there was nothing to copy', async () => {
		getBranchMock.mockImplementation(() =>
			Promise.resolve({ data: { name: SOURCE_BRANCH, commit: { sha: SOURCE_HEAD } } })
		);
		const { double } = createGitOpsDouble();

		await svc.createRepositoryCopy(input(), TOKEN, undefined, double);

		expect(removedDirs).toEqual([]);
	});
});

describe('GitHubPlugin.createRepositoryCopy — the capability pass-through (T19)', () => {
	it('reaches the copy through the plugin member APW-02 T22 will call', async () => {
		// Equal heads, so the copy short-circuits before it needs the plugin's own
		// `GitOperations` at all: what this asserts is the WIRING — the optional
		// `IGitProviderPlugin` member exists and forwards to this service — not the
		// copy, which the tests above cover.
		getBranchMock.mockImplementation(() =>
			Promise.resolve({ data: { name: SOURCE_BRANCH, commit: { sha: SOURCE_HEAD } } })
		);

		const result = await new GitHubPlugin().createRepositoryCopy(input(), TOKEN);

		expect(result).toEqual({ pushedSha: SOURCE_HEAD, alreadyUpToDate: true });
	});
});

describe('GitHubApiService.createRepositoryCopy — the whole suite (T19 done-when)', () => {
	/**
	 * Declared LAST on purpose: vitest runs a file's tests in order, so every push
	 * this file made is in `allPushRequests` — and every provider request in
	 * `allRequests` — by the time these run.
	 */
	it('the double recorded zero force pushes', () => {
		expect(allPushRequests.length).toBeGreaterThan(0);
		expect(allPushRequests.filter((request) => carriesForceTrue(request))).toEqual([]);
		// Stronger still: not one of them carried a `force` member at all.
		expect(allPushRequests.filter((request) => 'force' in request)).toEqual([]);
	});

	it('no request in this file carried force: true', () => {
		expect(allRequests.length).toBeGreaterThan(5);
		expect(allRequests.filter((request) => carriesForceTrue(request))).toEqual([]);
	});
});
