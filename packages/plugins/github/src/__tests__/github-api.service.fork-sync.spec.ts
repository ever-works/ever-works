import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitProviderRequestError } from '@ever-works/plugin/git';

/**
 * APW-02 T18 — syncing a fork, measuring its divergence, and moving a branch ref
 * (plan §4.3, ACC-02-09, ACC-02-10, ACC-02-19).
 *
 * Four things this suite keeps true:
 *
 * 1. **`merge-upstream`'s answers are RESULTS, not throws.** 200 `fast-forward` ⇒
 *    `fast_forwarded`, `merge` ⇒ `merged`, `none` ⇒ `up_to_date`, and the two
 *    refusals GitHub words as "this needs a pull request" / "this cannot be
 *    synced" — 409 and 422 — come back as `conflict` / `unprocessable` so a caller
 *    renders them instead of retrying them.
 * 2. **The compare's `basehead` names the upstream by OWNER.** `<upstreamOwner>:<upstreamBranch>...<forkBranch>`
 *    is the only form that compares the fork against the UPSTREAM; a bare
 *    `branch...branch` would compare the fork with itself and always report zero.
 * 3. **Nothing is force-moved, ever.** `updateBranchRef` sends `force: false` on
 *    every call — including one whose caller passed `true` through an untyped
 *    boundary — and the whole suite asserts that no request it made carried
 *    `force: true` (the T18 "done when").
 * 4. **Failures are the contract's typed error**, never a raw provider error, so a
 *    caller can branch on `reason` without reading GitHub's prose.
 *
 * One §4.3 mapping cannot be implemented as written and is pinned here rather than
 * papered over: `forkHeadSha`. The comparison returns its commits in CHRONOLOGICAL
 * order, so `per_page: 1` yields the OLDEST commit of the range — never the head —
 * and an unpaginated comparison is capped at 250 commits. The fork head is read
 * from the fork's own branch ref, and test "reads the fork head from the fork's own
 * branch ref, not from the compare's commit list" holds that line.
 *
 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts` suites
 * do, so nothing here can reach the network.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const mergeUpstreamMock = vi.fn();
const compareCommitsMock = vi.fn();
const getBranchMock = vi.fn();
const createRefMock = vi.fn();
const updateRefMock = vi.fn();

/**
 * Every request the suite made, across every test. `mockReset()` in `beforeEach`
 * clears a mock's own call log, so the "no `force: true` anywhere" assertion at the
 * end of the file reads this instead — the suite's whole history, not the last
 * test's.
 */
const allRequests: Record<string, unknown>[] = [];

function record(args: unknown[]): void {
	if (args[0] && typeof args[0] === 'object') allRequests.push(args[0] as Record<string, unknown>);
}

