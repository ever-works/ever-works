import type { BuildAuth } from '@ever-works/plugin';
import { describe, expect, it } from 'vitest';

import { GitHubActionsBuildPlugin } from '../github-actions-build.plugin.js';
import { octokitRepositoryWriter, type OctokitRequester } from '../repo/octokit-repository-writer.js';
import { repositoryWriteErrorCode } from '../repo/workflow-writer.js';
import type { ActionsRun, ActionsRunsPort } from '../runs/actions-runs.port.js';

/**
 * APW-05 T21a + T16 remainder (outstanding-work A0.4) — run discovery's
 * `listRecentRuns` and the clone-free Octokit writer `prepareRepository`
 * delivers the workflow through. Both are driven through fakes: the rules are
 * the mapping and the refusal codes, not GitHub.
 */

const AUTH: BuildAuth = { token: 'ghs-not-a-real-token' };
const SHA = 'a'.repeat(40);

function run(overrides: Partial<ActionsRun> = {}): ActionsRun {
	return {
		id: 42,
		status: 'in_progress',
		conclusion: null,
		run_attempt: 1,
		event: 'push',
		head_branch: 'main',
		head_sha: SHA,
		display_title: 'chore: bump',
		created_at: '2026-10-17T10:00:00.000Z',
		head_repository: { full_name: 'acme/app' },
		...overrides
	};
}

class FakePortPlugin extends GitHubActionsBuildPlugin {
	constructor(private readonly port: Partial<ActionsRunsPort>) {
		super();
	}
	protected override actionsPort(): ActionsRunsPort {
		return this.port as ActionsRunsPort;
	}
}

describe('listRecentRuns (run discovery, §7.4a)', () => {
	it('maps push, fork pull-request and dispatched runs onto BuildRunRef', async () => {
		const plugin = new FakePortPlugin({
			listWorkflowRunsConditional: async () => ({
				notModified: false,
				etag: 'W/"abc"',
				runs: [
					run(),
					run({
						id: 43,
						event: 'pull_request',
						head_repository: { full_name: 'stranger/app' },
						pull_requests: [{ number: 7 }]
					}),
					run({
						id: 44,
						event: 'workflow_dispatch',
						status: 'queued',
						display_title: 'Ever Works build b-1'
					}),
					run({ id: 45, head_sha: null })
				]
			})
		});

		const answer = await plugin.listRecentRuns(
			{
				repository: { owner: 'acme', name: 'app' },
				workflowPath: '.github/workflows/ever-works-build.yml',
				perPage: 20
			},
			AUTH
		);

		expect(answer.notModified).toBe(false);
		expect(answer.etag).toBe('W/"abc"');
		expect(answer.runs).toHaveLength(3);
		expect(answer.runs[0]).toMatchObject({ providerRunId: '42', event: 'push', status: 'running', headSha: SHA });
		expect(answer.runs[1]).toMatchObject({
			event: 'pull_request',
			headRepositoryFullName: 'stranger/app',
			pullRequestNumber: 7
		});
		expect(answer.runs[2]).toMatchObject({
			event: 'manual',
			status: 'queued',
			displayTitle: 'Ever Works build b-1'
		});
	});

	it('answers notModified on a 304 with no runs', async () => {
		const plugin = new FakePortPlugin({
			listWorkflowRunsConditional: async ({ etag }) => ({ notModified: true, etag, runs: [] })
		});
		const answer = await plugin.listRecentRuns(
			{
				repository: { owner: 'acme', name: 'app' },
				workflowPath: 'x/ever-works-build.yml',
				perPage: 5,
				etag: 'e1'
			},
			AUTH
		);
		expect(answer).toEqual({ notModified: true, etag: 'e1', runs: [] });
	});

	it('falls back to the unconditional list when the port has no conditional read', async () => {
		const plugin = new FakePortPlugin({ listWorkflowRuns: async () => [run()] });
		const answer = await plugin.listRecentRuns(
			{ repository: { owner: 'acme', name: 'app' }, workflowPath: 'ever-works-build.yml', perPage: 5 },
			AUTH
		);
		expect(answer.runs).toHaveLength(1);
	});
});

/** A scripted Octokit: each route answers once from the table, or throws. */
function fakeOctokit(table: Record<string, (params: Record<string, unknown>) => unknown>): {
	octokit: OctokitRequester;
	calls: Array<{ route: string; params: Record<string, unknown> }>;
} {
	const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
	return {
		calls,
		octokit: {
			async request(route, params = {}) {
				calls.push({ route, params });
				const handler = table[route];
				if (!handler) throw Object.assign(new Error(`unexpected ${route}`), { status: 500 });
				return { data: handler(params) };
			}
		}
	};
}

function httpError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status, response: { data: { message } } });
}

