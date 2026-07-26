/**
 * PR insights (kanban run cockpit M5/M6) — `GitHubApiService`
 * implementation of `getPullRequestStatus` / `getPullRequestDiff` /
 * `getCompareDiff`, plus the shared contract conformance suite run
 * against the real service with a stubbed Octokit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runGitPrInsightsContractSuite } from '@ever-works/plugin/contracts-conformance';

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const pullsGetMock = vi.fn();
const pullsListFilesMock = vi.fn();
const checksListForRefMock = vi.fn();
const listCommitStatusesMock = vi.fn();
const compareMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			pulls: {
				get: pullsGetMock,
				listFiles: pullsListFilesMock
			},
			checks: {
				listForRef: checksListForRefMock
			},
			repos: {
				listCommitStatusesForRef: listCommitStatusesMock,
				compareCommitsWithBasehead: compareMock
			},
			orgs: {
				checkMembershipForUser: vi.fn()
			}
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
const { RequestError } = await import('octokit');

const OWNER = 'acme';
const REPO = 'widgets';
const TOKEN = 'gh-token';

const FILES = [
	{
		filename: 'src/a.ts',
		status: 'modified',
		additions: 4,
		deletions: 1,
		patch: '@@ -1 +1 @@\n-a\n+b\n'
	},
	{
		filename: 'src/b.ts',
		status: 'added',
		additions: 9,
		deletions: 0,
		patch: '@@ -0,0 +1 @@\n+new\n'
	},
	{ filename: 'assets/logo.png', status: 'added', additions: 0, deletions: 0 }
];

function seedHappyPath() {
	pullsGetMock.mockImplementation(async ({ pull_number }: { pull_number: number }) => {
		if (pull_number === 4041) throw new RequestError('Not Found', 404, {} as never);
		return {
			data: {
				number: pull_number,
				title: 'Task t-1: do the thing',
				state: 'open',
				draft: false,
				merged: false,
				merged_at: null,
				mergeable: true,
				html_url: `https://github.com/${OWNER}/${REPO}/pull/${pull_number}`,
				head: { sha: 'deadbeefcafe' },
				base: { ref: 'main' }
			}
		};
	});
	checksListForRefMock.mockResolvedValue({
		data: {
			check_runs: [
				{
					name: 'build',
					status: 'completed',
					conclusion: 'success',
					details_url: 'https://ci.invalid/build'
				},
				{ name: 'lint', status: 'in_progress', conclusion: null, details_url: null }
			]
		}
	});
	listCommitStatusesMock.mockResolvedValue({ data: [] });
	pullsListFilesMock.mockResolvedValue({ data: FILES });
	compareMock.mockResolvedValue({ data: { files: FILES } });
}

beforeEach(() => {
	vi.clearAllMocks();
	seedHappyPath();
});

describe('GitHubApiService — getPullRequestStatus', () => {
	it('maps an open PR with a running check to a pending CI state', async () => {
		const svc = new GitHubApiService();
		const status = await svc.getPullRequestStatus(OWNER, REPO, 41, TOKEN);

		expect(status).not.toBeNull();
		expect(status!.state).toBe('open');
		expect(status!.merged).toBe(false);
		expect(status!.headSha).toBe('deadbeefcafe');
		expect(status!.ciState).toBe('pending');
		expect(status!.checks.map((c) => c.name)).toEqual(['build', 'lint']);
		expect(status!.checks[0].detailsUrl).toBe('https://ci.invalid/build');
	});

	it('reports `merged` when the PR landed', async () => {
		pullsGetMock.mockResolvedValueOnce({
			data: {
				number: 41,
				title: 't',
				state: 'closed',
				draft: false,
				merged: true,
				merged_at: '2026-07-25T00:00:00Z',
				mergeable: null,
				html_url: 'https://github.com/acme/widgets/pull/41',
				head: { sha: 'abc' },
				base: { ref: 'main' }
			}
		});
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 41, TOKEN);
		expect(status!.state).toBe('merged');
		expect(status!.merged).toBe(true);
	});

	it('reports `draft` separately from `open`', async () => {
		pullsGetMock.mockResolvedValueOnce({
			data: {
				number: 41,
				title: 't',
				state: 'open',
				draft: true,
				merged: false,
				merged_at: null,
				mergeable: true,
				html_url: 'u',
				head: { sha: 'abc' },
				base: { ref: 'main' }
			}
		});
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 41, TOKEN);
		expect(status!.state).toBe('draft');
	});

	it('returns null for a missing PR instead of throwing', async () => {
		await expect(new GitHubApiService().getPullRequestStatus(OWNER, REPO, 4041, TOKEN)).resolves.toBeNull();
	});

	it('degrades to no-checks when the Checks API is not readable', async () => {
		checksListForRefMock.mockRejectedValueOnce(new Error('Resource not accessible'));
		listCommitStatusesMock.mockResolvedValueOnce({ data: [] });
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 41, TOKEN);
		expect(status!.ciState).toBe('unknown');
		expect(status!.checks).toEqual([]);
	});

	it('folds legacy commit statuses in and keeps only the newest per context', async () => {
		checksListForRefMock.mockResolvedValueOnce({ data: { check_runs: [] } });
		listCommitStatusesMock.mockResolvedValueOnce({
			data: [
				{ context: 'ci/external', state: 'success', target_url: 'https://ci.invalid/2' },
				{ context: 'ci/external', state: 'failure', target_url: 'https://ci.invalid/1' }
			]
		});
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 41, TOKEN);
		expect(status!.checks).toHaveLength(1);
		expect(status!.checks[0].conclusion).toBe('success');
		expect(status!.ciState).toBe('passing');
	});

	it('reds the dot when any check failed', async () => {
		checksListForRefMock.mockResolvedValueOnce({
			data: {
				check_runs: [
					{ name: 'build', status: 'completed', conclusion: 'success', details_url: null },
					{ name: 'test', status: 'completed', conclusion: 'failure', details_url: null }
				]
			}
		});
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 41, TOKEN);
		expect(status!.ciState).toBe('failing');
	});

	it('skips the checks reads entirely when the PR has no head sha', async () => {
		pullsGetMock.mockResolvedValueOnce({
			data: {
				number: 41,
				title: 't',
				state: 'open',
				draft: false,
				merged: false,
				merged_at: null,
				mergeable: null,
				html_url: 'u',
				head: {},
				base: { ref: 'main' }
			}
		});
		const status = await new GitHubApiService().getPullRequestStatus(OWNER, REPO, 41, TOKEN);
		expect(checksListForRefMock).not.toHaveBeenCalled();
		expect(status!.ciState).toBe('unknown');
	});
});

describe('GitHubApiService — diffs', () => {
	it('caps files at the request and reports the pre-cap total', async () => {
		const svc = new GitHubApiService();
		const diff = await svc.getPullRequestDiff(OWNER, REPO, 41, { maxFiles: 2 }, TOKEN);
		expect(diff.files).toHaveLength(2);
		expect(diff.totalFiles).toBe(3);
		expect(diff.truncated).toBe(true);
		// per_page is asked for maxFiles + 1 so truncation is provable.
		expect(pullsListFilesMock).toHaveBeenCalledWith(expect.objectContaining({ per_page: 3, pull_number: 41 }));
	});

	it('drops patch text past the byte budget but keeps the file rows', async () => {
		const diff = await new GitHubApiService().getPullRequestDiff(OWNER, REPO, 41, { maxBytes: 1 }, TOKEN);
		expect(diff.files).toHaveLength(3);
		expect(diff.files[0].patch).toBeUndefined();
		expect(diff.files[0].patchOmitted).toBe(true);
		expect(diff.patchBytes).toBe(0);
		expect(diff.truncated).toBe(true);
	});

	it('sums additions and deletions across the returned files', async () => {
		const diff = await new GitHubApiService().getPullRequestDiff(OWNER, REPO, 41, {}, TOKEN);
		expect(diff.totalAdditions).toBe(13);
		expect(diff.totalDeletions).toBe(1);
		expect(diff.truncated).toBe(false);
	});

	it('compares base...head for a branch with no PR', async () => {
		const diff = await new GitHubApiService().getCompareDiff(
			OWNER,
			REPO,
			'main',
			'task/t-1',
			{ maxFiles: 5 },
			TOKEN
		);
		expect(compareMock).toHaveBeenCalledWith(expect.objectContaining({ basehead: 'main...task/t-1' }));
		expect(diff.files).toHaveLength(3);
	});

	it('tolerates a compare response with no files array', async () => {
		compareMock.mockResolvedValueOnce({ data: {} });
		const diff = await new GitHubApiService().getCompareDiff(OWNER, REPO, 'main', 'task/t-1', undefined, TOKEN);
		expect(diff.files).toEqual([]);
		expect(diff.totalFiles).toBe(0);
	});
});

describe('GitHub git-provider — PR insights contract', () => {
	runGitPrInsightsContractSuite(() => new GitHubApiService(), {
		owner: OWNER,
		repo: REPO,
		token: TOKEN,
		prNumber: 41,
		missingPrNumber: 4041
	});
});