vi.mock('octokit', () => {
	class FakeRequestError extends Error {
		status?: number;
		response?: { data?: unknown; headers?: Record<string, string | number> };
	}

	class FakeOctokit {
		rest = {
			repos: {
				mergeUpstream: (...args: unknown[]) => {
					record(args);
					return mergeUpstreamMock(...args);
				},
				compareCommitsWithBasehead: (...args: unknown[]) => {
					record(args);
					return compareCommitsMock(...args);
				},
				getBranch: (...args: unknown[]) => {
					record(args);
					return getBranchMock(...args);
				}
			},
			git: {
				createRef: (...args: unknown[]) => {
					record(args);
					return createRefMock(...args);
				},
				updateRef: (...args: unknown[]) => {
					record(args);
					return updateRefMock(...args);
				}
			}
		};
		constructor(public opts: unknown) {}
	}

	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { RequestError } = await import('octokit');
const { GitHubApiService } = await import('../github-api.service.js');

const UPSTREAM_OWNER = 'acme';
const UPSTREAM_BRANCH = 'trunk';
const FORK_OWNER = 'acme-user';
const FORK_REPO = 'app';
const FORK_BRANCH = 'main';
const SYNC_BRANCH = 'ever-works/upstream-sync';
const TOKEN = 'ghp_secret';
const UPSTREAM_HEAD_SHA = '1111111111111111111111111111111111111111';
const FORK_HEAD_SHA = '2222222222222222222222222222222222222222';
const OLDEST_COMPARE_COMMIT_SHA = '3333333333333333333333333333333333333333';

/** A GitHub status error, shaped the way Octokit raises one. */
function statusError(status: number, message: string, headers: Record<string, string | number> = {}): Error {
	const ctor = RequestError as unknown as new (message: string) => Error;
	const error = new ctor(message);
	const shaped = error as Error & { status?: number; response?: unknown };
	shaped.status = status;
	shaped.response = { data: { message }, headers };
	return error;
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

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	mergeUpstreamMock.mockReset();
	compareCommitsMock.mockReset().mockResolvedValue({
		data: {
			status: 'behind',
			ahead_by: 0,
			behind_by: 3,
			total_commits: 3,
			// The base side of the compare is the UPSTREAM ref, so this is the upstream
			// head — with `merge_base_commit` a different (older) commit.
			base_commit: { sha: UPSTREAM_HEAD_SHA },
			merge_base_commit: { sha: FORK_HEAD_SHA },
			commits: [{ sha: OLDEST_COMPARE_COMMIT_SHA }]
		}
	});
	getBranchMock.mockReset().mockResolvedValue({ data: { name: FORK_BRANCH, commit: { sha: FORK_HEAD_SHA } } });
	createRefMock.mockReset();
	updateRefMock.mockReset();
});

describe('GitHubApiService.syncForkBranch — merge-upstream answers are results (ACC-02-09)', () => {
	it('maps 200 fast-forward to fast_forwarded', async () => {
		mergeUpstreamMock.mockResolvedValue({
			data: {
				message: 'Successfully fetched and fast-forwarded from upstream',
				merge_type: 'fast-forward',
				base_branch: FORK_BRANCH
			}
		});

		const result = await svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN);

		expect(result).toEqual({ outcome: 'fast_forwarded', baseBranch: FORK_BRANCH });
		expect(mergeUpstreamMock).toHaveBeenCalledTimes(1);
		expect(mergeUpstreamMock).toHaveBeenCalledWith({ owner: FORK_OWNER, repo: FORK_REPO, branch: FORK_BRANCH });
	});

	it('maps 200 merge to merged', async () => {
		mergeUpstreamMock.mockResolvedValue({
			data: { message: 'Successfully merged upstream', merge_type: 'merge', base_branch: FORK_BRANCH }
		});

		const result = await svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN);

		expect(result).toEqual({ outcome: 'merged', baseBranch: FORK_BRANCH });
	});

	it('maps 200 none to up_to_date', async () => {
		mergeUpstreamMock.mockResolvedValue({
			data: { message: 'Branch is already up to date', merge_type: 'none', base_branch: FORK_BRANCH }
		});

		const result = await svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN);

		expect(result).toEqual({ outcome: 'up_to_date', baseBranch: FORK_BRANCH });
	});

	it('reports merged — never up_to_date — when a 200 names no merge_type', async () => {
		// GitHub types `merge_type` as optional. A 200 says the branch WAS synced; the
		// one outcome that must never be guessed at is "nothing changed".
		mergeUpstreamMock.mockResolvedValue({ data: { message: 'Successfully synced' } });

		const result = await svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN);

		expect(result).toEqual({ outcome: 'merged' });
		expect(result.baseBranch).toBeUndefined();
	});

	it('answers conflict on 409 instead of throwing', async () => {
		mergeUpstreamMock.mockRejectedValue(statusError(409, 'Merge conflict'));

		const result = await svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN);

		expect(result).toEqual({ outcome: 'conflict' });
	});

	it('answers unprocessable on 422 instead of throwing', async () => {
		mergeUpstreamMock.mockRejectedValue(statusError(422, 'Validation Failed'));

		const result = await svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN);

		expect(result).toEqual({ outcome: 'unprocessable' });
	});

	it('raises the contract error, naming contents, on a permission refusal', async () => {
		mergeUpstreamMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		await expect(svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN)).rejects.toMatchObject({
			reason: 'permission_missing',
			status: 403,
			details: { permission: 'contents' }
		});
	});

	it('raises not_found when the branch is gone on both sides', async () => {
		mergeUpstreamMock.mockRejectedValue(statusError(404, 'Not Found'));

		const error = await svc.syncForkBranch(FORK_OWNER, FORK_REPO, FORK_BRANCH, TOKEN).catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('not_found');
		expect(error.status).toBe(404);
	});
});

