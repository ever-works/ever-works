import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitProviderRequestError } from '@ever-works/plugin/git';

/**
 * APW-02 T16 — the repository facts `getRepository` maps (plan §4.3), plus the
 * typed failures it now raises (plan §4.2), pinned against the payloads GitHub
 * actually sends.
 *
 * Three things this file exists to keep true:
 *
 * 1. **Additive only.** A payload without a single new field still produces
 *    exactly the object `getRepository` produced before APW-02 — the same keys,
 *    nothing added, nothing removed. That is asserted by key set, not by spot
 *    checks, because an always-present `empty: undefined` would be invisible to a
 *    spot check and visible to every caller reading "reported" as "not reported".
 * 2. **Absent is not `false` / `0`.** `undefined` on a fact means the provider did
 *    not report it; `false` and `0` are claims. `empty` is computed from a
 *    `getBranch(default)` probe ONLY when `size === 0`, and the probe is never
 *    issued when the size is anything else — including unknown.
 * 3. **No raw provider error escapes.** A 404 stays `null` (pre-existing
 *    behaviour, unchanged); every other failure leaves as a
 *    `GitProviderRequestError`, with the reason plan §4.2 assigns.

 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts` suites
 * do, so nothing here can reach the network.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const reposGetMock = vi.fn();
const getBranchMock = vi.fn();
const listForOrgMock = vi.fn();
const listForAuthenticatedUserMock = vi.fn();

vi.mock('octokit', () => {
	class FakeRequestError extends Error {
		status?: number;
		response?: { data?: unknown; headers?: Record<string, string | number> };
	}

	class FakeOctokit {
		rest = {
			repos: {
				get: (...args: unknown[]) => reposGetMock(...args),
				getBranch: (...args: unknown[]) => getBranchMock(...args),
				listForOrg: (...args: unknown[]) => listForOrgMock(...args),
				listForAuthenticatedUser: (...args: unknown[]) => listForAuthenticatedUserMock(...args)
			}
		};
		constructor(public opts: unknown) {}
	}

	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { RequestError } = await import('octokit');
const { GitHubApiService } = await import('../github-api.service.js');

const OWNER = 'acme';
const REPO = 'app';

/** A GitHub status error, shaped the way Octokit raises one. */
function statusError(status: number, message: string, headers: Record<string, string | number> = {}): Error {
	const ctor = RequestError as unknown as new (message: string) => Error;
	const error = new ctor(message);
	const shaped = error as Error & { status?: number; response?: unknown };
	shaped.status = status;
	shaped.response = { data: { message }, headers };
	return error;
}

/**
 * A repository payload with every field of plan §4.3 present, so a test can drop
 * or change exactly the one it is about.
 */
function repositoryPayload(overrides: Record<string, unknown> = {}) {
	return {
		owner: { login: OWNER },
		name: REPO,
		full_name: `${OWNER}/${REPO}`,
		description: 'An app',
		default_branch: 'main',
		private: false,
		html_url: `https://github.com/${OWNER}/${REPO}`,
		clone_url: `https://github.com/${OWNER}/${REPO}.git`,
		fork: false,
		parent: null,
		permissions: { admin: true, push: true, pull: true },
		// The facts APW-02 adds (plan §4.3).
		source: null,
		allow_forking: true,
		archived: false,
		visibility: 'public',
		stargazers_count: 128,
		size: 4096,
		license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT', url: null, node_id: 'LICENSE' },
		...overrides
	};
}

/** The pre-APW-02 payload — the fields `getRepository` read before T16. */
function legacyRepositoryPayload() {
	return {
		owner: { login: OWNER },
		name: REPO,
		full_name: `${OWNER}/${REPO}`,
		description: null,
		default_branch: 'main',
		private: true,
		html_url: `https://github.com/${OWNER}/${REPO}`,
		clone_url: `https://github.com/${OWNER}/${REPO}.git`,
		fork: false,
		parent: null,
		permissions: undefined
	};
}

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	reposGetMock.mockReset();
	getBranchMock.mockReset();
	listForOrgMock.mockReset();
	listForAuthenticatedUserMock.mockReset();
	reposGetMock.mockResolvedValue({ data: repositoryPayload() });
	getBranchMock.mockRejectedValue(statusError(404, 'Branch not found'));
});

