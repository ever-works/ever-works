/**
 * APW-08 T8 — the two git-capability additions the App Works delivery chain reads:
 * `GitPullRequestStatus.mergeCommitSha` (GitHub `merge_commit_sha`) and
 * `isAncestorCommit` (`repos.compareCommitsWithBasehead`, `ahead|identical` → true,
 * `behind|diverged` → false, 404 → null). Stubbed Octokit, the same harness as
 * `github-api.service.pr-insights.spec.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const pullsGetMock = vi.fn();
const checksListForRefMock = vi.fn();
const listCommitStatusesMock = vi.fn();
const compareMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			pulls: { get: pullsGetMock, listFiles: vi.fn() },
			checks: { listForRef: checksListForRefMock },
			repos: {
				listCommitStatusesForRef: listCommitStatusesMock,
				compareCommitsWithBasehead: compareMock
			},
			orgs: { checkMembershipForUser: vi.fn() }
		};
		constructor(public opts: unknown) {}
	}
	class FakeRequestError extends Error {
		readonly status: number;
		constructor(message: string, status: number) {
			super(message);
			this.status = status;
		}
	}
	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { GitHubApiService } = await import('../github-api.service.js');
const { GitHubPlugin } = await import('../github.plugin.js');
const { RequestError } = await import('octokit');

const OWNER = 'acme';
const REPO = 'bookings';
const TOKEN = 'gh-token';
const MERGE_SHA = '3f9c2ab0000000000000000000000000000000aa';

function pull(overrides: Record<string, unknown>) {
	return {
		data: {
			number: 7,
			title: 'Fix the booking form',
			state: 'closed',
			draft: false,
			merged: true,
			merged_at: '2026-10-29T10:00:00Z',
			merge_commit_sha: MERGE_SHA,
			mergeable: null,
			html_url: `https://github.com/${OWNER}/${REPO}/pull/7`,
			head: { sha: 'feedface', ref: 'task/fix-form' },
			base: { ref: 'production' },
			...overrides
		}
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	checksListForRefMock.mockResolvedValue({ data: { check_runs: [] } });
	listCommitStatusesMock.mockResolvedValue({ data: [] });
});

describe('GitHubApiService — mergeCommitSha on getPullRequestStatus (APW-08 T8)', () => {
	it('reports the merge commit of a merged pull request', async () => {
		pullsGetMock.mockResolvedValue(pull({}));
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 7, TOKEN);
		expect(status?.state).toBe('merged');
		expect(status?.mergeCommitSha).toBe(MERGE_SHA);
		expect(status?.baseRef).toBe('production');
	});

	it('never reports the test-merge sha GitHub computes for an OPEN pull request', async () => {
		pullsGetMock.mockResolvedValue(
			pull({ state: 'open', merged: false, merged_at: null, merge_commit_sha: 'test-merge-sha' })
		);
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 7, TOKEN);
		expect(status?.state).toBe('open');
		expect(status?.mergeCommitSha).toBeNull();
	});

	it('is null for a merged pull request GitHub reports without one', async () => {
		pullsGetMock.mockResolvedValue(pull({ merge_commit_sha: null }));
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 7, TOKEN);
		expect(status?.mergeCommitSha).toBeNull();
	});
});

describe('GitHubApiService — isAncestorCommit (APW-08 T8)', () => {
	it.each([
		['identical', true],
		['ahead', true],
		['behind', false],
		['diverged', false]
	])('maps a %s comparison to %s', async (status, expected) => {
		compareMock.mockResolvedValue({ data: { status, files: [] } });
		const answer = await new GitHubApiService().isAncestorCommit(OWNER, REPO, MERGE_SHA, 'later', TOKEN);
		expect(answer).toBe(expected);
		expect(compareMock).toHaveBeenCalledWith({
			owner: OWNER,
			repo: REPO,
			basehead: `${MERGE_SHA}...later`,
			per_page: 1
		});
	});

	it('answers null (cannot say) when either commit is unknown — a 404', async () => {
		compareMock.mockRejectedValue(new RequestError('Not Found', 404, {} as never));
		const answer = await new GitHubApiService().isAncestorCommit(OWNER, REPO, MERGE_SHA, 'gone', TOKEN);
		expect(answer).toBeNull();
	});

	it('throws on any other failure — a broken read is never "not an ancestor"', async () => {
		compareMock.mockRejectedValue(new RequestError('Server Error', 500, {} as never));
		await expect(
			new GitHubApiService().isAncestorCommit(OWNER, REPO, MERGE_SHA, 'later', TOKEN)
		).rejects.toThrow('Server Error');
	});

	it('is delegated by the plugin class, so the lazy proxy sees it', () => {
		expect(typeof (GitHubPlugin.prototype as { isAncestorCommit?: unknown }).isAncestorCommit).toBe(
			'function'
		);
	});
});