describe('GitHubApiService.getForkDivergence — the compare names the upstream by owner', () => {
	it('sends exactly <upstreamOwner>:<upstreamBranch>...<forkBranch> and maps the counts', async () => {
		compareCommitsMock.mockResolvedValue({
			data: {
				status: 'diverged',
				ahead_by: 2,
				behind_by: 7,
				base_commit: { sha: UPSTREAM_HEAD_SHA },
				merge_base_commit: { sha: '4444444444444444444444444444444444444444' },
				commits: []
			}
		});

		const result = await svc.getForkDivergence(
			FORK_OWNER,
			FORK_REPO,
			FORK_BRANCH,
			UPSTREAM_OWNER,
			UPSTREAM_BRANCH,
			TOKEN
		);

		expect(compareCommitsMock).toHaveBeenCalledTimes(1);
		expect(compareCommitsMock).toHaveBeenCalledWith({
			owner: FORK_OWNER,
			repo: FORK_REPO,
			basehead: `${UPSTREAM_OWNER}:${UPSTREAM_BRANCH}...${FORK_BRANCH}`,
			per_page: 1
		});
		expect(compareCommitsMock.mock.calls[0][0].basehead).toBe('acme:trunk...main');

		expect(result).toEqual({
			aheadBy: 2,
			behindBy: 7,
			upstreamHeadSha: UPSTREAM_HEAD_SHA,
			forkHeadSha: FORK_HEAD_SHA
		});
	});

	it('reads the fork head from the fork own branch ref, not from the compare commit list', async () => {
		// The compare returns commits in CHRONOLOGICAL order, so its single commit
		// (per_page: 1) is the OLDEST of the range. The fork head must not be it.
		const result = await svc.getForkDivergence(
			FORK_OWNER,
			FORK_REPO,
			FORK_BRANCH,
			UPSTREAM_OWNER,
			UPSTREAM_BRANCH,
			TOKEN
		);

		expect(result.forkHeadSha).toBe(FORK_HEAD_SHA);
		expect(result.forkHeadSha).not.toBe(OLDEST_COMPARE_COMMIT_SHA);
		// …and it is the FORK's branch that was read, not the upstream's.
		expect(getBranchMock).toHaveBeenCalledWith({ owner: FORK_OWNER, repo: FORK_REPO, branch: FORK_BRANCH });
	});

	it('distinguishes the upstream head from the merge base', async () => {
		const result = await svc.getForkDivergence(
			FORK_OWNER,
			FORK_REPO,
			FORK_BRANCH,
			UPSTREAM_OWNER,
			UPSTREAM_BRANCH,
			TOKEN
		);

		expect(result.upstreamHeadSha).toBe(UPSTREAM_HEAD_SHA);
		expect(result.upstreamHeadSha).not.toBe(result.forkHeadSha);
	});

	it('raises not_found when a branch on either side is missing', async () => {
		compareCommitsMock.mockRejectedValue(statusError(404, 'Not Found'));

		const error = await svc
			.getForkDivergence(FORK_OWNER, FORK_REPO, FORK_BRANCH, UPSTREAM_OWNER, UPSTREAM_BRANCH, TOKEN)
			.catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('not_found');
		// The failing call is the only one made: no branch read happened.
		expect(getBranchMock).not.toHaveBeenCalled();
	});
});