describe('APW-02 T16 — getRepository maps the repository facts (plan §4.3)', () => {
	it('maps every fact GitHub reports', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({
				fork: true,
				source: { owner: { login: 'ever-works' }, name: 'app', full_name: 'ever-works/app' },
				parent: { owner: { login: 'ever-works' }, name: 'app', full_name: 'ever-works/app' }
			})
		});

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(reposGetMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO });
		expect(result).toMatchObject({
			owner: OWNER,
			name: REPO,
			fullName: `${OWNER}/${REPO}`,
			defaultBranch: 'main',
			isPrivate: false,
			isFork: true,
			// The facts:
			source: { owner: 'ever-works', name: 'app', fullName: 'ever-works/app' },
			allowForking: true,
			archived: false,
			visibility: 'public',
			stars: 128,
			sizeKb: 4096,
			licenseSpdx: 'MIT'
		});
		// `size` is non-zero, so emptiness was never asserted either way.
		expect(result!.empty).toBeUndefined();
		expect(getBranchMock).not.toHaveBeenCalled();
	});

	it('reads the source network root, which a fork of a fork reports instead of its parent', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({
				fork: true,
				source: { owner: { login: 'upstream' }, name: 'root', full_name: 'upstream/root' },
				parent: { owner: { login: 'middle' }, name: 'root', full_name: 'middle/root' }
			})
		});

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.source).toEqual({ owner: 'upstream', name: 'root', fullName: 'upstream/root' });
		expect(result!.parent).toEqual({ owner: 'middle', name: 'root', fullName: 'middle/root' });
	});

	it('reports zero-valued facts as facts', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ stargazers_count: 0, size: 1 }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.stars).toBe(0);
		expect(result!.sizeKb).toBe(1);
	});

	it('keeps `internal` visibility apart from private', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ visibility: 'internal', private: false }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.visibility).toBe('internal');
		// An Enterprise internal repository is NOT private; treating it as one
		// would refuse a repository the caller may legitimately use.
		expect(result!.isPrivate).toBe(false);
	});

	it('leaves visibility unreported when GitHub sends a value outside the contract', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ visibility: 'something-new' }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.visibility).toBeUndefined();
	});

	it('maps NOASSERTION to null, which is not the same as "not reported"', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ license: { key: 'other', name: 'Other', spdx_id: 'NOASSERTION' } })
		});

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.licenseSpdx).toBeNull();
	});

	it('leaves licenseSpdx unreported when the repository has no licence file', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ license: null }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.licenseSpdx).toBeUndefined();
	});

	it('leaves absent facts absent — an unknown field is never `false`', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({
				source: null,
				allow_forking: undefined,
				archived: undefined,
				visibility: undefined,
				stargazers_count: undefined,
				size: undefined,
				license: undefined
			})
		});

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.allowForking).toBeUndefined();
		expect(result!.archived).toBeUndefined();
		expect(result!.visibility).toBeUndefined();
		expect(result!.stars).toBeUndefined();
		expect(result!.sizeKb).toBeUndefined();
		expect(result!.source).toBeUndefined();
		expect(result!.licenseSpdx).toBeUndefined();
		expect(result!.empty).toBeUndefined();
		expect(getBranchMock).not.toHaveBeenCalled();
	});

	it('produces EXACTLY the pre-APW-02 object for a pre-APW-02 payload', async () => {
		reposGetMock.mockResolvedValue({ data: legacyRepositoryPayload() });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		// Key set, not spot checks: an always-present `empty: undefined` would pass
		// a spot check while telling every consumer the API reported something.
		expect(Object.keys(result!).sort()).toEqual([
			'cloneUrl',
			'defaultBranch',
			'description',
			'fullName',
			'isFork',
			'isPrivate',
			'name',
			'owner',
			'parent',
			'permissions',
			'url'
		]);
		expect(getBranchMock).not.toHaveBeenCalled();
	});
});

describe('APW-03 T22 — getRepository maps the repository topics', () => {
	it('maps the topics GitHub reports, exactly', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ topics: ['ever-works-app-blueprint', 'x'] })
		});

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.topics).toEqual(['ever-works-app-blueprint', 'x']);
	});

	it('reports an empty topic list as a fact — GitHub said "no topics"', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ topics: [] }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.topics).toEqual([]);
	});

	it('leaves topics ABSENT when the payload does not carry the key — not reported is not []', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload() });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		// `[]` would claim "this repository has no topics", which nobody reported.
		expect('topics' in result!).toBe(false);
	});

	it('leaves topics absent when GitHub sends something that is not a list', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ topics: null }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect('topics' in result!).toBe(false);
	});

	it('drops non-string entries rather than casting them into the contract', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ topics: ['ever-works-app-blueprint', 42, null, 'y'] })
		});

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.topics).toEqual(['ever-works-app-blueprint', 'y']);
	});
});

