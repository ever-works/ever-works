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
const listForksMock = vi.fn();
const graphqlMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			users: {
				getAuthenticated: (...args: unknown[]) => getAuthenticatedMock(...args)
			},
			repos: {
				get: (...args: unknown[]) => reposGetMock(...args),
				createFork: (...args: unknown[]) => createForkMock(...args),
				listForks: (...args: unknown[]) => listForksMock(...args)
			}
		};
		graphql = (...args: unknown[]) => graphqlMock(...args);
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

/** A matched fork under a DIFFERENT name — what a member who renamed their fork has. */
function renamedForkPayload(owner = TARGET_OWNER, name = 'renamed-app'): Record<string, unknown> {
	return repositoryPayload({
		owner: { login: owner },
		name,
		full_name: `${owner}/${name}`,
		html_url: `https://github.com/${owner}/${name}`,
		clone_url: `https://github.com/${owner}/${name}.git`
	});
}

/** One node of the GraphQL `forks` connection §4.3 asks for. */
function forkNode(login: string, name: string): { nameWithOwner: string; owner: { login: string } } {
	return { nameWithOwner: `${login}/${name}`, owner: { login } };
}

/** A `GET /repos/{o}/{r}/forks` row, with only the fields the lookup reads. */
function forkRow(login: string, name: string): { owner: { login: string }; name: string; full_name: string } {
	return { owner: { login }, name, full_name: `${login}/${name}` };
}

/** `n` forks, none of them the target's — used to fill a page so paging continues. */
function fullPageOfOtherForks(size = 100): ReturnType<typeof forkRow>[] {
	return Array.from({ length: size }, (_, index) => forkRow(`someone-${index}`, UPSTREAM_REPO));
}

const graphqlAnswer = (nodes: unknown[]) => ({ repository: { forks: { nodes } } });

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	getAuthenticatedMock.mockReset().mockResolvedValue({ data: { login: TARGET_OWNER } });
	reposGetMock.mockReset();
	createForkMock.mockReset().mockResolvedValue({ data: repositoryPayload() });
	// The pre-APW-02 suites in this file never reach steps 2 and 3; the defaults make
	// those steps answer "nothing there" instead of throwing a missing-method error.
	graphqlMock.mockReset().mockResolvedValue(graphqlAnswer([]));
	listForksMock.mockReset().mockResolvedValue({ data: [] });
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

/**
 * APW-02 T17 — the three-step lookup of plan §4.3.
 *
 * The method is a capability, not a private helper of the create path: APW-01's
 * inspect calls it per candidate owner and `forkRepository` calls it before every
 * create request (T52). What this file pins beyond the pre-existing same-name
 * check:
 *
 * 1. A fork the member RENAMED is found — step 1 cannot see it (a different name
 *    under the target owner), so step 2's GraphQL fork-network search has to.
 * 2. A GraphQL failure falls back to the REST fork listing, bounded at three
 *    pages, and a lookup that finds nothing answers `null` (never a throw).
 * 3. A fork owned by somebody else is never returned (ACC-02-03) — not by the
 *    GraphQL step, not by the REST step, and it is never even read.
 * 4. The request cost is asserted, not assumed: 1 REST + 1 GraphQL + 1 REST on
 *    the happy path, and never a fourth fork page.
 */
