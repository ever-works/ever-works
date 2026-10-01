import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitProviderRequestError } from '@ever-works/plugin/git';

/**
 * APW-09 T1 + T2 — the GitHub provider half of upstream pull requests
 * (plan §3.3/§4, ACC-09-14 provider half).
 *
 * T1: cross-repository pull request fields.
 *   • `CreatePROptions.headOwner` / `headRepo` / `maintainerCanModify` compose
 *     the create request, and a call that passes NONE of them sends exactly the
 *     request this method sent before the fields existed — the omission half is
 *     the half that keeps every existing caller safe.
 *   • `headRepoFullName` is mapped on all four reads, `null` when the head
 *     repository was deleted (a real answer, not an omission).
 *   • `ListPullRequestsOptions.head` reaches GitHub only when set.
 *   • `totalCommits` comes from the compare's `total_commits` — and from the
 *     pull request itself for the file-list-backed `getPullRequestDiff`, which
 *     `pulls.listFiles` cannot answer.
 *
 * T2: reviews, review comments and the interaction limit.
 *   • `pulls.listReviews` / `pulls.listReviewComments`, one bounded page, bodies
 *     capped where they enter the platform (8 KB / 4 KB).
 *   • All five review states, `dismissed` and `pending` included and NOT folded
 *     into `commented` — the review summary APW-09 derives depends on the
 *     difference.
 *   • `interactions.getRestrictionsForRepo`: 404 **and** 403 answer `null`,
 *     never `'none'` (G16). A provider that cannot tell must not be reported as
 *     "no limit", and an empty (204) answer is "cannot tell" too.
 *
 * Octokit is mocked exactly as the sibling `github-api.service.*.spec.ts` suites
 * do, so nothing here can reach the network — and the last test in the file
 * asserts that no request the whole suite issued carried `force: true`, which is
 * the fast-forward-only half of APW-09's branch-ref move (T3, whose
 * implementation landed under APW-02 and is pinned from the upstream side here).
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const pullsCreateMock = vi.fn();
const pullsGetMock = vi.fn();
const pullsListMock = vi.fn();
const pullsListFilesMock = vi.fn();
const pullsListReviewsMock = vi.fn();
const pullsListReviewCommentsMock = vi.fn();
const compareMock = vi.fn();
const getRestrictionsForRepoMock = vi.fn();
const checksListForRefMock = vi.fn();
const listCommitStatusesMock = vi.fn();
const updateRefMock = vi.fn();
const createRefMock = vi.fn();

/** Every request the suite issued, across every test (see the last test). */
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
			pulls: {
				create: (...args: unknown[]) => {
					record(args);
					return pullsCreateMock(...args);
				},
				get: (...args: unknown[]) => {
					record(args);
					return pullsGetMock(...args);
				},
				list: (...args: unknown[]) => {
					record(args);
					return pullsListMock(...args);
				},
				listFiles: (...args: unknown[]) => {
					record(args);
					return pullsListFilesMock(...args);
				},
				listReviews: (...args: unknown[]) => {
					record(args);
					return pullsListReviewsMock(...args);
				},
				listReviewComments: (...args: unknown[]) => {
					record(args);
					return pullsListReviewCommentsMock(...args);
				}
			},
			repos: {
				compareCommitsWithBasehead: (...args: unknown[]) => {
					record(args);
					return compareMock(...args);
				},
				listCommitStatusesForRef: (...args: unknown[]) => {
					record(args);
					return listCommitStatusesMock(...args);
				}
			},
			checks: {
				listForRef: (...args: unknown[]) => {
					record(args);
					return checksListForRefMock(...args);
				}
			},
			interactions: {
				getRestrictionsForRepo: (...args: unknown[]) => {
					record(args);
					return getRestrictionsForRepoMock(...args);
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

const UPSTREAM_OWNER = 'upstream';
const UPSTREAM_REPO = 'project';
const FORK_OWNER = 'member';
const FORK_REPO = 'project';
const BRANCH = 'upstream-pr/widgets-1a2b';
const TOKEN = 'gho_member_token';
const HEAD_SHA = '1111111111111111111111111111111111111111';
const FORK_HEAD_SHA = '2222222222222222222222222222222222222222';

/** A GitHub status error, shaped the way Octokit raises one. */
function statusError(status: number, message: string, headers: Record<string, string | number> = {}): Error {
	const ctor = RequestError as unknown as new (message: string) => Error;
	const error = new ctor(message);
	const shaped = error as Error & { status?: number; response?: unknown };
	shaped.status = status;
	shaped.response = { data: { message }, headers };
	return error;
}

/** The subset of a pull-request payload every read here maps. */
function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number: 41,
		title: 'Fix the widget',
		state: 'open',
		draft: false,
		merged: false,
		merged_at: null,
		mergeable: true,
		html_url: `https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pull/41`,
		created_at: '2026-09-17T09:00:00Z',
		updated_at: '2026-09-17T10:00:00Z',
		body: 'body',
		user: { login: FORK_OWNER, type: 'User' },
		head: { ref: BRANCH, sha: FORK_HEAD_SHA, repo: { full_name: `${FORK_OWNER}/${FORK_REPO}` } },
		base: { ref: 'main' },
		...overrides
	};
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
	vi.clearAllMocks();
	// `allRequests` is deliberately NOT cleared: it is this file's history, and
	// the last test reads it to prove no request ever carried `force: true`.
	svc = new GitHubApiService();
	pullsCreateMock.mockResolvedValue({ data: prPayload() });
	pullsGetMock.mockResolvedValue({ data: prPayload() });
	pullsListMock.mockResolvedValue({ data: [prPayload()] });
	pullsListFilesMock.mockResolvedValue({ data: [] });
	pullsListReviewsMock.mockResolvedValue({ data: [] });
	pullsListReviewCommentsMock.mockResolvedValue({ data: [] });
	compareMock.mockResolvedValue({ data: { files: [], total_commits: 1 } });
	getRestrictionsForRepoMock.mockResolvedValue({ status: 200, data: { limit: 'contributors_only' } });
	checksListForRefMock.mockResolvedValue({ data: { check_runs: [], total_count: 0 } });
	listCommitStatusesMock.mockResolvedValue({ data: [] });
	updateRefMock.mockResolvedValue({ data: { ref: `refs/heads/${BRANCH}`, object: { sha: HEAD_SHA } } });
	createRefMock.mockResolvedValue({ data: { ref: `refs/heads/${BRANCH}`, object: { sha: HEAD_SHA } } });
});