describe('GitHubApiService.createBranchFromSha — pointing a branch at a sha', () => {
	it('creates refs/heads/<name> at the sha and returns the branch', async () => {
		createRefMock.mockResolvedValue({
			data: { ref: `refs/heads/${SYNC_BRANCH}`, object: { sha: UPSTREAM_HEAD_SHA } }
		});

		const branch = await svc.createBranchFromSha(FORK_OWNER, FORK_REPO, SYNC_BRANCH, UPSTREAM_HEAD_SHA, TOKEN);

		expect(createRefMock).toHaveBeenCalledWith({
			owner: FORK_OWNER,
			repo: FORK_REPO,
			ref: `refs/heads/${SYNC_BRANCH}`,
			sha: UPSTREAM_HEAD_SHA
		});
		expect(branch).toEqual({
			name: SYNC_BRANCH,
			commit: UPSTREAM_HEAD_SHA,
			isDefault: false,
			isProtected: false
		});
	});

	it('classifies a 422 "reference already exists" as unprocessable', async () => {
		createRefMock.mockRejectedValue(statusError(422, 'Reference already exists'));

		await expect(
			svc.createBranchFromSha(FORK_OWNER, FORK_REPO, SYNC_BRANCH, UPSTREAM_HEAD_SHA, TOKEN)
		).rejects.toMatchObject({ reason: 'unprocessable', status: 422 });
	});
});

describe('GitHubApiService.updateBranchRef — fast-forward only, never a force-move (ACC-02-10)', () => {
	it('always sends force: false', async () => {
		updateRefMock.mockResolvedValue({
			data: { ref: `refs/heads/${SYNC_BRANCH}`, object: { sha: UPSTREAM_HEAD_SHA } }
		});

		const branch = await svc.updateBranchRef(
			FORK_OWNER,
			FORK_REPO,
			SYNC_BRANCH,
			UPSTREAM_HEAD_SHA,
			{ force: false },
			TOKEN
		);

		expect(updateRefMock).toHaveBeenCalledTimes(1);
		expect(updateRefMock).toHaveBeenCalledWith({
			owner: FORK_OWNER,
			repo: FORK_REPO,
			ref: `heads/${SYNC_BRANCH}`,
			sha: UPSTREAM_HEAD_SHA,
			force: false
		});
		expect(branch).toEqual({
			name: SYNC_BRANCH,
			commit: UPSTREAM_HEAD_SHA,
			isDefault: false,
			isProtected: false
		});
	});

	it('sends force: false even when an untyped caller asks for a force-move', async () => {
		updateRefMock.mockResolvedValue({
			data: { ref: `refs/heads/${SYNC_BRANCH}`, object: { sha: UPSTREAM_HEAD_SHA } }
		});

		await svc.updateBranchRef(
			FORK_OWNER,
			FORK_REPO,
			SYNC_BRANCH,
			UPSTREAM_HEAD_SHA,
			{ force: true } as unknown as { force: false },
			TOKEN
		);

		expect(updateRefMock.mock.calls[0][0].force).toBe(false);
		expect(carriesForceTrue(updateRefMock.mock.calls[0][0])).toBe(false);
	});

	it('turns a 422 non-fast-forward into unprocessable, not a retry', async () => {
		updateRefMock.mockRejectedValue(statusError(422, 'Update is not a fast forward'));

		const error = await svc
			.updateBranchRef(FORK_OWNER, FORK_REPO, SYNC_BRANCH, UPSTREAM_HEAD_SHA, { force: false }, TOKEN)
			.catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('unprocessable');
		expect(error.status).toBe(422);
		// A rewritten upstream history is never pushed over the member's branch: one
		// call, refused, and no second attempt with a wider force value.
		expect(updateRefMock).toHaveBeenCalledTimes(1);
	});

	it('classifies a 409 as conflict', async () => {
		updateRefMock.mockRejectedValue(statusError(409, 'Conflict'));

		await expect(
			svc.updateBranchRef(FORK_OWNER, FORK_REPO, SYNC_BRANCH, UPSTREAM_HEAD_SHA, { force: false }, TOKEN)
		).rejects.toMatchObject({ reason: 'conflict', status: 409 });
	});
});

describe('GitHubApiService — the whole suite made no force-move', () => {
	/**
	 * Declared LAST on purpose: vitest runs a file's tests in order, so by the time
	 * this runs every request the suite issued is in `allRequests`.
	 */
	it('no request in this file carried force: true', () => {
		expect(allRequests.length).toBeGreaterThan(5);
		expect(allRequests.filter((request) => carriesForceTrue(request))).toEqual([]);
	});
});
