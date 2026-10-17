/**
 * APW-03 T38 — `GitHubApiService.getRepositoryTree`: `git.getTree` with `recursive=1`,
 * the `maxEntries` cap, the truncation flag, submodules skipped, and a missing ref.
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

const git = { getTree: vi.fn() };

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = { git, orgs: { checkMembershipForUser: vi.fn() } };
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

const TREE = [
	{ path: 'LICENSE', type: 'blob', size: 1070 },
	{ path: 'ee', type: 'tree' },
	{ path: 'ee/a.ts', type: 'blob', size: 10 },
	{ path: 'vendor/lib', type: 'commit' }
];

describe('GitHubApiService.getRepositoryTree (APW-03 T38)', () => {
	let service: InstanceType<typeof GitHubApiService>;

	beforeEach(() => {
		vi.clearAllMocks();
		git.getTree.mockResolvedValue({ data: { tree: TREE, truncated: false } });
		service = new GitHubApiService();
	});

	it('lists recursively, maps blobs and trees, and skips submodules', async () => {
		const tree = await service.getRepositoryTree('o', 'r', 'sha-1', 'tok', { recursive: true, maxEntries: 100 });

		expect(git.getTree).toHaveBeenCalledWith({ owner: 'o', repo: 'r', tree_sha: 'sha-1', recursive: '1' });
		expect(tree).toEqual({
			entries: [
				{ path: 'LICENSE', type: 'blob', size: 1070 },
				{ path: 'ee', type: 'tree' },
				{ path: 'ee/a.ts', type: 'blob', size: 10 }
			],
			truncated: false
		});
	});

	it('omits `recursive` for a one-level listing', async () => {
		await service.getRepositoryTree('o', 'r', 'main', 'tok', { recursive: false, maxEntries: 100 });
		expect('recursive' in git.getTree.mock.calls[0][0]).toBe(false);
	});

	it('sets `truncated` when the cap cuts the listing', async () => {
		const tree = await service.getRepositoryTree('o', 'r', 'sha-1', 'tok', { recursive: true, maxEntries: 2 });
		expect(tree?.entries).toHaveLength(2);
		expect(tree?.truncated).toBe(true);
	});

	it('passes GitHub’s own truncation through', async () => {
		git.getTree.mockResolvedValue({ data: { tree: [TREE[0]], truncated: true } });
		const tree = await service.getRepositoryTree('o', 'r', 'sha-1', 'tok', { recursive: true, maxEntries: 100 });
		expect(tree?.truncated).toBe(true);
	});

	it('answers null for a ref that does not exist (404) or an empty repository (409)', async () => {
		const Err = RequestError as unknown as new (m: string, s: number) => Error;
		git.getTree.mockRejectedValueOnce(new Err('Not Found', 404));
		await expect(
			service.getRepositoryTree('o', 'r', 'nope', 'tok', { recursive: true, maxEntries: 1 })
		).resolves.toBeNull();
		git.getTree.mockRejectedValueOnce(new Err('Git Repository is empty.', 409));
		await expect(
			service.getRepositoryTree('o', 'r', 'main', 'tok', { recursive: true, maxEntries: 1 })
		).resolves.toBeNull();
	});
});