describe('listRepositories maps the repository topics too', () => {
	// Website-template discovery lists the catalog org and must tell an App
	// Blueprint (topic `ever-works-app-blueprint`) from a website template whose
	// name also ends in "template". GitHub's list endpoints return `topics` on
	// every repository, so the list mapping reports them with exactly the
	// getRepository semantics: absent key = not reported, `[]` = no topics.
	const listed = (overrides: Record<string, unknown> = {}) => ({
		...legacyRepositoryPayload(),
		...overrides
	});

	it('maps the topics of an org listing, exactly', async () => {
		listForOrgMock.mockResolvedValue({
			data: [
				listed({ name: 'cal-template', topics: ['ever-works-app-blueprint', 'ever-works'] }),
				listed({ name: 'astro-blog-template', topics: [] })
			]
		});

		const result = await svc.listRepositories('ghp_secret', 1, 100, undefined, {
			owner: 'ever-works',
			type: 'org'
		});

		expect(listForOrgMock).toHaveBeenCalledWith(expect.objectContaining({ org: 'ever-works' }));
		expect(result[0].topics).toEqual(['ever-works-app-blueprint', 'ever-works']);
		expect(result[1].topics).toEqual([]);
	});

	it('maps the topics of the authenticated user listing', async () => {
		listForAuthenticatedUserMock.mockResolvedValue({
			data: [listed({ topics: ['ever-works-app-blueprint'] })]
		});

		const result = await svc.listRepositories('ghp_secret');

		expect(result[0].topics).toEqual(['ever-works-app-blueprint']);
	});

	it('leaves topics ABSENT when a listed repository does not carry the key', async () => {
		listForOrgMock.mockResolvedValue({ data: [listed(), listed({ topics: null })] });

		const result = await svc.listRepositories('ghp_secret', 1, 100, undefined, {
			owner: 'ever-works',
			type: 'org'
		});

		// Additive only: a payload without topics maps to the same keys as before.
		expect('topics' in result[0]).toBe(false);
		expect('topics' in result[1]).toBe(false);
		expect(Object.keys(result[0]).sort()).toEqual([
			'cloneUrl',
			'defaultBranch',
			'description',
			'fullName',
			'isFork',
			'isPrivate',
			'name',
			'owner',
			'permissions',
			'url'
		]);
	});

	it('drops non-string entries rather than casting them into the contract', async () => {
		listForOrgMock.mockResolvedValue({
			data: [listed({ topics: ['ever-works-app-blueprint', 42, null, 'y'] })]
		});

		const result = await svc.listRepositories('ghp_secret', 1, 100, undefined, {
			owner: 'ever-works',
			type: 'org'
		});

		expect(result[0].topics).toEqual(['ever-works-app-blueprint', 'y']);
	});
});

describe('APW-02 T16 — `empty` is computed ONLY from a zero size', () => {
	it('probes the default branch when size is 0 and reports empty: true on a 404', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ size: 0, default_branch: 'main' }) });
		getBranchMock.mockRejectedValue(statusError(404, 'Branch not found'));

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.empty).toBe(true);
		expect(result!.sizeKb).toBe(0);
		expect(getBranchMock).toHaveBeenCalledTimes(1);
		expect(getBranchMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, branch: 'main' });
	});

	it('reports empty: false when a zero-size repository does have a commit', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ size: 0 }) });
		getBranchMock.mockResolvedValue({ data: { name: 'main', commit: { sha: 'abc123' } } });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.empty).toBe(false);
	});

	it('does NOT probe — and asserts nothing — when size is non-zero', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ size: 5000 }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(getBranchMock).not.toHaveBeenCalled();
		// Not `false`: nobody checked, and an unknown must not become a claim.
		expect(result!.empty).toBeUndefined();
	});

	it('does NOT probe when the size is unknown', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ size: undefined }) });

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(getBranchMock).not.toHaveBeenCalled();
		expect(result!.empty).toBeUndefined();
	});

	it('leaves empty unreported when the probe itself is refused, without failing the read', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ size: 0 }) });
		getBranchMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		// The repository read succeeded; only the emptiness probe did not. That is
		// "not reported", not `false` and not a failed call.
		expect(result).not.toBeNull();
		expect(result!.empty).toBeUndefined();
		expect(result!.sizeKb).toBe(0);
	});

	it('probes the RESOLVED coordinates after a rename', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ size: 0, name: 'renamed', full_name: `${OWNER}/renamed` })
		});

		await svc.getRepository(OWNER, 'old-name', 'ghp_secret');

		expect(getBranchMock).toHaveBeenCalledWith({ owner: OWNER, repo: 'renamed', branch: 'main' });
	});
});