// ── T1: the create request ───────────────────────────────────────────────────

describe('GitHubApiService.createPullRequest — the cross-repository head (APW-09 T1)', () => {
	it('composes head as owner:branch, sends maintainer_can_modify, and omits head_repo for a cross-owner head', async () => {
		await svc.createPullRequest(
			{
				owner: UPSTREAM_OWNER,
				repo: UPSTREAM_REPO,
				title: 'Fix the widget',
				head: BRANCH,
				base: 'main',
				headOwner: FORK_OWNER,
				headRepo: FORK_REPO,
				maintainerCanModify: true
			},
			TOKEN
		);

		const request = pullsCreateMock.mock.calls[0][0] as Record<string, unknown>;
		expect(request.head).toBe(`${FORK_OWNER}:${BRANCH}`);
		expect(request.maintainer_can_modify).toBe(true);
		// The head owner differs from the base owner, so GitHub resolves the head
		// repository from `head` itself and `head_repo` is NOT sent (plan §4).
		expect(request).not.toHaveProperty('head_repo');
	});

	it('sends head_repo only when the head shares the base owner (G23)', async () => {
		await svc.createPullRequest(
			{
				owner: UPSTREAM_OWNER,
				repo: UPSTREAM_REPO,
				title: 'Fix the widget',
				head: BRANCH,
				base: 'main',
				headOwner: UPSTREAM_OWNER,
				headRepo: 'project-fork',
				maintainerCanModify: false
			},
			TOKEN
		);

		const request = pullsCreateMock.mock.calls[0][0] as Record<string, unknown>;
		expect(request.head).toBe(`${UPSTREAM_OWNER}:${BRANCH}`);
		expect(request.head_repo).toBe('project-fork');
		// `false` is a choice the member made; it is SENT, not dropped as falsy.
		expect(request.maintainer_can_modify).toBe(false);
	});

	it('a call without the new fields sends exactly the request it sent before them', async () => {
		await svc.createPullRequest(
			{ owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO, title: 'Fix the widget', head: BRANCH, base: 'main' },
			TOKEN
		);

		const request = pullsCreateMock.mock.calls[0][0] as Record<string, unknown>;
		expect(request.head).toBe(BRANCH);
		expect(request).not.toHaveProperty('head_repo');
		expect(request).not.toHaveProperty('maintainer_can_modify');
		expect(request.body).toBe(`Pull request from ${BRANCH} to main`);
		expect(request.draft).toBe(false);
	});

	it('maps headRepoFullName from the head repository', async () => {
		const pr = await svc.createPullRequest(
			{
				owner: UPSTREAM_OWNER,
				repo: UPSTREAM_REPO,
				title: 'Fix the widget',
				head: BRANCH,
				base: 'main',
				headOwner: FORK_OWNER
			},
			TOKEN
		);

		expect(pr.headRepoFullName).toBe(`${FORK_OWNER}/${FORK_REPO}`);
	});
});