describe('GitHubApiService.findExistingFork — the three-step lookup (T17)', () => {
	it('finds a RENAMED fork through GraphQL: 1 REST + 1 GraphQL + 1 REST, no fork pages', async () => {
		reposGetMock
			// Step 1: the same-name check misses.
			.mockRejectedValueOnce(notFound())
			// Step 2: the fork the search named is read back over REST.
			.mockResolvedValueOnce({ data: renamedForkPayload() });
		graphqlMock.mockResolvedValue(
			graphqlAnswer([forkNode('someone-else', UPSTREAM_REPO), forkNode(TARGET_OWNER, 'renamed-app')])
		);

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result).not.toBeNull();
		expect(result!.fullName).toBe(`${TARGET_OWNER}/renamed-app`);
		// The identity check ran on the repository the provider returned.
		expect(result!.isFork).toBe(true);
		expect(result!.parent?.fullName).toBe(`${UPSTREAM_OWNER}/${UPSTREAM_REPO}`);

		// The exact argument set §4.3 pins, and nothing more.
		expect(graphqlMock).toHaveBeenCalledTimes(1);
		expect(graphqlMock.mock.calls[0][1]).toEqual({ owner: UPSTREAM_OWNER, name: UPSTREAM_REPO });
		expect(String(graphqlMock.mock.calls[0][0])).toContain(
			'forks(first: 100, affiliations: [OWNER, ORGANIZATION_MEMBER])'
		);

		// 1 REST (step 1) + 1 GraphQL (step 2) + 1 REST (reading the match) — and the
		// REST fork listing was never needed.
		expect(reposGetMock).toHaveBeenCalledTimes(2);
		expect(reposGetMock.mock.calls[1][0]).toMatchObject({ owner: TARGET_OWNER, repo: 'renamed-app' });
		expect(listForksMock).not.toHaveBeenCalled();
	});

	it('falls back to the REST fork listing when GraphQL fails', async () => {
		reposGetMock.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ data: renamedForkPayload() });
		graphqlMock.mockRejectedValue(new Error('GraphQL is not available on this server'));
		listForksMock.mockResolvedValue({
			data: [forkRow('someone-else', UPSTREAM_REPO), forkRow(TARGET_OWNER, 'renamed-app')]
		});

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result).not.toBeNull();
		expect(result!.fullName).toBe(`${TARGET_OWNER}/renamed-app`);
		expect(graphqlMock).toHaveBeenCalledTimes(1);
		// One page was enough: newest first, 100 per page.
		expect(listForksMock).toHaveBeenCalledTimes(1);
		expect(listForksMock.mock.calls[0][0]).toEqual({
			owner: UPSTREAM_OWNER,
			repo: UPSTREAM_REPO,
			sort: 'newest',
			per_page: 100,
			page: 1
		});
	});

	it('answers null when nothing is found, after at most three fork pages', async () => {
		reposGetMock.mockRejectedValue(notFound());
		graphqlMock.mockResolvedValue(graphqlAnswer([]));
		// Every page is FULL and holds only other owners' forks, so the lookup must
		// page on — and must stop at the third page rather than walk the network.
		listForksMock.mockResolvedValue({ data: fullPageOfOtherForks() });

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result).toBeNull();
		expect(listForksMock).toHaveBeenCalledTimes(3);
		expect(listForksMock.mock.calls.map((call) => call[0].page)).toEqual([1, 2, 3]);
		// Nothing was ever read back: no owner match existed to read.
		expect(reposGetMock).toHaveBeenCalledTimes(1);
	});

	it('ignores a match owned by another owner — GraphQL and REST alike (ACC-02-03)', async () => {
		reposGetMock.mockRejectedValue(notFound());
		// The GraphQL connection answers with somebody else's fork of the same upstream.
		graphqlMock.mockResolvedValue(graphqlAnswer([forkNode('someone-else', UPSTREAM_REPO)]));
		// …and so does the fork listing.
		listForksMock.mockResolvedValue({ data: [forkRow('someone-else', UPSTREAM_REPO)] });

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result).toBeNull();
		// The other owner's repository was never read, let alone returned: the only
		// REST read is step 1's same-name check.
		expect(reposGetMock).toHaveBeenCalledTimes(1);
		expect(reposGetMock.mock.calls[0][0]).toMatchObject({ owner: TARGET_OWNER, repo: UPSTREAM_REPO });
	});

	it('does not return a same-named repository that is not a fork of the upstream', async () => {
		// Step 1 finds a repository, but it is no fork at all — and the searches that
		// follow find nothing either.
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ fork: false, parent: null }) });

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result).toBeNull();
		// The identity check short-circuits nothing: a non-fork is still worth
		// searching for under another name.
		expect(graphqlMock).toHaveBeenCalledTimes(1);
	});

	it('rejects a search hit that is not a fork of THIS upstream', async () => {
		reposGetMock
			.mockRejectedValueOnce(notFound())
			// The GraphQL node names the target owner's repository, but the repository
			// itself belongs to another upstream's network.
			.mockResolvedValueOnce({
				data: repositoryPayload({
					owner: { login: TARGET_OWNER },
					name: 'renamed-app',
					full_name: `${TARGET_OWNER}/renamed-app`,
					parent: { owner: { login: 'someone' }, name: 'else', full_name: 'someone/else' },
					source: { full_name: 'someone/else' }
				})
			});
		graphqlMock.mockResolvedValue(graphqlAnswer([forkNode(TARGET_OWNER, 'renamed-app')]));

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result).toBeNull();
	});

	it('still answers null — never a throw — when both searches fail', async () => {
		reposGetMock.mockRejectedValueOnce(notFound()).mockRejectedValue(new Error('rate limited'));
		graphqlMock.mockRejectedValue(new Error('Bad credentials'));
		listForksMock.mockRejectedValue(new Error('rate limited'));

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result).toBeNull();
	});

	it('classifies a step-1 repository read that fails for any other reason', async () => {
		const forbidden = new (RequestError as unknown as new (message: string) => Error)(
			'Resource not accessible by integration'
		);
		(forbidden as Error & { status?: number }).status = 403;
		reposGetMock.mockRejectedValue(forbidden);

		await expect(
			svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret')
		).rejects.toMatchObject({ reason: 'permission_missing', status: 403, details: { permission: 'metadata' } });
	});

	it('answers with the reusable fork when step 1 already finds it, without searching', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload() });

		const result = await svc.findExistingFork(UPSTREAM_OWNER, UPSTREAM_REPO, TARGET_OWNER, 'ghp_secret');

		expect(result!.fullName).toBe(`${TARGET_OWNER}/${UPSTREAM_REPO}`);
		expect(reposGetMock).toHaveBeenCalledTimes(1);
		expect(graphqlMock).not.toHaveBeenCalled();
		expect(listForksMock).not.toHaveBeenCalled();
	});
});

describe('GitHubApiService.forkRepository — the lookup runs before every create request (T52)', () => {
	it('reuses a renamed fork instead of asking for a second one', async () => {
		reposGetMock.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ data: renamedForkPayload() });
		graphqlMock.mockResolvedValue(graphqlAnswer([forkNode(TARGET_OWNER, 'renamed-app')]));

		const result = await svc.forkRepository(UPSTREAM_OWNER, UPSTREAM_REPO, {}, 'ghp_secret');

		expect(createForkMock).not.toHaveBeenCalled();
		expect(result!.fullName).toBe(`${TARGET_OWNER}/renamed-app`);
		// An existing fork that step 2 found is just as usable now as one step 1 found.
		expect(result!.forkReadiness).toBe('ready');
	});
});
