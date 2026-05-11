import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const transferMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				transfer: transferMock
			}
		};
		constructor(public opts: unknown) {}
	}
	return {
		Octokit: FakeOctokit,
		RequestError: class RequestError extends Error {}
	};
});

const { GitHubApiService } = await import('../github-api.service.js');

describe('GitHubApiService.transferRepository', () => {
	let svc: InstanceType<typeof GitHubApiService>;

	beforeEach(() => {
		svc = new GitHubApiService();
		transferMock.mockReset();
		transferMock.mockResolvedValue({ data: {} });
	});

	it('invokes octokit.rest.repos.transfer with mapped args', async () => {
		await svc.transferRepository(
			'ever-works',
			'awesome-go-data',
			{ newOwner: 'avelino' },
			'ghp_secret'
		);
		expect(transferMock).toHaveBeenCalledTimes(1);
		expect(transferMock).toHaveBeenCalledWith({
			owner: 'ever-works',
			repo: 'awesome-go-data',
			new_owner: 'avelino'
		});
	});

	it('forwards team_ids when provided', async () => {
		await svc.transferRepository(
			'ever-works',
			'awesome-go-data',
			{ newOwner: 'avelino-org', teamIds: [42, 99] },
			'ghp_secret'
		);
		expect(transferMock).toHaveBeenCalledWith(
			expect.objectContaining({ team_ids: [42, 99] })
		);
	});

	it('omits team_ids when array is empty (matches GitHub API contract)', async () => {
		await svc.transferRepository(
			'ever-works',
			'awesome-go-data',
			{ newOwner: 'avelino', teamIds: [] },
			'ghp_secret'
		);
		const arg = transferMock.mock.calls[0][0];
		expect(arg).not.toHaveProperty('team_ids');
	});

	it('returns pending_recipient_acceptance + providerAcceptanceUrl', async () => {
		const result = await svc.transferRepository(
			'ever-works',
			'awesome-go-data',
			{ newOwner: 'avelino' },
			'ghp_secret'
		);
		expect(result.status).toBe('pending_recipient_acceptance');
		expect(result.providerAcceptanceUrl).toBe('https://github.com/avelino');
		expect(result.newRepository).toBeUndefined();
	});

	it('propagates errors thrown by octokit (e.g., 404, permission)', async () => {
		transferMock.mockRejectedValueOnce(new Error('Not Found'));
		await expect(
			svc.transferRepository('a', 'b', { newOwner: 'c' }, 'tok')
		).rejects.toThrow('Not Found');
	});
});
