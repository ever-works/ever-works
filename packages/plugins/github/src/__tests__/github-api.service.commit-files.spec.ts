/**
 * APW-03 T22 — `GitHubApiService.commitFiles`: one clone-free commit through the Git
 * Data API, fast-forward only, `nonFastForward` on a moved branch.
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

const git = {
	getRef: vi.fn(),
	getCommit: vi.fn(),
	createBlob: vi.fn(),
	createTree: vi.fn(),
	createCommit: vi.fn(),
	updateRef: vi.fn()
};

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

const BASE = 'b'.repeat(40);
const input = {
	branch: 'main',
	baseSha: BASE,
	message: 'chore(ever-works): record App source',
	files: [{ path: '.works/works.yml', content: 'kind: app\n', encoding: 'utf-8' as const }]
};

describe('GitHubApiService.commitFiles (APW-03 T22)', () => {
	let service: InstanceType<typeof GitHubApiService>;

	beforeEach(() => {
		vi.clearAllMocks();
		git.getRef.mockResolvedValue({ data: { object: { sha: BASE } } });
		git.getCommit.mockResolvedValue({ data: { tree: { sha: 'tree-base' } } });
		git.createBlob.mockResolvedValue({ data: { sha: 'blob-1' } });
		git.createTree.mockResolvedValue({ data: { sha: 'tree-new' } });
		git.createCommit.mockResolvedValue({ data: { sha: 'commit-new' } });
		git.updateRef.mockResolvedValue({ data: { object: { sha: 'commit-new' } } });
		service = new GitHubApiService();
	});

	it('lands blobs → tree on base_tree → commit → updateRef without force', async () => {
		await expect(service.commitFiles('o', 'r', input, 'tok')).resolves.toEqual({ commitSha: 'commit-new' });
		expect(git.createTree).toHaveBeenCalledWith(
			expect.objectContaining({
				base_tree: 'tree-base',
				tree: [{ path: '.works/works.yml', mode: '100644', type: 'blob', sha: 'blob-1' }]
			})
		);
		expect(git.createCommit).toHaveBeenCalledWith(expect.objectContaining({ parents: [BASE], tree: 'tree-new' }));
		expect(git.updateRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'heads/main', force: false }));
	});

	it('rejects nonFastForward and writes nothing when the branch moved', async () => {
		git.getRef.mockResolvedValue({ data: { object: { sha: 'c'.repeat(40) } } });
		await expect(service.commitFiles('o', 'r', input, 'tok')).rejects.toMatchObject({
			code: 'nonFastForward',
			reason: 'conflict'
		});
		expect(git.createBlob).not.toHaveBeenCalled();
	});

	it('maps a 422 from the ref update (a race) to nonFastForward', async () => {
		git.updateRef.mockRejectedValue(
			new (RequestError as unknown as new (m: string, s: number) => Error)('nf', 422)
		);
		await expect(service.commitFiles('o', 'r', input, 'tok')).rejects.toMatchObject({ code: 'nonFastForward' });
	});

	it('refuses a path that escapes the repository', async () => {
		await expect(
			service.commitFiles(
				'o',
				'r',
				{ ...input, files: [{ path: '../x', content: 'x', encoding: 'utf-8' }] },
				'tok'
			)
		).rejects.toMatchObject({ message: 'invalidPath' });
		expect(git.getRef).not.toHaveBeenCalled();
	});
});
