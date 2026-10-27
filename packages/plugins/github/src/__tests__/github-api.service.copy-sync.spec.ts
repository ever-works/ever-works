import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitProviderRequestError } from '@ever-works/plugin/git';
import type { GitCommitRangeOptions, GitFetchBranchOptions, IGitOperations } from '@ever-works/plugin/git';

/**
 * APW-02 T48 (FR-63, ACC-02-27) — the private copy's half of the upstream sync:
 * `GitHubApiService.getRepositoryCopyDivergence` and `moveRepositoryCopyBranch`.
 *
 * What this suite keeps true:
 *
 * 1. **The reading is the merge-base count, in the right direction.** `behindBy` counts
 *    `copy..upstream` and `aheadBy` counts `upstream..copy`; a count at the cap is reported as the
 *    cap with `capped: true` ("10000+").
 * 2. **The move pushes the CHECKED sha, never upstream's live head.** The local branch is written
 *    at exactly `headSha` and that branch is what is pushed onto the sync branch — with no `force`
 *    member anywhere in any push request.
 * 3. **A rewritten history is an answer.** A push refused as not-a-fast-forward, or a `headSha` that
 *    is no longer present after the fetch, answers `not_fast_forward` and pushes nothing more.
 * 4. **Refusals happen before any git work**, and the working copy is removed on every path out.
 *
 * The `GitOperations` double records every call; Octokit is mocked as in the sibling suites, so
 * nothing here can reach the network.
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
const getBranchMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				get: (...args: unknown[]) => reposGetMock(...args),
				getBranch: (...args: unknown[]) => getBranchMock(...args)
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

const UPSTREAM_OWNER = 'upstream-org';
const UPSTREAM_REPO = 'app';
const UPSTREAM_BRANCH = 'trunk';
const COPY_OWNER = 'ever-works';
const COPY_REPO = 'app-copy';
const COPY_BRANCH = 'main';
const SYNC_BRANCH = 'ever-works/upstream-sync';
const TOKEN = 'ghp_secret';
const DIR = 'C:/tmp/ever-works-repos/app-copy-main-1700000000000';
const COPY_HEAD = 'c'.repeat(40);
const UPSTREAM_HEAD = 'u'.repeat(39) + '1';
const CHECKED_SHA = 'a'.repeat(40);
const OLD_SYNC_HEAD = 'b'.repeat(40);

function statusError(status: number, message: string): Error {
	const ctor = RequestError as unknown as new (message: string) => Error;
	const error = new ctor(message);
	const shaped = error as Error & { status?: number; response?: unknown };
	shaped.status = status;
	shaped.response = { data: { message }, headers: {} };
	return error;
}

function repositoryPayload(owner: string, name: string, sizeKb = 1024) {
	return {
		owner: { login: owner },
		name,
		full_name: `${owner}/${name}`,
		description: null,
		default_branch: 'main',
		private: true,
		html_url: `https://github.com/${owner}/${name}`,
		clone_url: `https://github.com/${owner}/${name}.git`,
		fork: false,
		size: sizeKb
	};
}

interface Double {
	ops: IGitOperations;
	calls: {
		cloneBranch: Array<Record<string, unknown>>;
		fetchBranch: GitFetchBranchOptions[];
		count: GitCommitRangeOptions[];
		writeBranchRef: Array<{ dir: string; branch: string; oid: string }>;
		push: Array<Record<string, unknown>>;
		removeWorkingCopy: string[];
	};
	setCounts(behind: { count: number; capped: boolean }, ahead: { count: number; capped: boolean }): void;
}

function createDouble(
	options: {
		hasCommit?: boolean;
		fetchHead?: string | null;
		mergeBase?: (oids: readonly [string, string]) => Promise<string | null>;
		push?: (request: Record<string, unknown>) => Promise<void>;
		omit?: string[];
	} = {}
): Double {
	const calls: Double['calls'] = {
		cloneBranch: [],
		fetchBranch: [],
		count: [],
		writeBranchRef: [],
		push: [],
		removeWorkingCopy: []
	};
	let behind = { count: 0, capped: false };
	let ahead = { count: 0, capped: false };
	const ops: Record<string, unknown> = {
		cloneBranch: vi.fn(async (request: Record<string, unknown>) => {
			calls.cloneBranch.push(request);
			return DIR;
		}),
		fetchBranch: vi.fn(async (request: GitFetchBranchOptions) => {
			calls.fetchBranch.push(request);
			return options.fetchHead === undefined ? UPSTREAM_HEAD : options.fetchHead;
		}),
		resolveRef: vi.fn(async () => COPY_HEAD),
		hasCommit: vi.fn(async () => options.hasCommit ?? true),
		findMergeBase: vi.fn(async (_dir: string, oids: readonly [string, string]) =>
			options.mergeBase ? options.mergeBase(oids) : oids.includes(CHECKED_SHA) ? CHECKED_SHA : 'f'.repeat(40)
		),
		countCommitsBetween: vi.fn(async (_dir: string, range: GitCommitRangeOptions) => {
			calls.count.push(range);
			return range.include === UPSTREAM_HEAD ? behind : ahead;
		}),
		writeBranchRef: vi.fn(async (dir: string, branch: string, oid: string) => {
			calls.writeBranchRef.push({ dir, branch, oid });
		}),
		push: vi.fn(async (request: Record<string, unknown>) => {
			calls.push.push(request);
			if (options.push) await options.push(request);
		}),
		removeWorkingCopy: vi.fn(async (dir: string) => {
			calls.removeWorkingCopy.push(dir);
		}),
		// A tripwire: it resolves the per-REPOSITORY checkout, another caller's directory.
		removeLocalDir: vi.fn(async () => {
			throw new Error('removeLocalDir must never be called by the copy sync');
		})
	};
	for (const name of options.omit ?? []) delete ops[name];
	return {
		ops: ops as unknown as IGitOperations,
		calls,
		setCounts: (b, a) => {
			behind = b;
			ahead = a;
		}
	};
}

const divergenceInput = (overrides: Record<string, unknown> = {}) => ({
	sourceOwner: UPSTREAM_OWNER,
	sourceRepo: UPSTREAM_REPO,
	sourceBranch: UPSTREAM_BRANCH,
	targetOwner: COPY_OWNER,
	targetRepo: COPY_REPO,
	targetBranch: COPY_BRANCH,
	...overrides
});

const moveInput = (overrides: Record<string, unknown> = {}) => ({
	sourceOwner: UPSTREAM_OWNER,
	sourceRepo: UPSTREAM_REPO,
	sourceBranch: UPSTREAM_BRANCH,
	targetOwner: COPY_OWNER,
	targetRepo: COPY_REPO,
	targetBaseBranch: COPY_BRANCH,
	branchName: SYNC_BRANCH,
	headSha: CHECKED_SHA,
	...overrides
});

/** Does this request carry a `force` member at all? */
function carriesForce(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	return Object.entries(value as Record<string, unknown>).some(
		([key, entry]) => key === 'force' || carriesForce(entry)
	);
}

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	reposGetMock
		.mockReset()
		.mockImplementation(({ owner, repo }: { owner: string; repo: string }) =>
			Promise.resolve({ data: repositoryPayload(owner, repo) })
		);
	getBranchMock.mockReset().mockResolvedValue({ data: { name: SYNC_BRANCH, commit: { sha: OLD_SYNC_HEAD } } });
});