describe('octokitRepositoryWriter (the clone-free writer)', () => {
	const repository = { owner: 'acme', repo: 'app', trackedBranch: 'main' };

	it('answers null for a file that does not exist, and defaults the ref to the tracked branch', async () => {
		const { octokit, calls } = fakeOctokit({
			'GET /repos/{owner}/{repo}/contents/{path}': () => {
				throw httpError(404, 'Not Found');
			}
		});
		expect(await octokitRepositoryWriter(octokit, repository).getFileContent('a.yml')).toBeNull();
		expect(calls[0].params.ref).toBe('main');
	});

	it('lands one commit through blobs, a tree, a commit and a non-forced ref update', async () => {
		const { octokit, calls } = fakeOctokit({
			'GET /repos/{owner}/{repo}/git/commits/{commit_sha}': () => ({ tree: { sha: 'tree-0' } }),
			'POST /repos/{owner}/{repo}/git/blobs': () => ({ sha: 'blob-1' }),
			'POST /repos/{owner}/{repo}/git/trees': () => ({ sha: 'tree-1' }),
			'POST /repos/{owner}/{repo}/git/commits': () => ({ sha: 'commit-1' }),
			'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => ({})
		});
		const answer = await octokitRepositoryWriter(octokit, repository).commitFiles({
			branch: 'main',
			baseSha: SHA,
			message: 'ci: add the Ever Works build workflow',
			files: [{ path: '.github/workflows/ever-works-build.yml', content: 'name: x', encoding: 'utf-8' }]
		});
		expect(answer).toEqual({ commitSha: 'commit-1' });
		const patch = calls.find((call) => call.route.startsWith('PATCH'));
		expect(patch?.params).toMatchObject({ ref: 'heads/main', sha: 'commit-1', force: false });
	});

	it('names a moved branch nonFastForward and a protection refusal refRejectedByRule', async () => {
		const base = {
			'GET /repos/{owner}/{repo}/git/commits/{commit_sha}': () => ({ tree: { sha: 't' } }),
			'POST /repos/{owner}/{repo}/git/blobs': () => ({ sha: 'b' }),
			'POST /repos/{owner}/{repo}/git/trees': () => ({ sha: 't2' }),
			'POST /repos/{owner}/{repo}/git/commits': () => ({ sha: 'c' })
		};
		const input = { branch: 'main', baseSha: SHA, message: 'm', files: [] };

		const moved = fakeOctokit({
			...base,
			'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
				throw httpError(422, 'Update is not a fast forward');
			}
		});
		await expect(octokitRepositoryWriter(moved.octokit, repository).commitFiles(input)).rejects.toSatisfy(
			(error: unknown) => repositoryWriteErrorCode(error) === 'nonFastForward'
		);

		const protectedBranch = fakeOctokit({
			...base,
			'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
				throw httpError(422, 'Protected branch update failed for refs/heads/main.');
			}
		});
		await expect(octokitRepositoryWriter(protectedBranch.octokit, repository).commitFiles(input)).rejects.toSatisfy(
			(error: unknown) => repositoryWriteErrorCode(error) === 'refRejectedByRule'
		);
	});

	it('returns an existing branch rather than recreating it, and creates a missing one from its base head', async () => {
		const existing = fakeOctokit({
			'GET /repos/{owner}/{repo}/branches/{branch}': () => ({ name: 'main', commit: { sha: SHA } })
		});
		expect(await octokitRepositoryWriter(existing.octokit, repository).createBranch('main', 'main')).toMatchObject({
			name: 'main',
			commit: SHA
		});

		const missing = fakeOctokit({
			'GET /repos/{owner}/{repo}/branches/{branch}': () => {
				throw httpError(404, 'Branch not found');
			},
			'GET /repos/{owner}/{repo}/git/ref/{ref}': () => ({ object: { sha: SHA } }),
			'POST /repos/{owner}/{repo}/git/refs': () => ({})
		});
		const created = await octokitRepositoryWriter(missing.octokit, repository).createBranch(
			'ever-works/build-workflow',
			'main'
		);
		expect(created).toMatchObject({ name: 'ever-works/build-workflow', commit: SHA });
		expect(missing.calls.at(-1)?.params).toMatchObject({ ref: 'refs/heads/ever-works/build-workflow', sha: SHA });
	});

	it('refuses a second pull request for the same head with pullRequestExists', async () => {
		const { octokit } = fakeOctokit({
			'POST /repos/{owner}/{repo}/pulls': () => {
				throw httpError(
					422,
					'Validation Failed: A pull request already exists for acme:ever-works/build-workflow.'
				);
			}
		});
		await expect(
			octokitRepositoryWriter(octokit, repository).createPullRequest({ title: 't', head: 'h', base: 'main' })
		).rejects.toSatisfy((error: unknown) => repositoryWriteErrorCode(error) === 'pullRequestExists');
	});
});
