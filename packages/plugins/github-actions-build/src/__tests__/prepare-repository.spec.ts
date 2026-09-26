import { APP_BUILD_WORKFLOW_BRANCH, APP_BUILD_WORKFLOW_PATH } from '@ever-works/contracts';
import type { BuildAuth, PrepareRepositoryInput, RepositoryWriter } from '@ever-works/plugin';
import { describe, expect, it, vi } from 'vitest';

import { GitHubActionsBuildPlugin } from '../github-actions-build.plugin.js';
import type { RepositorySecretPort } from '../repo/secret-sync.js';

/**
 * APW-05 §4.6 — `prepareRepository`, composed.
 *
 * The four steps each have their own tested file (T11 selects the runner, T8
 * generates, T9 delivers, T10 syncs). What this file is about is the ORDER, and
 * one rule in particular:
 *
 * **Nothing reaches a member's repository until it is known the Build could run
 * at all.** A `runnerTooSmall` block writes no commit and no secret; a workflow
 * that could not be delivered syncs no secret. A secret written for a workflow
 * that never landed is a secret nobody will ever clean up, in a repository the
 * platform may not own.
 */

const AUTH: BuildAuth = { token: 'ghs-not-a-real-token' };

function input(overrides: Partial<PrepareRepositoryInput> = {}): PrepareRepositoryInput {
	return {
		workId: '11111111-1111-4111-8111-111111111111',
		repository: {
			owner: 'acme',
			repo: 'their-app',
			visibility: 'public',
			trackedBranch: 'main',
			createdByAppWork: true
		},
		// `resources` is REQUIRED on `AppBuildBlock` (`build.interface.ts:141`) and
		// the generator reads `cpu` and `timeoutMinutes` directly; `memoryGiB` is the
		// optional one, and leaving it out is the APW05-G14 case below.
		build: {
			strategy: 'dockerfile',
			args: [],
			services: [],
			resources: { cpu: 2, timeoutMinutes: 30 }
		} as never,
		appSpecHash: `sha256:${'a'.repeat(64)}`,
		values: [],
		previouslyWrittenSecretNames: [],
		lastWrittenWorkflowSha256: null,
		settings: {},
		checks: [],
		...overrides
	};
}

/** A writer that records what it was asked to do. */
function fakeWriter(existing: string | null = null) {
	const commitFiles = vi.fn(async () => ({ commitSha: 'c'.repeat(40) }));
	const files = new Map<string, string>();
	if (existing !== null) files.set(APP_BUILD_WORKFLOW_PATH, existing);

	const writer = {
		getFileContent: vi.fn(async (path: string) => {
			const content = files.get(path);
			return content === undefined ? null : { content, encoding: 'utf-8' };
		}),
		commitFiles: vi.fn(async (request: { files: Array<{ path: string; content: string }> }) => {
			for (const file of request.files ?? []) files.set(file.path, file.content);
			return commitFiles();
		}),
		createBranch: vi.fn(async (name: string) => ({ name })),
		createPullRequest: vi.fn(async () => ({ number: 7, url: 'https://github.com/acme/their-app/pull/7' }))
	} as unknown as RepositoryWriter & { commitFiles: ReturnType<typeof vi.fn> };

	return writer;
}

/** The pull request URL GitHub hands out for the first pull request on the delivery branch. */
const FIRST_PULL_REQUEST_URL = 'https://github.com/someone-else/their-app/pull/7';

/**
 * A writer that behaves like GitHub where {@link fakeWriter} does not need to:
 * the tracked branch, the delivery branch and each commit hold their own bytes,
 * and a second pull request for a head that already has an OPEN one is refused —
 * with the contract's `pullRequestExists` code, or as Octokit's raw 422.
 */
function gitHubLikeWriter(options: { refusal?: 'coded' | 'github422' } = {}) {
	let tracked: string | null = null;
	let deliveryBranch: string | null = null;
	const commits = new Map<string, string>();
	let openPullRequest: { number: number; url: string } | null = null;
	const opened: number[] = [];

	const alreadyExists = () => {
		const message = `A pull request already exists for someone-else:${APP_BUILD_WORKFLOW_BRANCH}.`;
		return options.refusal === 'github422'
			? Object.assign(new Error(`Validation Failed: {"message":"${message}"}`), {
					status: 422,
					response: { data: { message: 'Validation Failed', errors: [{ message }] } }
				})
			: Object.assign(new Error(message), { code: 'pullRequestExists' });
	};

	const writer = {
		getFileContent: vi.fn(async (path: string, ref?: string) => {
			if (path !== APP_BUILD_WORKFLOW_PATH) return null;
			const content =
				ref === undefined
					? tracked
					: ref === APP_BUILD_WORKFLOW_BRANCH
						? deliveryBranch
						: (commits.get(ref) ?? null);
			return content === null ? null : { content, encoding: 'utf-8' };
		}),
		commitFiles: vi.fn(async (request: { branch: string; files: Array<{ content: string }> }) => {
			const sha = `commit-${commits.size + 1}`;
			const content = request.files[0].content;
			if (request.branch === APP_BUILD_WORKFLOW_BRANCH) deliveryBranch = content;
			else tracked = content;
			commits.set(sha, content);
			return { commitSha: sha };
		}),
		createBranch: vi.fn(async (name: string) => ({ name, commit: `${name}-head`, isDefault: false })),
		createPullRequest: vi.fn(async () => {
			if (openPullRequest) throw alreadyExists();
			openPullRequest = { number: 7, url: FIRST_PULL_REQUEST_URL };
			opened.push(openPullRequest.number);
			return { ...openPullRequest, state: 'open' };
		})
	} as unknown as RepositoryWriter & {
		commitFiles: ReturnType<typeof vi.fn>;
		createPullRequest: ReturnType<typeof vi.fn>;
	};

	return { writer, opened };
}

