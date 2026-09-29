import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `listRepositories` maps the repository topics.
 *
 * Website-template discovery lists the catalog org and must tell an App
 * Blueprint (topic `ever-works-app-blueprint`, e.g. ever-works/cal-template)
 * from a website template whose name also ends in "template". GitHub's list
 * endpoints return `topics` on every repository, so the list mapping reports
 * them: absent key = not reported, `[]` = no topics.
 *
 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts`
 * suites do, so nothing here can reach the network.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const listForOrgMock = vi.fn();
const listForAuthenticatedUserMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				listForOrg: (...args: unknown[]) => listForOrgMock(...args),
				listForAuthenticatedUser: (...args: unknown[]) => listForAuthenticatedUserMock(...args)
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

const OWNER = 'ever-works';
const REPO = 'app';

/** A listed repository with only the fields the mapping read before topics. */
function listed(overrides: Record<string, unknown> = {}) {
	return {
		owner: { login: OWNER },
		name: REPO,
		full_name: `${OWNER}/${REPO}`,
		description: null,
		default_branch: 'main',
		private: false,
		html_url: `https://github.com/${OWNER}/${REPO}`,
		clone_url: `https://github.com/${OWNER}/${REPO}.git`,
		fork: false,
		permissions: undefined,
		...overrides
	};
}

let svc: InstanceType<typeof GitHubApiService>;

beforeEach(() => {
	svc = new GitHubApiService();
	listForOrgMock.mockReset();
	listForAuthenticatedUserMock.mockReset();
});

describe('listRepositories maps the repository topics', () => {
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
