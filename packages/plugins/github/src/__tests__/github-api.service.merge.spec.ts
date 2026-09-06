/**
 * Merge approval (self-build slice AE, EW-805) — the head-SHA pin on
 * `GitHubApiService.mergePullRequest`.
 *
 * The pin is the ONLY thing that closes the window between "we checked
 * that this pull request is green and approved at commit X" and "we
 * merged it". Without `sha`, GitHub merges whatever the head is at the
 * instant the request lands, so a push arriving in that gap is merged in
 * place of the reviewed diff.
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

const pullsMergeMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			pulls: { merge: pullsMergeMock },
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

const OWNER = 'acme';
const REPO = 'widgets';
const PR = 7;
const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('GitHubApiService.mergePullRequest — head pin', () => {
	let service: InstanceType<typeof GitHubApiService>;

	beforeEach(() => {
		vi.clearAllMocks();
		pullsMergeMock.mockResolvedValue({
			data: { sha: 'merge-commit', merged: true, message: 'Pull Request successfully merged' }
		});
		service = new GitHubApiService();
	});

	it('sends `sha` when the caller pins an expected head', async () => {
		await service.mergePullRequest(OWNER, REPO, PR, { mergeMethod: 'squash', expectedHeadSha: HEAD }, 'tok');

		expect(pullsMergeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: OWNER,
				repo: REPO,
				pull_number: PR,
				merge_method: 'squash',
				sha: HEAD
			})
		);
	});

	it('omits `sha` entirely when no head is pinned — never sends undefined', async () => {
		// `sha: undefined` is not the same as no `sha`: an octokit request
		// with the key present serialises it, and a provider that reads it
		// as an empty string would refuse every merge.
		await service.mergePullRequest(OWNER, REPO, PR, { mergeMethod: 'squash' }, 'tok');
		expect('sha' in pullsMergeMock.mock.calls[0][0]).toBe(false);
	});

	it('omits `sha` when there are no merge options at all', async () => {
		await service.mergePullRequest(OWNER, REPO, PR, undefined, 'tok');
		expect('sha' in pullsMergeMock.mock.calls[0][0]).toBe(false);
		expect(pullsMergeMock.mock.calls[0][0].merge_method).toBe('merge');
	});

	it('surfaces the provider refusal when the head moved (409) rather than retrying', async () => {
		const { RequestError } = await import('octokit');
		pullsMergeMock.mockRejectedValue(
			new (RequestError as unknown as new (m: string, s: number) => Error)(
				'Head branch was modified. Review and try the merge again.',
				409
			)
		);

		await expect(
			service.mergePullRequest(OWNER, REPO, PR, { mergeMethod: 'squash', expectedHeadSha: HEAD }, 'tok')
		).rejects.toThrow(/Head branch was modified/);
	});

	it('passes the commit title and message through unchanged alongside the pin', async () => {
		await service.mergePullRequest(
			OWNER,
			REPO,
			PR,
			{
				commitTitle: 'Task T-42',
				commitMessage: 'Automated changes',
				mergeMethod: 'rebase',
				expectedHeadSha: HEAD
			},
			'tok'
		);
		expect(pullsMergeMock).toHaveBeenCalledWith(
			expect.objectContaining({
				commit_title: 'Task T-42',
				commit_message: 'Automated changes',
				merge_method: 'rebase',
				sha: HEAD
			})
		);
	});
});