// ── T1: the four reads ──────────────────────────────────────────────────────

describe('GitHubApiService — headRepoFullName on every read (APW-09 T1)', () => {
	it('maps it on getPullRequest, listPullRequests and getPullRequestStatus alike', async () => {
		const single = await svc.getPullRequest(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);
		const listed = await svc.listPullRequests(UPSTREAM_OWNER, UPSTREAM_REPO, { state: 'all' }, TOKEN);
		const status = await svc.getPullRequestStatus(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(single?.headRepoFullName).toBe(`${FORK_OWNER}/${FORK_REPO}`);
		expect(listed[0].headRepoFullName).toBe(`${FORK_OWNER}/${FORK_REPO}`);
		expect(status?.headRepoFullName).toBe(`${FORK_OWNER}/${FORK_REPO}`);
	});

	it('answers null — never undefined — when the head repository was deleted', async () => {
		// GitHub sends `head.repo: null` once the fork is gone; "the head
		// repository is gone" is a fact APW-09 tracks, not an absent field.
		pullsGetMock.mockResolvedValue({ data: prPayload({ head: { ref: BRANCH, repo: null } }) });

		const pr = await svc.getPullRequest(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(pr?.headRepoFullName).toBeNull();
		expect(pr).toHaveProperty('headRepoFullName');
	});
});

describe('GitHubApiService.listPullRequests — the head filter (APW-09 T1, G17)', () => {
	it('passes head through when set', async () => {
		await svc.listPullRequests(
			UPSTREAM_OWNER,
			UPSTREAM_REPO,
			{ state: 'all', head: `${FORK_OWNER}:${BRANCH}` },
			TOKEN
		);

		expect(pullsListMock).toHaveBeenCalledWith(
			expect.objectContaining({ head: `${FORK_OWNER}:${BRANCH}`, state: 'all' })
		);
	});

	it('omits head for an ordinary list', async () => {
		await svc.listPullRequests(UPSTREAM_OWNER, UPSTREAM_REPO, { state: 'open' }, TOKEN);

		expect(pullsListMock.mock.calls[0][0]).not.toHaveProperty('head');
	});
});

// ── T1: the commit count ────────────────────────────────────────────────────

describe('GitHubApiService — totalCommits (APW-09 T1, G13)', () => {
	it('maps the compare total_commits', async () => {
		compareMock.mockResolvedValue({ data: { files: [], total_commits: 3 } });

		const diff = await svc.getCompareDiff(
			UPSTREAM_OWNER,
			UPSTREAM_REPO,
			'main',
			`${FORK_OWNER}:${BRANCH}`,
			{},
			TOKEN
		);

		expect(diff.totalCommits).toBe(3);
	});

	it('omits totalCommits — never zero — when the compare does not report one', async () => {
		compareMock.mockResolvedValue({ data: { files: [] } });

		const diff = await svc.getCompareDiff(UPSTREAM_OWNER, UPSTREAM_REPO, 'main', BRANCH, {}, TOKEN);

		// Absence is meaningful: "this read did not report a commit count".
		expect(diff.totalCommits).toBeUndefined();
		expect(diff).not.toHaveProperty('totalCommits');
	});

	it('reports the pull request commit count on getPullRequestDiff, where the file list cannot', async () => {
		pullsListFilesMock.mockResolvedValue({
			data: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@' }]
		});
		pullsGetMock.mockResolvedValue({ data: prPayload({ commits: 4 }) });

		const diff = await svc.getPullRequestDiff(UPSTREAM_OWNER, UPSTREAM_REPO, 41, {}, TOKEN);

		expect(diff.totalCommits).toBe(4);
		expect(diff.totalFiles).toBe(1);
	});

	it('returns the diff without a count when that read fails — the count is advisory here', async () => {
		pullsListFilesMock.mockResolvedValue({
			data: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@' }]
		});
		pullsGetMock.mockRejectedValue(statusError(404, 'Not Found'));

		const diff = await svc.getPullRequestDiff(UPSTREAM_OWNER, UPSTREAM_REPO, 41, {}, TOKEN);

		expect(diff.totalFiles).toBe(1);
		expect(diff.totalCommits).toBeUndefined();
	});
});

// ── T2: reviews ─────────────────────────────────────────────────────────────

describe('GitHubApiService.listPullRequestReviews (APW-09 T2)', () => {
	it('maps all five review states, dismissed and pending included', async () => {
		pullsListReviewsMock.mockResolvedValue({
			data: [
				{ id: 1, state: 'APPROVED', body: 'lgtm', submitted_at: '2026-09-17T10:00:00Z', user: { login: 'a' } },
				{
					id: 2,
					state: 'CHANGES_REQUESTED',
					body: 'please split this',
					submitted_at: '2026-09-17T10:01:00Z',
					user: { login: 'b' }
				},
				{
					id: 3,
					state: 'COMMENTED',
					body: 'a note',
					submitted_at: '2026-09-17T10:02:00Z',
					user: { login: 'c' }
				},
				{
					id: 4,
					state: 'DISMISSED',
					body: 'stale',
					submitted_at: '2026-09-17T10:03:00Z',
					user: { login: 'd' }
				},
				{ id: 5, state: 'PENDING', body: '', submitted_at: null, user: { login: 'e' } }
			]
		});

		const reviews = await svc.listPullRequestReviews(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(reviews.map((review) => review.state)).toEqual([
			'approved',
			'changes_requested',
			'commented',
			'dismissed',
			'pending'
		]);
		// `dismissed` and `pending` must not have been folded into `commented`.
		expect(reviews[3].state).not.toBe('commented');
		expect(reviews[4].state).not.toBe('commented');
		expect(reviews[4].submittedAt).toBeNull();
		expect(reviews.map((review) => review.author)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('keeps the id a number and degrades a missing author or body', async () => {
		pullsListReviewsMock.mockResolvedValue({
			data: [{ id: 77, state: 'COMMENTED', body: null, submitted_at: null, user: null }]
		});

		const [review] = await svc.listPullRequestReviews(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(review.id).toBe(77);
		expect(typeof review.id).toBe('number');
		expect(review.author).toBeNull();
		expect(review.body).toBe('');
	});

	it('reads one page of at most 100 and never returns more', async () => {
		const many = Array.from({ length: 150 }, (_, index) => ({
			id: index + 1,
			state: 'COMMENTED',
			body: 'x',
			submitted_at: null,
			user: { login: 'a' }
		}));
		pullsListReviewsMock.mockResolvedValue({ data: many });

		const reviews = await svc.listPullRequestReviews(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(pullsListReviewsMock).toHaveBeenCalledWith(expect.objectContaining({ per_page: 100, pull_number: 41 }));
		expect(reviews).toHaveLength(100);
	});

	it('caps a review body at 8 KB, visibly', async () => {
		pullsListReviewsMock.mockResolvedValue({
			data: [{ id: 1, state: 'COMMENTED', body: 'x'.repeat(20 * 1024), submitted_at: null, user: { login: 'a' } }]
		});

		const [review] = await svc.listPullRequestReviews(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(new TextEncoder().encode(review.body).length).toBeLessThanOrEqual(8 * 1024);
		// A silently cut instruction is worse than a visibly cut one.
		expect(review.body.endsWith('…')).toBe(true);
	});

	it('raises the typed provider error on a failure, never an empty list', async () => {
		pullsListReviewsMock.mockRejectedValue(statusError(404, 'Not Found'));

		const error = await svc.listPullRequestReviews(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN).catch((err) => err);

		// "the read failed" and "nobody reviewed" must never collapse.
		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('not_found');
		expect(error.status).toBe(404);
	});

	it('names the permission a refused review read needed', async () => {
		pullsListReviewsMock.mockRejectedValue(statusError(403, 'Resource not accessible by personal access token'));

		const error = await svc.listPullRequestReviews(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN).catch((err) => err);

		// §4.2 attaches the hint to the `permission_missing` row only — and this
		// read's permission is `pull_requests`, not `contents`.
		expect(error.reason).toBe('permission_missing');
		expect(error.details.permission).toBe('pull_requests');
	});
});

// ── T2: review comments ─────────────────────────────────────────────────────

describe('GitHubApiService.listPullRequestReviewComments (APW-09 T2)', () => {
	it('maps the inline comment and sends the request once', async () => {
		pullsListReviewCommentsMock.mockResolvedValue({
			data: [
				{
					id: 9,
					body: 'this line',
					path: 'src/a.ts',
					line: 12,
					created_at: '2026-09-17T10:01:00Z',
					user: { login: 'reviewer-1' }
				}
			]
		});

		const comments = await svc.listPullRequestReviewComments(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(pullsListReviewCommentsMock).toHaveBeenCalledTimes(1);
		expect(pullsListReviewCommentsMock).toHaveBeenCalledWith(
			expect.objectContaining({ per_page: 100, pull_number: 41 })
		);
		expect(comments).toEqual([
			{
				id: 9,
				author: 'reviewer-1',
				body: 'this line',
				path: 'src/a.ts',
				line: 12,
				createdAt: '2026-09-17T10:01:00Z'
			}
		]);
	});

	it('answers null for a missing line rather than substituting the original one', async () => {
		// An outdated comment (the diff moved under it) or a file-level comment.
		pullsListReviewCommentsMock.mockResolvedValue({
			data: [
				{
					id: 10,
					body: 'anchored to an old commit',
					path: 'src/a.ts',
					line: null,
					original_line: 12,
					created_at: null,
					user: { login: 'reviewer-1' }
				}
			]
		});

		const [comment] = await svc.listPullRequestReviewComments(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		// Pointing an agent at `original_line` would send it to a line the
		// pull request no longer has.
		expect(comment.line).toBeNull();
		expect(comment.createdAt).toBeNull();
	});

	it('caps a comment body at 4 KB', async () => {
		pullsListReviewCommentsMock.mockResolvedValue({
			data: [
				{
					id: 11,
					body: 'y'.repeat(9 * 1024),
					path: 'src/a.ts',
					line: 3,
					created_at: null,
					user: { login: 'reviewer-1' }
				}
			]
		});

		const [comment] = await svc.listPullRequestReviewComments(UPSTREAM_OWNER, UPSTREAM_REPO, 41, TOKEN);

		expect(new TextEncoder().encode(comment.body).length).toBeLessThanOrEqual(4 * 1024);
		expect(comment.body.endsWith('…')).toBe(true);
	});
});

// ── T2: the interaction limit ───────────────────────────────────────────────

describe('GitHubApiService.getInteractionLimit (APW-09 T2, G16)', () => {
	it('forwards each of the four limits verbatim', async () => {
		for (const limit of ['none', 'existing_users', 'contributors_only', 'collaborators_only'] as const) {
			getRestrictionsForRepoMock.mockResolvedValueOnce({ status: 200, data: { limit } });

			await expect(svc.getInteractionLimit(UPSTREAM_OWNER, UPSTREAM_REPO, TOKEN)).resolves.toBe(limit);
		}

		expect(getRestrictionsForRepoMock).toHaveBeenCalledWith({ owner: UPSTREAM_OWNER, repo: UPSTREAM_REPO });
	});

	it('answers null on a 404 — the repository is invisible, which is not "no limit"', async () => {
		getRestrictionsForRepoMock.mockRejectedValue(statusError(404, 'Not Found'));

		const answer = await svc.getInteractionLimit(UPSTREAM_OWNER, UPSTREAM_REPO, TOKEN);

		expect(answer).toBeNull();
		expect(answer).not.toBe('none');
	});

	it('answers null on a 403 — a token without admin rights cannot tell either', async () => {
		getRestrictionsForRepoMock.mockRejectedValue(statusError(403, 'Must have admin rights to Repository.'));

		const answer = await svc.getInteractionLimit(UPSTREAM_OWNER, UPSTREAM_REPO, TOKEN);

		expect(answer).toBeNull();
		expect(answer).not.toBe('none');
	});

	it('answers null — never "none" — for an empty (204) answer', async () => {
		// GitHub answers 204 with no body when a repository has no TEMPORARY
		// limit. The plan reads "empty" as "cannot tell": `null` refuses nothing
		// new, while a fabricated `'none'` would clear a real restriction.
		getRestrictionsForRepoMock.mockResolvedValue({ status: 204, data: undefined });

		const answer = await svc.getInteractionLimit(UPSTREAM_OWNER, UPSTREAM_REPO, TOKEN);

		expect(answer).toBeNull();
		expect(answer).not.toBe('none');
	});

	it('answers null for a value it does not recognise, rather than guessing', async () => {
		getRestrictionsForRepoMock.mockResolvedValue({ status: 200, data: { limit: 'team_members_only' } });

		await expect(svc.getInteractionLimit(UPSTREAM_OWNER, UPSTREAM_REPO, TOKEN)).resolves.toBeNull();
	});

	it('throws on a broken read — a 500 is not an answer of "cannot tell"', async () => {
		getRestrictionsForRepoMock.mockRejectedValue(statusError(500, 'Server Error'));

		await expect(svc.getInteractionLimit(UPSTREAM_OWNER, UPSTREAM_REPO, TOKEN)).rejects.toThrow('Server Error');
	});
});

// ── T3 (landed under APW-02): the branch-ref move is fast-forward only ──────

describe('GitHubApiService.updateBranchRef — the typed non-fast-forward refusal', () => {
	it('surfaces a 422 not-a-fast-forward as the typed error, with no retry', async () => {
		updateRefMock.mockRejectedValue(statusError(422, 'Update is not a fast forward'));

		const error = await svc
			.updateBranchRef(FORK_OWNER, FORK_REPO, BRANCH, HEAD_SHA, { force: false }, TOKEN)
			.catch((err) => err);

		expect(error).toBeInstanceOf(GitProviderRequestError);
		expect(error.reason).toBe('unprocessable');
		expect(error.status).toBe(422);
		// Exactly one attempt: a rewritten history is never pushed over the
		// member's branch, and there is no second call with a wider force.
		expect(updateRefMock).toHaveBeenCalledTimes(1);
	});

	it('sends force: false even when an untyped caller asks for a force-move', async () => {
		await svc.updateBranchRef(
			FORK_OWNER,
			FORK_REPO,
			BRANCH,
			HEAD_SHA,
			{ force: true } as unknown as { force: false },
			TOKEN
		);

		expect(updateRefMock.mock.calls[0][0].force).toBe(false);
	});
});

describe('GitHubApiService — the whole suite made no force-move', () => {
	/**
	 * Declared LAST on purpose: vitest runs a file's tests in order, so every
	 * request this suite issued is recorded by the time this runs.
	 */
	it('no request in this file carried force: true', () => {
		expect(allRequests.length).toBeGreaterThan(10);
		expect(allRequests.filter((request) => carriesForceTrue(request))).toEqual([]);
	});
});
