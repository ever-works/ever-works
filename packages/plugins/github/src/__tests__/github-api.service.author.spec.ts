/**
 * Verifies that `GitHubApiService` populates `GitPullRequest.author`
 * (including the `orgVerified` flag) when listing or fetching PRs.
 * The C-11 community-PR gate in `@ever-works/agent` keys off this
 * field — see the 2026-05-17 security audit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const pullsListMock = vi.fn();
const pullsGetMock = vi.fn();
const pullsCreateMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			pulls: {
				list: pullsListMock,
				get: pullsGetMock,
				create: pullsCreateMock
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
	return {
		Octokit: FakeOctokit,
		RequestError: FakeRequestError
	};
});

const { GitHubApiService } = await import('../github-api.service.js');
const { GitHubVerifiedOrgService } = await import('../github-verified-org.service.js');

function basePrPayload(overrides: Record<string, unknown> = {}) {
	return {
		number: 42,
		title: 'Add a new tool',
		state: 'open',
		merged: false,
		merged_at: null,
		head: { ref: 'feat/new-tool' },
		base: { ref: 'main' },
		html_url: 'https://github.com/acme/repo/pull/42',
		created_at: '2026-05-08T00:00:00Z',
		updated_at: '2026-05-08T01:00:00Z',
		body: 'PR body',
		user: { login: 'octocat', type: 'User' },
		...overrides
	};
}

describe('GitHubApiService — PR author population', () => {
	let prevEnv: string | undefined;

	beforeEach(() => {
		prevEnv = process.env.COMMUNITY_PR_VERIFIED_ORGS;
		pullsListMock.mockReset();
		pullsGetMock.mockReset();
		pullsCreateMock.mockReset();
	});

	afterEach(() => {
		if (prevEnv === undefined) {
			delete process.env.COMMUNITY_PR_VERIFIED_ORGS;
		} else {
			process.env.COMMUNITY_PR_VERIFIED_ORGS = prevEnv;
		}
	});

	describe('listPullRequests', () => {
		it('populates author.username + author.type from pr.user', async () => {
			delete process.env.COMMUNITY_PR_VERIFIED_ORGS;
			pullsListMock.mockResolvedValueOnce({ data: [basePrPayload()] });

			const svc = new GitHubApiService();
			const prs = await svc.listPullRequests('acme', 'repo', undefined, 'tok');

			expect(prs).toHaveLength(1);
			expect(prs[0].author).toEqual({ username: 'octocat', type: 'User' });
			// orgVerified omitted when env var is unset.
			expect(prs[0].author?.orgVerified).toBeUndefined();
		});

		it('sets orgVerified=true when verified-org check confirms membership', async () => {
			process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works,ever-co';
			pullsListMock.mockResolvedValueOnce({ data: [basePrPayload()] });

			const verifiedOrgService = new GitHubVerifiedOrgService({
				createOctokit: () =>
					({
						rest: {
							orgs: {
								checkMembershipForUser: vi.fn().mockResolvedValueOnce({ status: 204 })
							}
						}
					}) as never
			});
			const svc = new GitHubApiService(verifiedOrgService);

			const prs = await svc.listPullRequests('acme', 'repo', undefined, 'tok');
			expect(prs[0].author?.orgVerified).toBe(true);
		});

		it('sets orgVerified=false when verified-org check fails for every configured org', async () => {
			process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works';
			pullsListMock.mockResolvedValueOnce({ data: [basePrPayload()] });

			const { RequestError } = (await import('octokit')) as unknown as {
				RequestError: new (m: string, s: number) => Error & { status: number };
			};
			const check = vi.fn().mockRejectedValueOnce(new RequestError('not a member', 404));
			const verifiedOrgService = new GitHubVerifiedOrgService({
				createOctokit: () =>
					({
						rest: { orgs: { checkMembershipForUser: check } }
					}) as never
			});
			const svc = new GitHubApiService(verifiedOrgService);

			const prs = await svc.listPullRequests('acme', 'repo', undefined, 'tok');
			expect(prs[0].author?.orgVerified).toBe(false);
		});

		it('does NOT mark orgVerified=true when the API returns 429 (defensive)', async () => {
			process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works';
			pullsListMock.mockResolvedValueOnce({ data: [basePrPayload()] });

			const { RequestError } = (await import('octokit')) as unknown as {
				RequestError: new (m: string, s: number) => Error & { status: number };
			};
			const check = vi.fn().mockRejectedValueOnce(new RequestError('rate limited', 429));
			const warn = vi.fn();
			const verifiedOrgService = new GitHubVerifiedOrgService({
				logger: { warn },
				createOctokit: () =>
					({
						rest: { orgs: { checkMembershipForUser: check } }
					}) as never
			});
			const svc = new GitHubApiService(verifiedOrgService);

			const prs = await svc.listPullRequests('acme', 'repo', undefined, 'tok');
			expect(prs[0].author?.orgVerified).toBe(false);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('429'));
		});

		it('omits author entirely when pr.user is null (ghost author)', async () => {
			delete process.env.COMMUNITY_PR_VERIFIED_ORGS;
			pullsListMock.mockResolvedValueOnce({ data: [basePrPayload({ user: null })] });

			const svc = new GitHubApiService();
			const prs = await svc.listPullRequests('acme', 'repo', undefined, 'tok');
			expect(prs[0].author).toBeUndefined();
		});

		it('reuses the cached verified-org result for a batch of PRs from the same author', async () => {
			process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works';
			pullsListMock.mockResolvedValueOnce({
				data: [
					basePrPayload({ number: 1 }),
					basePrPayload({ number: 2 }),
					basePrPayload({ number: 3 })
				]
			});

			const check = vi.fn().mockResolvedValueOnce({ status: 204 });
			const verifiedOrgService = new GitHubVerifiedOrgService({
				createOctokit: () =>
					({
						rest: { orgs: { checkMembershipForUser: check } }
					}) as never
			});
			const svc = new GitHubApiService(verifiedOrgService);

			const prs = await svc.listPullRequests('acme', 'repo', undefined, 'tok');
			expect(prs.every((p) => p.author?.orgVerified === true)).toBe(true);
			// Only ONE GitHub call despite 3 PRs from octocat.
			expect(check).toHaveBeenCalledTimes(1);
		});
	});

	describe('getPullRequest', () => {
		it('populates author on the single-PR endpoint too', async () => {
			delete process.env.COMMUNITY_PR_VERIFIED_ORGS;
			pullsGetMock.mockResolvedValueOnce({ data: basePrPayload() });

			const svc = new GitHubApiService();
			const pr = await svc.getPullRequest('acme', 'repo', 42, 'tok');
			expect(pr?.author).toEqual({ username: 'octocat', type: 'User' });
		});
	});

	describe('createPullRequest', () => {
		it('populates author on createPullRequest as well', async () => {
			delete process.env.COMMUNITY_PR_VERIFIED_ORGS;
			pullsCreateMock.mockResolvedValueOnce({ data: basePrPayload() });

			const svc = new GitHubApiService();
			const pr = await svc.createPullRequest(
				{ owner: 'acme', repo: 'repo', title: 't', head: 'feat', base: 'main' },
				'tok'
			);
			expect(pr.author).toEqual({ username: 'octocat', type: 'User' });
		});
	});
});