describe('APW-02 T16 — movedFrom (plan §4.3)', () => {
	it('records the requested coordinates when GitHub redirected a renamed repository', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ name: 'renamed', full_name: `${OWNER}/renamed` })
		});

		const result = await svc.getRepository(OWNER, 'old-name', 'ghp_secret');

		expect(result!.movedFrom).toBe(`${OWNER}/old-name`);
		// The object itself carries the RESOLVED coordinates the caller acts on.
		expect(result!.name).toBe('renamed');
		expect(result!.fullName).toBe(`${OWNER}/renamed`);
	});

	it('records a change of owner as a move too', async () => {
		reposGetMock.mockResolvedValue({
			data: repositoryPayload({ owner: { login: 'new-owner' }, full_name: `new-owner/${REPO}` })
		});

		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.movedFrom).toBe(`${OWNER}/${REPO}`);
	});

	it('does not call a difference in CASING a move', async () => {
		reposGetMock.mockResolvedValue({ data: repositoryPayload({ full_name: 'ACME/App' }) });

		const result = await svc.getRepository('acme', 'app', 'ghp_secret');

		expect(result!.movedFrom).toBeUndefined();
	});

	it('sets no movedFrom on the happy path', async () => {
		const result = await svc.getRepository(OWNER, REPO, 'ghp_secret');

		expect(result!.movedFrom).toBeUndefined();
	});
});

describe('APW-02 T16 — getRepository failures are typed (plan §4.2)', () => {
	it('keeps null on a 404 — unchanged behaviour', async () => {
		reposGetMock.mockRejectedValue(statusError(404, 'Not Found'));

		await expect(svc.getRepository(OWNER, REPO, 'ghp_secret')).resolves.toBeNull();
	});

	it('classifies a 403 with the primary budget spent as rate_limited, with the reset instant', async () => {
		reposGetMock.mockRejectedValue(
			statusError(403, 'API rate limit exceeded for installation', {
				'x-ratelimit-remaining': '0',
				'x-ratelimit-reset': '1789647300'
			})
		);

		const caught = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);

		expect(caught).toBeInstanceOf(GitProviderRequestError);
		const error = caught as GitProviderRequestError;
		expect(error.reason).toBe('rate_limited');
		expect(error.status).toBe(403);
		expect(error.details.retryAt).toBe('2026-09-17T12:15:00.000Z');
	});

	it('classifies a 403 carrying retry-after as secondary_rate_limited', async () => {
		reposGetMock.mockRejectedValue(
			statusError(403, 'You have exceeded a secondary rate limit.', { 'retry-after': '60' })
		);

		const caught = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);

		const error = caught as GitProviderRequestError;
		expect(error.reason).toBe('secondary_rate_limited');
		expect(error.status).toBe(403);
		// `retryAt` is now + retry-after, within a second of the assertion.
		const retryAt = Date.parse(error.details.retryAt ?? '');
		expect(Number.isNaN(retryAt)).toBe(false);
		expect(retryAt - Date.now()).toBeGreaterThan(58_000);
		expect(retryAt - Date.now()).toBeLessThan(62_000);
	});

	it('classifies a 403 "Resource not accessible by integration" as permission_missing (metadata)', async () => {
		reposGetMock.mockRejectedValue(statusError(403, 'Resource not accessible by integration'));

		const caught = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);

		const error = caught as GitProviderRequestError;
		expect(error.reason).toBe('permission_missing');
		expect(error.status).toBe(403);
		// `repos.get` needs Metadata (mandatory for an App installation), so that
		// is the permission a refusal names.
		expect(error.details).toEqual({ permission: 'metadata' });
	});

	it('classifies a 403 SAML refusal as sso_authorization_required', async () => {
		reposGetMock.mockRejectedValue(
			statusError(403, 'Resource protected by organization SAML enforcement. You must grant your token access.')
		);

		const caught = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);

		expect((caught as GitProviderRequestError).reason).toBe('sso_authorization_required');
	});

	it('classifies a 403 OAuth App restriction as oauth_app_restricted', async () => {
		reposGetMock.mockRejectedValue(
			statusError(
				403,
				'The organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.'
			)
		);

		const caught = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);

		expect((caught as GitProviderRequestError).reason).toBe('oauth_app_restricted');
	});

	it('classifies a 401 as unauthorized and a 500 as the unprocessable fallback, keeping both statuses', async () => {
		reposGetMock.mockRejectedValue(statusError(401, 'Bad credentials'));
		const unauthorized = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);
		expect((unauthorized as GitProviderRequestError).reason).toBe('unauthorized');
		expect((unauthorized as GitProviderRequestError).status).toBe(401);

		reposGetMock.mockRejectedValue(statusError(500, 'Server Error'));
		const serverError = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);
		expect((serverError as GitProviderRequestError).reason).toBe('unprocessable');
		expect((serverError as GitProviderRequestError).status).toBe(500);
	});

	it('never throws anything that is not a GitProviderRequestError', async () => {
		for (const failure of [
			statusError(403, 'Forbidden'),
			statusError(409, 'Git Repository is empty.'),
			statusError(422, 'Validation Failed'),
			new TypeError('fetch failed')
		]) {
			reposGetMock.mockRejectedValue(failure);

			const caught = await svc.getRepository(OWNER, REPO, 'ghp_secret').catch((err: unknown) => err);

			expect(caught).toBeInstanceOf(GitProviderRequestError);
			expect(caught).toBeInstanceOf(Error);
		}
	});
});