/** A LINKED repository: not ours to write into, so every delivery is a pull request (R-4). */
const LINKED_REPOSITORY: PrepareRepositoryInput['repository'] = {
	owner: 'someone-else',
	repo: 'their-app',
	visibility: 'public',
	trackedBranch: 'main',
	createdByAppWork: false
};

/** A secret port that records every write, so "no secret was written" is checkable. */
function fakeSecretPort() {
	const port = {
		getRepoPublicKey: vi.fn(async () => ({
			key_id: '1',
			// A valid 32-byte base64 key, so libsodium's seal does not reject it.
			key: Buffer.alloc(32, 7).toString('base64')
		})),
		putRepoSecret: vi.fn(async () => undefined),
		deleteRepoSecret: vi.fn(async () => undefined)
	} satisfies RepositorySecretPort;
	return port;
}

/** The plugin with its secret port replaced — no Octokit, no network. */
class TestPlugin extends GitHubActionsBuildPlugin {
	constructor(private readonly port: RepositorySecretPort) {
		super();
	}
	protected secretPort(): RepositorySecretPort {
		return this.port;
	}
}

describe('prepareRepository (plan §4.6)', () => {
	it('writes the workflow on the tracked branch and reports the delivery', async () => {
		const port = fakeSecretPort();
		const writer = fakeWriter();

		const result = await new TestPlugin(port).prepareRepository(input(), AUTH, writer);

		expect(result.workflow.state).toBe('committed');
		expect(writer.commitFiles).toHaveBeenCalledTimes(1);

		const committed = (writer.commitFiles.mock.calls[0][0] as { files: Array<{ path: string }> }).files;
		expect(committed[0].path).toBe(APP_BUILD_WORKFLOW_PATH);
	});

	it('the file it writes carries the selected runner label', async () => {
		const writer = fakeWriter();

		await new TestPlugin(fakeSecretPort()).prepareRepository(input(), AUTH, writer);

		const committed = (writer.commitFiles.mock.calls[0][0] as { files: Array<{ content: string }> }).files;
		// The public runner, because the repository is public (T11).
		expect(committed[0].content).toContain('ubuntu-latest');
	});

	it('BLOCKS on runnerTooSmall before touching the repository at all', async () => {
		// The rule this file is about. A workflow written for a Build that cannot
		// fit its runner is a workflow guaranteed to be OOM-killed minutes in.
		const port = fakeSecretPort();
		const writer = fakeWriter();

		const result = await new TestPlugin(port).prepareRepository(
			input({
				repository: {
					owner: 'acme',
					repo: 'their-app',
					visibility: 'private',
					trackedBranch: 'main',
					createdByAppWork: true
				},
				build: {
					strategy: 'dockerfile',
					args: [],
					services: [],
					resources: { cpu: 2, memoryGiB: 12, timeoutMinutes: 30 }
				} as never
			}),
			AUTH,
			writer
		);

		expect(result.blocked).toEqual({
			reason: 'runnerTooSmall',
			detail: { needed: 12, max: 5 }
		});
		expect(writer.commitFiles).not.toHaveBeenCalled();
		expect(port.putRepoSecret).not.toHaveBeenCalled();
	});

	it('an absent resources block never blocks (APW05-G14)', async () => {
		const result = await new TestPlugin(fakeSecretPort()).prepareRepository(input(), AUTH, fakeWriter());

		expect(result.blocked).toBeUndefined();
	});

	it('leaves a hand-edited workflow alone and reports `editedByHand`', async () => {
		// `lastWrittenWorkflowSha256: null` with a file present means the platform
		// never wrote it — a hand edit by definition (FR-9).
		const port = fakeSecretPort();
		const writer = fakeWriter('name: someone else’s workflow\n');

		const result = await new TestPlugin(port).prepareRepository(input(), AUTH, writer);

		expect(result.workflow.state).toBe('editedByHand');
		// It is not "nothing happened": the platform still delivers its version, on
		// its OWN branch, as a pull request the member can read and refuse. What it
		// must never do is overwrite the tracked branch, which is the assertion.
		for (const [request] of writer.commitFiles.mock.calls as Array<[{ branch: string }]>) {
			expect(request.branch).not.toBe('main');
		}
		expect(writer.createPullRequest).toHaveBeenCalledTimes(1);
	});

	it('opens a pull request for a repository that is not ours to write into (R-4)', async () => {
		const writer = fakeWriter();

		const result = await new TestPlugin(fakeSecretPort()).prepareRepository(
			input({
				repository: {
					owner: 'someone-else',
					repo: 'their-app',
					visibility: 'public',
					trackedBranch: 'main',
					// A LINKED repository. Committing straight to its branch is what
					// R-4 exists to prevent.
					createdByAppWork: false
				}
			}),
			AUTH,
			writer
		);

		expect(result.workflow.state).toBe('pullRequestOpened');
		expect(writer.createPullRequest).toHaveBeenCalledTimes(1);
	});

	it('reports a `contentSha256` only when the read-back proved it (FR-8)', async () => {
		// A hash of what we SENT, rather than of what is there, is how a failed
		// write becomes an undetected hand edit on the next preparation.
		const result = await new TestPlugin(fakeSecretPort()).prepareRepository(input(), AUTH, fakeWriter());

		expect(result.workflow.contentSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it('syncs the build values only AFTER the workflow is delivered', async () => {
		const port = fakeSecretPort();
		const writer = fakeWriter();
		const order: string[] = [];
		const realCommit = writer.commitFiles.getMockImplementation();
		(writer.commitFiles as ReturnType<typeof vi.fn>).mockImplementation(async (request: never) => {
			order.push('commit');
			// Delegate, so the file is still stored and the writer's read-back can
			// prove it. Replacing the behaviour outright made the delivery fail and
			// this case assert the ordering of a path that never ran.
			return realCommit!(request);
		});
		port.putRepoSecret.mockImplementation(async () => {
			order.push('secret');
		});

		await new TestPlugin(port).prepareRepository(
			input({
				values: [
					// `fingerprint` is required: `computeBuildInputsHash` reads it, and a
					// value without one throws rather than hashing `undefined`.
					{ name: 'DATABASE_URL', value: 'postgres://x', fingerprint: 'v1' } as never
				]
			}),
			AUTH,
			writer
		);

		// A secret written for a workflow that never landed is a secret nobody
		// will clean up, in a repository the platform may not own.
		expect(order[0]).toBe('commit');
		expect(order).toContain('secret');
	});

	it('counts a previously written secret GitHub no longer has as removed, rather than failing the preparation', async () => {
		// The DELETE answers 404 for a name an owner removed by hand. Throwing kept
		// the name on the row, so every later preparation failed on the same 404.
		const port = fakeSecretPort();
		port.deleteRepoSecret.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));

		const result = await new TestPlugin(port).prepareRepository(
			input({ previouslyWrittenSecretNames: ['EW_OLD'] }),
			AUTH,
			fakeWriter()
		);

		expect(result.secretsRemoved).toEqual(['EW_OLD']);
		expect(port.deleteRepoSecret).toHaveBeenCalledWith({ name: 'EW_OLD' });
	});
});

describe('prepareRepository — a second preparation reuses the open pull request (ACC-05-02)', () => {
	it('adopts the open pull request GitHub reports, and echoes the recorded link back', async () => {
		const { writer, opened } = gitHubLikeWriter();
		const plugin = new TestPlugin(fakeSecretPort());

		const first = await plugin.prepareRepository(input({ repository: LINKED_REPOSITORY }), AUTH, writer);
		expect(first.workflow.state).toBe('pullRequestOpened');
		expect(first.workflow.pullRequestUrl).toBe(FIRST_PULL_REQUEST_URL);

		// What the prepare runner hands back from §3.1b's row on the next preparation.
		const second = await plugin.prepareRepository(
			input({
				repository: LINKED_REPOSITORY,
				workflowPullRequestNumber: 7,
				workflowPullRequestUrl: first.workflow.pullRequestUrl
			}),
			AUTH,
			writer
		);

		expect(second.workflow.state).toBe('pullRequestUpdated');
		expect(second.workflow.pullRequestUrl).toBe(FIRST_PULL_REQUEST_URL);
		expect(second.blocked).toBeUndefined();
		// Asked twice, opened once: GitHub's refusal is what proved the reuse.
		expect(writer.createPullRequest).toHaveBeenCalledTimes(2);
		expect(opened).toEqual([7]);
	});

	it('still resolves when the row recorded no pull request and GitHub answers its raw 422', async () => {
		const { writer, opened } = gitHubLikeWriter({ refusal: 'github422' });
		const plugin = new TestPlugin(fakeSecretPort());

		await plugin.prepareRepository(input({ repository: LINKED_REPOSITORY }), AUTH, writer);
		const second = await plugin.prepareRepository(input({ repository: LINKED_REPOSITORY }), AUTH, writer);

		expect(second.workflow.state).toBe('pullRequestUpdated');
		// No recorded link to echo: the runner keeps the one its row already holds.
		expect(second.workflow.pullRequestUrl).toBeUndefined();
		expect(opened).toEqual([7]);
	});
});
