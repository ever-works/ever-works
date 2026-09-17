import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-02 P0 (Wave 0 PR 0.2) — the fork request must reuse an existing fork and must be able to
 * return immediately.
 *
 * Two defects are pinned here:
 *
 * 1. The old `forkRepository` only looked for an existing repository when the caller gave an
 *    explicit `name`, and never checked fork identity — so a second fork request for the same
 *    upstream either missed the existing fork entirely or mistook a same-named non-fork for it.
 * 2. The request held the caller for up to 24 × 5 s while the fork baked. `waitForReady: false`
 *    makes it answer with the create response and a `forkReadiness: 'pending'` marker, so a
 *    readiness poller can finish the job off the request thread.
 *
 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts` suites do.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const getAuthenticatedMock = vi.fn();
const reposGetMock = vi.fn();
const createForkMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			users: {
				getAuthenticated: (...args: unknown[]) => getAuthenticatedMock(...args)
			},
			repos: {
				get: (...args: unknown[]) => reposGetMock(...args),
				createFork: (...args: unknown[]) => createForkMock(...args)
			}
		};
		constructor(public opts: unknown) {}
	}
	return {
		Octokit: FakeOctokit,
		RequestError: class RequestError extends Error {
			status?: number;
		}
	};
});

const { RequestError } = await import('octokit');
const { GitHubApiService } = await import('../github-api.service.js');

const UPSTREAM_OWNER = 'acme';
const UPSTREAM_REPO = 'app';
const TARGET_OWNER = 'acme-user';

/** A repository payload with only the fields the fork path reads. */
function repositoryPayload(overrides: Record<string, unknown> = {}) {
	return {
		owner: { login: TARGET_OWNER },
		name: UPSTREAM_REPO,
		full_name: `${TARGET_OWNER}/${UPSTREAM_REPO}`,
		description: null,
		default_branch: 'main',
		private: false,
		html_url: `https://github.com/${TARGET_OWNER}/${UPSTREAM_REPO}`,
		clone_url: `https://github.com/${TARGET_OWNER}/${UPSTREAM_REPO}.git`,
		fork: true,
		parent: {
			owner: { login: UPSTREAM_OWNER },
			name: UPSTREAM_REPO,
			full_name: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`
		},
		...overrides
	};
}

function notFound(): InstanceType<typeof RequestError> {
	const error = new (RequestError as unknown as new (message: string) => Error)('Not Found');
	(error as Error & { status?: number }).status = 404;
	return error as InstanceType<typeof RequestError>;
}

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	getAuthenticatedMock.mockReset().mockResolvedValue({ data: { login: TARGET_OWNER } });
	reposGetMock.mockReset();
	createForkMock.mockReset().mockResolvedValue({ data: repositoryPayload() });
});

describe('GitHubApiService.forkRepository — existing fork reuse', () => {
	it('reuses an existing fork without requesting a new one', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload() });

		const result = await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, {}, 'ghp_secret');

		expect(createForkMock).not.toHaveBeenCalled();
		expect(result).not.toBeNull();
		expect(result!.fullName).toBe(`${TARGET_OWNER}/${UPSTREAM_REPO}`);
		// Already forked is a SUCCESS, and the copy is usable now.
		expect(result!.forkReadiness).toBe('ready');
		// The lookup is keyed on the fork target, not on the upstream.
		expect(reposGetMock.mock.calls[0][0]).toMatchObject({
			owner: TARGET_OWNER,
			repo: UPSTREAM_REPO
		});
	});

	it('honours an explicit name and organization for the lookup', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ owner: { login: 'acme-org' }, name: 'renamed' })
		});

		await svc.forkRepository(
			UPSTREAM_OWNER,
			UPSTREAM_REPO,
			{ name: 'renamed', organization: 'acme-org' },
			'ghp_secret'
		);

		expect(reposGetMock.mock.calls[0][0]).toMatchObject({
			owner: 'acme-org',
			repo: 'renamed'
		});
		expect(createForkMock).not.toHaveBeenCalled();
	});

	it('does NOT mistake a same-named non-fork for the fork, and forks anyway', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ fork: false, parent: null })
		});

		const result = await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, {}, 'ghp_secret');

		expect(createForkMock).toHaveBeenCalledTimes(1);
		expect(result!.fullName).toBe(`${TARGET_OWNER}/${UPSTREAM_REPO}`);
	});

	it('does NOT accept a fork of a different upstream', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({
				parent: { owner: { login: 'someone' }, name: 'else', full_name: 'someone/else' }
			})
		});

		await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, {}, 'ghp_secret');

		expect(createForkMock).toHaveBeenCalledTimes(1);
	});

	it('matches a fork of a fork through its source, and case-insensitively', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({
				source: { full_name: 'ACME/App' },
				parent: { owner: { login: 'someone' }, name: 'root', full_name: 'someone/root' }
			})
		});

		const result = await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, {}, 'ghp_secret');

		expect(createForkMock).not.toHaveBeenCalled();
		expect(result!.forkReadiness).toBe('ready');
	});

	it('forks when the target does not exist yet (404 is not an error)', async () => {
		// The lookup misses, the fork is created, and the readiness poll then finds it.
		reposGetMock.mockRejectedValueOnce(notFound()).mockResolvedValue({
			data: repositoryPayload()
		});

		const result = await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, {}, 'ghp_secret');

		expect(createForkMock).toHaveBeenCalledTimes(1);
		expect(result).not.toBeNull();
		expect(result!.forkReadiness).toBe('ready');
	});
});

describe('GitHubApiService.forkRepository — non-blocking requests', () => {
	it('waitForReady:false answers from the create response and never polls', async () => {
		// First (and only) lookup misses; any further repos.get would be the readiness poll.
		reposGetMock.mockRejectedValue(notFound());

		const started = Date.now();
		const result = await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, { waitForReady: false }, 'ghp_secret');
		const elapsed = Date.now() - started;

		expect(createForkMock).toHaveBeenCalledTimes(1);
		expect(createForkMock).toHaveBeenCalledWith({
			owner: UPSTREAM_OWNER,
			repo: UPSTREAM_REPO,
			name: undefined,
			organization: undefined,
			default_branch_only: undefined
		});
		// Exactly the pre-check lookup — no poll loop.
		expect(reposGetMock).toHaveBeenCalledTimes(1);
		expect(result!.forkReadiness).toBe('pending');
		expect(result!.fullName).toBe(`${TARGET_OWNER}/${UPSTREAM_REPO}`);
		// A pending answer is immediate: a poll loop would have slept 5 s per attempt.
		expect(elapsed).toBeLessThan(1000);
	});

	it('the default still waits for the fork to become readable', async () => {
		reposGetMock.mockRejectedValueOnce(notFound()).mockResolvedValue({
			data: repositoryPayload()
		});

		const result = await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, {}, 'ghp_secret');

		expect(createForkMock).toHaveBeenCalledTimes(1);
		// The pre-check, then the readiness poll.
		expect(reposGetMock.mock.calls.length).toBeGreaterThan(1);
		expect(result!.forkReadiness).toBe('ready');
	});
});