describe('GitHubApiService.getRepositoryCopyDivergence (APW-02 T48)', () => {
	it('clones the copy, fetches the upstream branch beside it, and counts both directions', async () => {
		const double = createDouble();
		double.setCounts({ count: 7, capped: false }, { count: 2, capped: false });

		const result = await svc.getRepositoryCopyDivergence(divergenceInput(), TOKEN, undefined, double.ops);

		expect(result).toEqual({
			aheadBy: 2,
			behindBy: 7,
			upstreamHeadSha: UPSTREAM_HEAD,
			copyHeadSha: COPY_HEAD,
			mergeBaseSha: 'f'.repeat(40),
			capped: false
		});
		expect(double.calls.cloneBranch).toEqual([
			{ owner: COPY_OWNER, repo: COPY_REPO, branch: COPY_BRANCH, token: TOKEN }
		]);
		expect(double.calls.fetchBranch).toEqual([
			{
				dir: DIR,
				owner: UPSTREAM_OWNER,
				repo: UPSTREAM_REPO,
				branch: UPSTREAM_BRANCH,
				token: TOKEN,
				remote: 'ever-works-upstream'
			}
		]);
		// behind = copy..upstream, ahead = upstream..copy, both at the 10 000 default cap.
		expect(double.calls.count).toEqual([
			{ include: UPSTREAM_HEAD, exclude: COPY_HEAD, max: 10_000 },
			{ include: COPY_HEAD, exclude: UPSTREAM_HEAD, max: 10_000 }
		]);
		expect(double.calls.removeWorkingCopy).toEqual([DIR]);
	});

	it('reports a count at the cap as capped ("10000+")', async () => {
		const double = createDouble();
		double.setCounts({ count: 10_000, capped: true }, { count: 3, capped: false });

		const result = await svc.getRepositoryCopyDivergence(divergenceInput(), TOKEN, undefined, double.ops);

		expect(result.behindBy).toBe(10_000);
		expect(result.capped).toBe(true);
	});

	it('never asks for more than the 10 000 default, and honours a smaller cap', async () => {
		const double = createDouble();
		await svc.getRepositoryCopyDivergence(divergenceInput({ maxCommits: 50_000 }), TOKEN, undefined, double.ops);
		await svc.getRepositoryCopyDivergence(divergenceInput({ maxCommits: 25 }), TOKEN, undefined, double.ops);
		expect(double.calls.count.map((range) => range.max)).toEqual([10_000, 10_000, 25, 25]);
	});

	it('answers not_found for an upstream branch that is gone, and still removes the working copy', async () => {
		const double = createDouble({ fetchHead: null });
		await expect(
			svc.getRepositoryCopyDivergence(divergenceInput(), TOKEN, undefined, double.ops)
		).rejects.toMatchObject({ reason: 'not_found' });
		expect(double.calls.removeWorkingCopy).toEqual([DIR]);
	});

	it('refuses before any git work when a git operation it needs is missing', async () => {
		const double = createDouble({ omit: ['countCommitsBetween'] });
		const error = await svc
			.getRepositoryCopyDivergence(divergenceInput(), TOKEN, undefined, double.ops)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect((error as Error).message).toBe('git_operations_unavailable');
		expect(double.calls.cloneBranch).toHaveLength(0);
		expect(reposGetMock).not.toHaveBeenCalled();
	});

	it('refuses a repository over the size ceiling before cloning', async () => {
		reposGetMock.mockImplementation(({ owner, repo }: { owner: string; repo: string }) =>
			Promise.resolve({ data: repositoryPayload(owner, repo, owner === UPSTREAM_OWNER ? 900_000 : 10) })
		);
		const double = createDouble();
		const error = await svc
			.getRepositoryCopyDivergence(divergenceInput({ maxSizeKb: 512_000 }), TOKEN, undefined, double.ops)
			.catch((caught: unknown) => caught);
		expect((error as GitProviderRequestError).reason).toBe('unprocessable');
		expect((error as Error).message).toBe('too_large');
		expect(double.calls.cloneBranch).toHaveLength(0);
	});
});

