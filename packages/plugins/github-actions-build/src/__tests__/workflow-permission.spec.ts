import { APP_BUILD_VERIFY_PROMPTED_SECRET, APP_BUILD_WORKFLOW_PATH } from '@ever-works/contracts';
import type { BuildAuth, RepositoryWriter } from '@ever-works/plugin';
import { describe, expect, it, vi } from 'vitest';

import { GitHubActionsBuildPlugin } from '../github-actions-build.plugin.js';
import {
	octokitRepositoryWriter,
	workflowPermissionMissingError,
	type OctokitRequester
} from '../repo/octokit-repository-writer.js';
import type { RepositorySecretPort } from '../repo/secret-sync.js';
import { repositoryWriteErrorCode, writeWorkflow } from '../repo/workflow-writer.js';

/**
 * 2026-10-17 (lane aw-builds-2) — the real-world blocker: a Build commits
 * `.github/workflows/ever-works-build.yml`, and GitHub guards that directory
 * separately from `repo` (the `workflow` OAuth scope, the App's
 * `Workflows: write`). These cases pin that the refusal is NAMED
 * (`workflowPermissionMissing`) and lands as a blocked Build the member can act
 * on, instead of a bare 403/404 — plus the two plugin members that landed with
 * it (`isCommitReachable`, `deleteVerifyPromptedSecret`).
 */

const AUTH: BuildAuth = { token: 'gho_not_a_real_token' };
const SHA = 'a'.repeat(40);
const repository = { owner: 'acme', repo: 'app', trackedBranch: 'main' };
const WORKFLOW_COMMIT = {
	branch: 'main',
	baseSha: SHA,
	message: 'ci: add the Ever Works build workflow',
	files: [{ path: APP_BUILD_WORKFLOW_PATH, content: 'name: x', encoding: 'utf-8' as const }]
};

function scripted(
	table: Record<string, (params: Record<string, unknown>) => unknown>,
	headers?: Record<string, unknown>
) {
	const calls: string[] = [];
	const octokit: OctokitRequester = {
		async request(route, params = {}) {
			calls.push(route);
			const handler = table[route];
			if (!handler) throw Object.assign(new Error(`unexpected ${route}`), { status: 500 });
			return { data: handler(params), headers: route === 'GET /user' ? headers : undefined };
		}
	};
	return { octokit, calls };
}

function httpError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status, response: { data: { message } } });
}

const COMMIT_ROUTES = {
	'GET /repos/{owner}/{repo}/git/commits/{commit_sha}': () => ({ tree: { sha: 't0' } }),
	'POST /repos/{owner}/{repo}/git/blobs': () => ({ sha: 'b1' }),
	'POST /repos/{owner}/{repo}/git/trees': () => ({ sha: 't1' }),
	'POST /repos/{owner}/{repo}/git/commits': () => ({ sha: 'c1' })
};

describe('the workflow-permission guard (octokitRepositoryWriter)', () => {
	it('refuses up front, writing nothing, when the recorded OAuth scopes lack `workflow`', async () => {
		const { octokit, calls } = scripted({});
		const writer = octokitRepositoryWriter(octokit, repository, {
			credential: 'oauth',
			scopes: ['repo', 'read:user']
		});
		await expect(writer.commitFiles(WORKFLOW_COMMIT)).rejects.toSatisfy(
			(error: unknown) => repositoryWriteErrorCode(error) === 'workflowPermissionMissing'
		);
		expect(calls).toEqual([]);
	});

	it('reads the scopes from x-oauth-scopes when they are not recorded', async () => {
		const lacking = scripted({ 'GET /user': () => ({}) }, { 'x-oauth-scopes': 'repo, read:user' });
		await expect(
			octokitRepositoryWriter(lacking.octokit, repository).commitFiles(WORKFLOW_COMMIT)
		).rejects.toMatchObject({
			code: 'workflowPermissionMissing',
			missing: 'workflow'
		});
		expect(lacking.calls).toEqual(['GET /user']);

		const granted = scripted(
			{ 'GET /user': () => ({}), ...COMMIT_ROUTES, 'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => ({}) },
			{ 'x-oauth-scopes': 'repo, workflow' }
		);
		await expect(
			octokitRepositoryWriter(granted.octokit, repository).commitFiles(WORKFLOW_COMMIT)
		).resolves.toEqual({
			commitSha: 'c1'
		});
	});

	it("translates a GitHub App's refusal into `workflows:write` missing", async () => {
		const { octokit } = scripted({
			...COMMIT_ROUTES,
			'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
				throw httpError(403, 'Resource not accessible by integration');
			}
		});
		const writer = octokitRepositoryWriter(octokit, repository, { credential: 'githubApp' });
		await expect(writer.commitFiles(WORKFLOW_COMMIT)).rejects.toMatchObject({
			code: 'workflowPermissionMissing',
			credential: 'githubApp',
			missing: 'workflows:write'
		});
	});

	it('passes a generic App refusal through when it comes before the ref update (a Contents gap, not Workflows)', async () => {
		const { octokit } = scripted({
			...COMMIT_ROUTES,
			'POST /repos/{owner}/{repo}/git/blobs': () => {
				throw httpError(403, 'Resource not accessible by integration');
			}
		});
		const writer = octokitRepositoryWriter(octokit, repository, { credential: 'githubApp' });
		await expect(writer.commitFiles(WORKFLOW_COMMIT)).rejects.toSatisfy(
			(error: unknown) => repositoryWriteErrorCode(error) === null
		);
	});

	it('translates GitHub\'s "without `workflow` scope" refusal too', async () => {
		const { octokit } = scripted({
			...COMMIT_ROUTES,
			'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
				throw httpError(
					422,
					'refusing to allow an OAuth App to create or update workflow `.github/workflows/ever-works-build.yml` without `workflow` scope'
				);
			}
		});
		const writer = octokitRepositoryWriter(octokit, repository, { credential: 'pat' });
		await expect(writer.commitFiles(WORKFLOW_COMMIT)).rejects.toMatchObject({ code: 'workflowPermissionMissing' });
	});

	it('leaves a commit outside .github/workflows/ alone', async () => {
		const { octokit, calls } = scripted({
			...COMMIT_ROUTES,
			'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => ({})
		});
		const writer = octokitRepositoryWriter(octokit, repository, { credential: 'oauth', scopes: ['repo'] });
		await writer.commitFiles({
			...WORKFLOW_COMMIT,
			files: [{ path: 'README.md', content: 'x', encoding: 'utf-8' }]
		});
		expect(calls).not.toContain('GET /user');
	});
});