describe('GitHubApiService.moveRepositoryCopyBranch (APW-02 T48)', () => {
	it('pushes exactly the checked sha onto the sync branch — never a force push', async () => {
		const double = createDouble();

		const result = await svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops);

		expect(result).toEqual({ outcome: 'moved', pushedSha: CHECKED_SHA });
		expect(double.calls.cloneBranch).toEqual([
			{ owner: COPY_OWNER, repo: COPY_REPO, branch: COPY_BRANCH, token: TOKEN }
		]);
		expect(double.calls.fetchBranch[0]).toMatchObject({
			owner: UPSTREAM_OWNER,
			repo: UPSTREAM_REPO,
			branch: UPSTREAM_BRANCH
		});
		// The pinned commit — not the upstream branch's head the fetch reported.
		expect(double.calls.writeBranchRef).toEqual([
			{ dir: DIR, branch: 'ever-works-copy-sync-push', oid: CHECKED_SHA }
		]);
		expect(double.calls.push).toEqual([
			{
				dir: DIR,
				token: TOKEN,
				ref: 'ever-works-copy-sync-push',
				remoteRef: SYNC_BRANCH,
				owner: COPY_OWNER,
				repo: COPY_REPO
			}
		]);
		expect(double.calls.push.some(carriesForce)).toBe(false);
		expect(double.calls.removeWorkingCopy).toEqual([DIR]);
	});

	it('creates the sync branch when it does not exist yet', async () => {
		getBranchMock.mockRejectedValue(statusError(404, 'Branch not found'));
		const double = createDouble();
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)).resolves.toEqual({
			outcome: 'moved',
			pushedSha: CHECKED_SHA
		});
		expect(double.calls.push).toHaveLength(1);
	});

	it('is up to date — no clone, no push — when the branch already points at the sha', async () => {
		getBranchMock.mockResolvedValue({ data: { name: SYNC_BRANCH, commit: { sha: CHECKED_SHA } } });
		const double = createDouble();
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)).resolves.toEqual({
			outcome: 'up_to_date',
			pushedSha: CHECKED_SHA
		});
		expect(double.calls.cloneBranch).toHaveLength(0);
		expect(double.calls.push).toHaveLength(0);
	});

	it('answers not_fast_forward when the push is refused as not a fast-forward', async () => {
		const double = createDouble({
			push: async () => {
				throw Object.assign(new Error('Push rejected because it was not a simple fast-forward.'), {
					code: 'PushRejectedError',
					data: { reason: 'not-fast-forward' }
				});
			}
		});
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)).resolves.toEqual({
			outcome: 'not_fast_forward',
			pushedSha: null
		});
		expect(double.calls.removeWorkingCopy).toEqual([DIR]);
	});

	it('answers not_fast_forward, pushing nothing, when the checked sha is gone from upstream', async () => {
		const double = createDouble({ hasCommit: false });
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)).resolves.toEqual({
			outcome: 'not_fast_forward',
			pushedSha: null
		});
		expect(double.calls.writeBranchRef).toHaveLength(0);
		expect(double.calls.push).toHaveLength(0);
	});

	it('answers not_fast_forward when the checked sha is present but no longer upstream history', async () => {
		// The copy's own base history still holds the commit, so it EXISTS locally — but the
		// fetched upstream head no longer descends from it (upstream rewrote its branch).
		const double = createDouble({ hasCommit: true, mergeBase: async () => 'e'.repeat(40) });
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)).resolves.toEqual({
			outcome: 'not_fast_forward',
			pushedSha: null
		});
		expect(double.ops.findMergeBase).toHaveBeenCalledWith(DIR, [CHECKED_SHA, UPSTREAM_HEAD]);
		expect(double.calls.writeBranchRef).toHaveLength(0);
		expect(double.calls.push).toHaveLength(0);
		expect(double.calls.removeWorkingCopy).toEqual([DIR]);
	});

	it('accepts the ancestry check case-insensitively, and refuses when it cannot be computed', async () => {
		const upper = createDouble({ mergeBase: async () => CHECKED_SHA.toUpperCase() });
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, upper.ops)).resolves.toEqual({
			outcome: 'moved',
			pushedSha: CHECKED_SHA
		});
		const broken = createDouble({
			mergeBase: async () => {
				throw new Error('could not read object');
			}
		});
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, broken.ops)).resolves.toEqual({
			outcome: 'not_fast_forward',
			pushedSha: null
		});
		expect(broken.calls.push).toHaveLength(0);
	});

	it('pushes when the checked sha IS the fetched upstream head, without a merge-base read', async () => {
		const double = createDouble({ fetchHead: CHECKED_SHA });
		await expect(svc.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)).resolves.toEqual({
			outcome: 'moved',
			pushedSha: CHECKED_SHA
		});
		expect(double.ops.findMergeBase).not.toHaveBeenCalled();
	});

	it('classifies any other push failure as the contract error and still removes the working copy', async () => {
		const double = createDouble({
			push: async () => {
				throw new Error('HTTP Error: 403 Forbidden');
			}
		});
		const error = await svc
			.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(double.calls.removeWorkingCopy).toEqual([DIR]);
	});

	it('refuses a head that is not a full sha, and never moves the tracked branch', async () => {
		const double = createDouble();
		for (const overrides of [{ headSha: 'abc123' }, { headSha: '' }, { branchName: COPY_BRANCH }]) {
			const error = await svc
				.moveRepositoryCopyBranch(moveInput(overrides), TOKEN, undefined, double.ops)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(GitProviderRequestError);
			expect((error as GitProviderRequestError).reason).toBe('unprocessable');
		}
		expect(double.calls.cloneBranch).toHaveLength(0);
		expect(getBranchMock).not.toHaveBeenCalled();
	});

	it('refuses before any provider call when a git operation it needs is missing', async () => {
		const double = createDouble({ omit: ['writeBranchRef'] });
		const error = await svc
			.moveRepositoryCopyBranch(moveInput(), TOKEN, undefined, double.ops)
			.catch((caught: unknown) => caught);
		expect((error as Error).message).toBe('git_operations_unavailable');
		expect(getBranchMock).not.toHaveBeenCalled();
		expect(double.calls.cloneBranch).toHaveLength(0);
	});
});