describe('writeWorkflow maps the refusal onto a blocked Build', () => {
	it('answers blocked `workflowPermissionMissing` with the credential and the missing grant', async () => {
		const writer: RepositoryWriter = {
			getFileContent: vi.fn(async () => null),
			createBranch: vi.fn(async (name: string) => ({ name, commit: SHA, isDefault: false })),
			commitFiles: vi.fn(async () => {
				throw workflowPermissionMissingError('oauth');
			}),
			createPullRequest: vi.fn()
		} as never;

		const result = await writeWorkflow(
			{
				repository: { owner: 'acme', repo: 'app', trackedBranch: 'main', createdByAppWork: true },
				content: 'name: x\n',
				lastWrittenWorkflowSha256: null
			},
			writer
		);
		expect(result).toEqual({
			state: 'blocked',
			storedWorkflowSha256: null,
			blocked: {
				reason: 'workflowPermissionMissing',
				detail: { cause: 'workflowPermissionMissing', credential: 'oauth', missing: 'workflow' }
			}
		});
	});
});

class OctokitPlugin extends GitHubActionsBuildPlugin {
	constructor(
		private readonly fake: OctokitRequester,
		private readonly secrets?: Partial<RepositorySecretPort>
	) {
		super();
	}
	protected override octokitFor(): OctokitRequester {
		return this.fake;
	}
	protected override secretPort(): RepositorySecretPort {
		return this.secrets as RepositorySecretPort;
	}
}

describe('isCommitReachable (plan §5)', () => {
	const input = { repository: { owner: 'acme', repo: 'app' }, sha: SHA, branch: 'main' };
	const compare = (answer: () => unknown) =>
		new OctokitPlugin(scripted({ 'GET /repos/{owner}/{repo}/compare/{basehead}': answer }).octokit);

	it('is true when the branch contains the commit, false otherwise', async () => {
		expect(await compare(() => ({ status: 'ahead' })).isCommitReachable(input, AUTH)).toBe(true);
		expect(await compare(() => ({ status: 'identical' })).isCommitReachable(input, AUTH)).toBe(true);
		expect(await compare(() => ({ status: 'diverged' })).isCommitReachable(input, AUTH)).toBe(false);
		expect(await compare(() => ({ status: 'behind' })).isCommitReachable(input, AUTH)).toBe(false);
		expect(
			await compare(() => {
				throw httpError(404, 'Not Found');
			}).isCommitReachable(input, AUTH)
		).toBe(false);
	});

	it('throws when GitHub cannot answer — never a guessed true', async () => {
		await expect(
			compare(() => {
				throw httpError(502, 'Bad Gateway');
			}).isCommitReachable(input, AUTH)
		).rejects.toThrow('Bad Gateway');
	});
});

describe('deleteVerifyPromptedSecret (§4.10)', () => {
	it('deletes EW_VERIFY__PROMPTED, and treats an absent one as already gone', async () => {
		const deleteRepoSecret = vi.fn(async () => undefined);
		const plugin = new OctokitPlugin(scripted({}).octokit, { deleteRepoSecret });
		await expect(plugin.deleteVerifyPromptedSecret({ owner: 'acme', repo: 'app' }, AUTH)).resolves.toEqual({
			deleted: true
		});
		expect(deleteRepoSecret).toHaveBeenCalledWith({ name: APP_BUILD_VERIFY_PROMPTED_SECRET });

		const gone = new OctokitPlugin(scripted({}).octokit, {
			deleteRepoSecret: vi.fn(async () => {
				throw httpError(404, 'Not Found');
			})
		});
		await expect(gone.deleteVerifyPromptedSecret({ owner: 'acme', repo: 'app' }, AUTH)).resolves.toEqual({
			deleted: false
		});
	});
});
