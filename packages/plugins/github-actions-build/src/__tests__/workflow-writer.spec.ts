import { APP_BUILD_WORKFLOW_BRANCH, APP_BUILD_WORKFLOW_PATH, sha256Hex } from '@ever-works/contracts';
import type {
	CreatePROptions,
	GitBranch,
	GitPullRequest,
	RepositoryCommitInput,
	RepositoryWriter
} from '@ever-works/plugin';
import { describe, expect, it, vi } from 'vitest';

import {
	isBranchProtected,
	type BranchProtectionPort,
	type BranchProtectionResponse,
	type BranchRulePayload
} from '../repo/branch-protection.js';
import {
	WORKFLOW_COMMIT_MESSAGE_ADD,
	WORKFLOW_COMMIT_MESSAGE_REMOVE,
	WORKFLOW_COMMIT_MESSAGE_UPDATE,
	WORKFLOW_PULL_REQUEST_TITLE,
	WORKFLOW_REMOVAL_PULL_REQUEST_TITLE,
	WORKFLOW_WRITE_MAX_ATTEMPTS,
	isPullRequestAlreadyExistsError,
	repositoryWriteErrorCode,
	writeWorkflow,
	type WorkflowWriteInput
} from '../repo/workflow-writer.js';

/**
 * APW-05 T9 — delivery through the `RepositoryWriter` and nothing else (plan §4.6).
 *
 * The fake below is the whole repository: four members, no clone, and a record of
 * every call. That is the point of the seam — writing one file must not clone a
 * 1 GB repository (plan §1.2) — so the first case asserts the call set, and the
 * rest assert the delivery rules against it:
 *
 *   - ACC-05-01 (one path, one commit), ACC-05-02 (one pull request, reused),
 *   - ACC-05-04 (a hand edit is never overwritten),
 *   - `APW05-G16` (a ruleset-only branch is protected; `refRejectedByRule` switches
 *     to the pull request path exactly once and never loops),
 *   - R-4 (a Link relation always takes the pull request path),
 *   - FR-8 (only a matching read-back stores a hash).
 *
 * `workflowPending` is **not** asserted here: it is the prepare runner's mapping
 * of the `pullRequestOpened` state this writer returns (T19, plan §4.6 step 0), and
 * this spec asserts the state and the URL the runner needs to make it.
 */

const TRACKED = 'main';
const OWNER = 'ever-works';
const REPO = 'fixture-app';
const CONTENT = 'name: Ever Works build\njobs:\n  verify:\n    runs-on: "ubuntu-latest"\n';
const FIRST_CONTENT = 'name: Ever Works build\njobs:\n  build:\n    runs-on: "ubuntu-latest"\n';

/** A scripted refusal a `commitFiles` call may throw. */
type ScriptedFailure = { code: 'nonFastForward' | 'refRejectedByRule'; calls: number[] } | null;

/**
 * How the fake refuses a second pull request for a head that already has an open one.
 *
 * `coded` is the contract's shape (`RepositoryWriteErrorCode` `pullRequestExists`,
 * what a facade-bound writer throws); `github422` is Octokit's own `RequestError`
 * for GitHub's answer, which is what reaches the writer when nothing translates it.
 */
type PullRequestExistsShape = 'coded' | 'github422';

/** GitHub's own sentence for the refusal, as it appears in both shapes. */
const ALREADY_EXISTS_MESSAGE = `A pull request already exists for ${OWNER}:${APP_BUILD_WORKFLOW_BRANCH}.`;

/** The refusal of a second pull request, in the shape the fake was asked for. */
function pullRequestExistsError(shape: PullRequestExistsShape): Error {
	if (shape === 'coded') {
		return Object.assign(new Error(ALREADY_EXISTS_MESSAGE), { code: 'pullRequestExists' });
	}
	// Octokit's RequestError for `POST /repos/{owner}/{repo}/pulls` answering 422.
	return Object.assign(
		new Error(
			`Validation Failed: {"resource":"PullRequest","code":"custom","message":"${ALREADY_EXISTS_MESSAGE}"} - https://docs.github.com/rest/pulls/pulls#create-a-pull-request`
		),
		{
			status: 422,
			response: {
				data: {
					message: 'Validation Failed',
					errors: [{ resource: 'PullRequest', code: 'custom', message: ALREADY_EXISTS_MESSAGE }]
				}
			}
		}
	);
}

interface FakeState {
	calls: string[];
	commits: RepositoryCommitInput[];
	/** Only the pull requests GitHub actually OPENED — a refused create is not one. */
	pullRequests: Array<Omit<CreatePROptions, 'owner' | 'repo'>>;
	branchNamesCreated: string[];
	failCommit: ScriptedFailure;
	/** Overrides what the read-back at a commit sha returns — the FR-8 mismatch case. */
	readBackOverride?: string | null;
	commitCounter: number;
	/** What each commit sha holds — the read-back's view (FR-8). */
	commitContents: Record<string, string>;
}

/**
 * The four-member repository the writer is allowed to touch.
 *
 * `tracked` is what `getFileContent(path)` answers with no `ref`; `branch` is the
 * pull-request branch's content and head.
 */
function fakeWriter(options: {
	tracked?: string | null;
	branch?: string | null;
	branchCommit?: string;
	trackedHead?: string;
	failCommit?: ScriptedFailure;
	readBackOverride?: string | null;
	/** An OPEN pull request GitHub already holds for `ever-works/build-workflow`. */
	existingPullRequest?: GitPullRequest | null;
	/** The shape of GitHub's "already exists" refusal (default: the contract's code). */
	pullRequestExistsShape?: PullRequestExistsShape;
	/** A refusal `createPullRequest` throws whatever is open — for the errors that must still throw. */
	failPullRequest?: Error;
}): { writer: RepositoryWriter; state: FakeState; commitInputs: () => RepositoryCommitInput[] } {
	const state: FakeState = {
		calls: [],
		commits: [],
		pullRequests: [],
		branchNamesCreated: [],
		failCommit: options.failCommit ?? null,
		readBackOverride: options.readBackOverride,
		commitCounter: 0,
		commitContents: {}
	};
	let tracked = options.tracked ?? null;
	let branch = options.branch ?? null;
	// GitHub's view of the open pull requests: a seeded one, then every one this
	// fake opens. A second create for the same head is refused, as GitHub refuses it.
	const openPullRequests: GitPullRequest[] = options.existingPullRequest ? [options.existingPullRequest] : [];
	let nextPullRequestNumber = 7;

	const writer: RepositoryWriter = {
		async getFileContent(path: string, ref?: string): Promise<{ content: string; encoding: string } | null> {
			state.calls.push(`getFileContent:${path}@${ref ?? TRACKED}`);
			if (path !== APP_BUILD_WORKFLOW_PATH && path !== WORKFLOW_PATH) return null;
			if (ref === undefined) return tracked === null ? null : { content: tracked, encoding: 'utf-8' };
			if (ref === APP_BUILD_WORKFLOW_BRANCH)
				return branch === null ? null : { content: branch, encoding: 'utf-8' };
			// A read-back at a commit sha. `readBackOverride` forces the FR-8 mismatch.
			if (state.readBackOverride !== undefined) {
				return state.readBackOverride === null ? null : { content: state.readBackOverride, encoding: 'utf-8' };
			}
			const committed = state.commitContents[ref];
			return committed === undefined ? null : { content: committed, encoding: 'utf-8' };
		},
		async commitFiles(input: RepositoryCommitInput): Promise<{ commitSha: string }> {
			state.calls.push(`commitFiles:${input.branch}`);
			state.commits.push(input);
			// Every attempt gets its own commit id, accepted or refused — which is what
			// makes "which attempt landed" observable.
			state.commitCounter += 1;
			const commitSha = `commit-${state.commitCounter}`;
			const failure = state.failCommit;
			if (failure && failure.calls.includes(state.commits.length)) {
				throw Object.assign(new Error(`refused: ${failure.code}`), { code: failure.code });
			}
			const file = input.files[0];
			if (input.branch === TRACKED) tracked = file.content;
			else branch = file.content;
			state.commitContents[commitSha] = file.content;
			return { commitSha };
		},
		async createBranch(name: string, fromRef: string): Promise<GitBranch> {
			state.calls.push(`createBranch:${name}`);
			state.branchNamesCreated.push(name);
			if (name === APP_BUILD_WORKFLOW_BRANCH) {
				return { name, commit: options.branchCommit ?? 'branch-head-0', isDefault: false };
			}
			// The contract's "an existing branch is returned rather than recreated".
			return { name, commit: options.trackedHead ?? 'tracked-head-0', isDefault: true };
		},
		async createPullRequest(prOptions: Omit<CreatePROptions, 'owner' | 'repo'>): Promise<GitPullRequest> {
			state.calls.push('createPullRequest');
			if (options.failPullRequest) throw options.failPullRequest;
			if (openPullRequests.some((open) => open.head === prOptions.head && open.state === 'open')) {
				throw pullRequestExistsError(options.pullRequestExistsShape ?? 'coded');
			}
			const number = nextPullRequestNumber;
			nextPullRequestNumber += 1;
			const created: GitPullRequest = {
				number,
				title: prOptions.title,
				state: 'open',
				head: prOptions.head,
				base: prOptions.base,
				url: `https://github.com/ever-works/fixture-app/pull/${number}`,
				createdAt: '2026-09-18T00:00:00Z',
				updatedAt: '2026-09-18T00:00:00Z'
			};
			openPullRequests.push(created);
			state.pullRequests.push(prOptions);
			return created;
		}
	};

	return { writer, state, commitInputs: () => state.commits };
}

const WORKFLOW_PATH = APP_BUILD_WORKFLOW_PATH;

/** The open pull request GitHub holds for the delivery branch, for the cases that start with one. */
function openPullRequest(number = 7, url = `https://github.com/ever-works/fixture-app/pull/${number}`): GitPullRequest {
	return {
		number,
		title: WORKFLOW_PULL_REQUEST_TITLE,
		state: 'open',
		head: APP_BUILD_WORKFLOW_BRANCH,
		base: TRACKED,
		url,
		createdAt: '2026-09-17T00:00:00Z',
		updatedAt: '2026-09-17T00:00:00Z'
	};
}

/** A branch-rules port answering what a test needs, with the rules read counted. */
function fakeProtection(options: {
	classic?: BranchProtectionResponse<Record<string, unknown>>;
	rules?: readonly BranchRulePayload[];
}): { port: BranchProtectionPort; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		port: {
			async readBranchProtection() {
				calls.push('classic');
				return (options.classic ?? { ok: false, status: 404 }) as BranchProtectionResponse<
					Record<string, unknown>
				>;
			},
			async readBranchRules({ page }) {
				calls.push(`rules:${page}`);
				return { ok: true, status: 200, data: options.rules ?? [] };
			}
		}
	};
}

function writeInput(overrides: Partial<WorkflowWriteInput> = {}): WorkflowWriteInput {
	return {
		repository: { owner: OWNER, repo: REPO, trackedBranch: TRACKED, createdByAppWork: true },
		content: CONTENT,
		lastWrittenWorkflowSha256: sha256Hex(FIRST_CONTENT),
		...overrides
	};
}

describe('workflow writer — the contract it is allowed to use (plan §1.2)', () => {
	it('never clones: it calls the four RepositoryWriter members and nothing else', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		await writeWorkflow(writeInput(), writer, fakeProtection({}).port);
		const members = new Set(state.calls.map((call) => call.split(':')[0]));
		expect([...members].sort()).toEqual(['commitFiles', 'createBranch', 'getFileContent']);
		expect(Object.keys(writer).sort()).toEqual([
			'commitFiles',
			'createBranch',
			'createPullRequest',
			'getFileContent'
		]);
	});

	it('never asks for a force update and commits exactly one file, at one path', async () => {
		const { writer, commitInputs } = fakeWriter({ tracked: FIRST_CONTENT });
		await writeWorkflow(writeInput(), writer);
		const [commit] = commitInputs();
		expect(Object.keys(commit)).toEqual(['branch', 'baseSha', 'message', 'files']);
		expect(commit).not.toHaveProperty('force');
		expect(commit.files.map((file) => file.path)).toEqual([WORKFLOW_PATH]);
		expect(commit.branch).toBe(TRACKED);
		expect(commit.message).toBe(WORKFLOW_COMMIT_MESSAGE_UPDATE);
	});

	it('reads the tracked branch head through createBranch(branch, branch) when no reader is given', async () => {
		const { writer, state, commitInputs } = fakeWriter({ tracked: FIRST_CONTENT, trackedHead: 'head-abc' });
		await writeWorkflow(writeInput(), writer);
		expect(state.branchNamesCreated).toContain(TRACKED);
		expect(commitInputs()[0].baseSha).toBe('head-abc');
	});

	it('prefers the facade-supplied head reader when there is one', async () => {
		const resolveTrackedHead = vi.fn().mockResolvedValue('head-from-facade');
		const { writer, commitInputs } = fakeWriter({ tracked: FIRST_CONTENT });
		await writeWorkflow(writeInput({ resolveTrackedHead }), writer);
		expect(resolveTrackedHead).toHaveBeenCalledTimes(1);
		expect(commitInputs()[0].baseSha).toBe('head-from-facade');
	});
});

describe('workflow writer — the direct path (ACC-05-01)', () => {
	it('commits exactly the one workflow path on an unprotected branch', async () => {
		const { writer, state, commitInputs } = fakeWriter({ tracked: FIRST_CONTENT });
		const result = await writeWorkflow(writeInput(), writer, fakeProtection({}).port);

		expect(result.state).toBe('committed');
		expect(result.commitSha).toBe('commit-1');
		expect(result.storedWorkflowSha256).toBe(sha256Hex(CONTENT));
		expect(state.calls.filter((call) => call.startsWith('commitFiles'))).toEqual([`commitFiles:${TRACKED}`]);
		expect(state.pullRequests).toEqual([]);
		expect(commitInputs()[0].files).toEqual([{ path: WORKFLOW_PATH, content: CONTENT, encoding: 'utf-8' }]);
	});

	it('says Add when the file does not exist yet, and Update when it does', async () => {
		const fresh = fakeWriter({ tracked: null });
		await writeWorkflow(writeInput({ lastWrittenWorkflowSha256: null }), fresh.writer);
		expect(fresh.commitInputs()[0].message).toBe(WORKFLOW_COMMIT_MESSAGE_ADD);

		const existing = fakeWriter({ tracked: FIRST_CONTENT });
		await writeWorkflow(writeInput(), existing.writer);
		expect(existing.commitInputs()[0].message).toBe(WORKFLOW_COMMIT_MESSAGE_UPDATE);
	});

	it('stores the hash only after a matching read-back (FR-8)', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		await writeWorkflow(writeInput(), writer);
		expect(state.calls).toContain(`getFileContent:${WORKFLOW_PATH}@commit-1`);
	});

	it('is unchanged, with zero write calls, when the bytes already match', async () => {
		const { writer, state } = fakeWriter({ tracked: CONTENT });
		const result = await writeWorkflow(writeInput(), writer, fakeProtection({}).port);

		expect(result).toEqual({ state: 'unchanged', storedWorkflowSha256: sha256Hex(CONTENT) });
		expect(state.commits).toEqual([]);
		expect(state.pullRequests).toEqual([]);
		expect(state.calls.every((call) => call.startsWith('getFileContent'))).toBe(true);
	});

	it('retries a nonFastForward up to the attempt bound, then refuses', async () => {
		const failure = { code: 'nonFastForward' as const, calls: [1, 2, 3] };
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT, failCommit: failure, trackedHead: 'head-1' });
		const result = await writeWorkflow(writeInput(), writer, fakeProtection({}).port);

		expect(result.state).toBe('blocked');
		expect(result.blocked).toEqual({
			reason: 'workflowWriteFailed',
			detail: { cause: 'nonFastForward' }
		});
		expect(result.storedWorkflowSha256).toBeNull();
		expect(state.commits).toHaveLength(WORKFLOW_WRITE_MAX_ATTEMPTS);
	});

	it('succeeds when the second attempt is accepted', async () => {
		const { writer } = fakeWriter({ tracked: FIRST_CONTENT, failCommit: { code: 'nonFastForward', calls: [1] } });
		const result = await writeWorkflow(writeInput(), writer);
		expect(result.state).toBe('committed');
		expect(result.commitSha).toBe('commit-2');
	});

	it('refuses with workflowWriteFailed when the read-back never matches (FR-8)', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT, readBackOverride: 'something else entirely' });
		const result = await writeWorkflow(writeInput(), writer);

		expect(result.state).toBe('blocked');
		expect(result.blocked).toEqual({ reason: 'workflowWriteFailed', detail: { cause: 'readBackMismatch' } });
		expect(result.storedWorkflowSha256).toBeNull();
		// One read-back, one retry, and nothing else.
		const readBacks = state.calls.filter((call) => call.includes('@commit-1'));
		expect(readBacks).toHaveLength(2);
	});
});

describe('workflow writer — hand edits are never overwritten (ACC-05-04, FR-9)', () => {
	it('detects a hand-edited file and takes the pull request path', async () => {
		const handEdited = 'name: Ever Works build\n# the owner edited this\n';
		const { writer, state, commitInputs } = fakeWriter({ tracked: handEdited });
		const result = await writeWorkflow(writeInput(), writer, fakeProtection({}).port);

		expect(result.state).toBe('editedByHand');
		expect(result.pullRequestNumber).toBe(7);
		expect(result.pullRequestUrl).toBe('https://github.com/ever-works/fixture-app/pull/7');
		expect(commitInputs().map((commit) => commit.branch)).toEqual([APP_BUILD_WORKFLOW_BRANCH]);
		expect(state.commits.some((commit) => commit.branch === TRACKED)).toBe(false);
	});

	it('treats a file it never wrote as a hand edit, even on an unprotected branch', async () => {
		const { writer } = fakeWriter({ tracked: FIRST_CONTENT });
		const result = await writeWorkflow(writeInput({ lastWrittenWorkflowSha256: null }), writer);
		expect(result.state).toBe('editedByHand');
	});

	it('never overwrites a hand edit when the branch is protected as well', async () => {
		const { writer, state } = fakeWriter({ tracked: 'hand edited\n' });
		const result = await writeWorkflow(
			writeInput(),
			writer,
			fakeProtection({ classic: { ok: true, status: 200, data: { required_pull_request_reviews: {} } } }).port
		);
		expect(result.state).toBe('editedByHand');
		expect(state.commits.every((commit) => commit.branch === APP_BUILD_WORKFLOW_BRANCH)).toBe(true);
	});
});

describe('workflow writer — branch protection decides the path (APW05-G16, R-4)', () => {
	it('takes the pull request path on a branch requiring reviews', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		const result = await writeWorkflow(
			writeInput(),
			writer,
			fakeProtection({ classic: { ok: true, status: 200, data: { required_pull_request_reviews: {} } } }).port
		);

		expect(result.state).toBe('pullRequestOpened');
		expect(state.commits.map((commit) => commit.branch)).toEqual([APP_BUILD_WORKFLOW_BRANCH]);
	});

	it('takes the pull request path on a branch requiring status checks', async () => {
		const { writer } = fakeWriter({ tracked: FIRST_CONTENT });
		const result = await writeWorkflow(
			writeInput(),
			writer,
			fakeProtection({ classic: { ok: true, status: 200, data: { required_status_checks: {} } } }).port
		);
		expect(result.state).toBe('pullRequestOpened');
	});

	it('treats a 403 as protected', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		const result = await writeWorkflow(
			writeInput(),
			writer,
			fakeProtection({ classic: { ok: false, status: 403 } }).port
		);
		expect(result.state).toBe('pullRequestOpened');
		expect(state.commits.map((commit) => commit.branch)).toEqual([APP_BUILD_WORKFLOW_BRANCH]);
	});

	it('takes the pull request path when only a ruleset protects a branch the legacy endpoint calls open', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		const protection = fakeProtection({ classic: { ok: false, status: 404 }, rules: [{ type: 'pull_request' }] });
		const result = await writeWorkflow(writeInput(), writer, protection.port);

		expect(result.state).toBe('pullRequestOpened');
		expect(protection.calls).toEqual(['classic', 'rules:1']);
		expect(state.commits.every((commit) => commit.branch === APP_BUILD_WORKFLOW_BRANCH)).toBe(true);
	});

	it('always takes the pull request path for a Link relation, whatever the branch says (R-4)', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		const protection = fakeProtection({});
		const result = await writeWorkflow(
			writeInput({ repository: { owner: OWNER, repo: REPO, trackedBranch: TRACKED, createdByAppWork: false } }),
			writer,
			protection.port
		);

		expect(result.state).toBe('pullRequestOpened');
		expect(result.pullRequestUrl).toBe('https://github.com/ever-works/fixture-app/pull/7');
		// `workflowPending` is the runner's mapping of this state (T19): what matters
		// here is that the tracked branch received no commit at all.
		expect(state.commits.some((commit) => commit.branch === TRACKED)).toBe(false);
		expect(protection.calls).toEqual([]);
	});

	it('switches to the pull request path exactly once when the direct write is refused by a rule', async () => {
		const { writer, state } = fakeWriter({
			tracked: FIRST_CONTENT,
			failCommit: { code: 'refRejectedByRule', calls: [1] }
		});
		const result = await writeWorkflow(writeInput(), writer, fakeProtection({}).port);

		expect(result.state).toBe('pullRequestOpened');
		expect(state.commits.map((commit) => commit.branch)).toEqual([TRACKED, APP_BUILD_WORKFLOW_BRANCH]);
		expect(state.pullRequests).toHaveLength(1);
		expect(repositoryWriteErrorCode(Object.assign(new Error('x'), { code: 'refRejectedByRule' }))).toBe(
			'refRejectedByRule'
		);
	});

	it('stops with workflowWriteFailed when the pull request path is refused too — never a loop', async () => {
		const { writer, state } = fakeWriter({
			tracked: FIRST_CONTENT,
			failCommit: { code: 'refRejectedByRule', calls: [1, 2] }
		});
		const result = await writeWorkflow(writeInput(), writer, fakeProtection({}).port);

		expect(result.state).toBe('blocked');
		expect(result.blocked).toEqual({ reason: 'workflowWriteFailed', detail: { cause: 'branchRules' } });
		expect(result.storedWorkflowSha256).toBeNull();
		expect(state.commits).toHaveLength(2);
		expect(state.pullRequests).toEqual([]);
	});

	it('reads the rules endpoint only when the classic endpoint does not decide (APW05-G16)', async () => {
		const { writer } = fakeWriter({ tracked: FIRST_CONTENT });
		const protection = fakeProtection({
			classic: { ok: true, status: 200, data: { required_pull_request_reviews: {} } }
		});
		await writeWorkflow(writeInput(), writer, protection.port);
		expect(protection.calls).toEqual(['classic']);
	});
});

describe('workflow writer — one pull request, reused (ACC-05-02)', () => {
	it('reuses the open pull request on the second and third preparation', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		const protection = fakeProtection({
			classic: { ok: true, status: 200, data: { required_pull_request_reviews: {} } }
		}).port;

		const first = await writeWorkflow(writeInput(), writer, protection);
		const second = await writeWorkflow(
			writeInput({ pullRequestNumber: first.pullRequestNumber, pullRequestUrl: first.pullRequestUrl }),
			writer,
			protection
		);
		const third = await writeWorkflow(
			writeInput({
				content: `${CONTENT}# a later change\n`,
				pullRequestNumber: first.pullRequestNumber,
				pullRequestUrl: first.pullRequestUrl
			}),
			writer,
			protection
		);

		expect(first.state).toBe('pullRequestOpened');
		expect(second.state).toBe('pullRequestUpdated');
		expect(third.state).toBe('pullRequestUpdated');
		expect(state.pullRequests).toHaveLength(1);
		expect(second.pullRequestNumber).toBe(first.pullRequestNumber);
		expect(third.pullRequestUrl).toBe(first.pullRequestUrl);
	});

	it('adds no commit when the pull request branch already carries the bytes', async () => {
		const { writer, state } = fakeWriter({
			tracked: FIRST_CONTENT,
			branch: CONTENT,
			existingPullRequest: openPullRequest(7, 'https://example.invalid/pr/7')
		});
		const result = await writeWorkflow(
			writeInput({ pullRequestNumber: 7, pullRequestUrl: 'https://example.invalid/pr/7' }),
			writer,
			fakeProtection({ classic: { ok: false, status: 403 } }).port
		);

		expect(result.state).toBe('pullRequestUpdated');
		expect(state.commits).toEqual([]);
		expect(state.pullRequests).toEqual([]);
	});

	it('opens the pull request with the plan §4.6 title onto the tracked branch', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		await writeWorkflow(
			writeInput({ pullRequestNumber: null }),
			writer,
			fakeProtection({ classic: { ok: false, status: 403 } }).port
		);

		expect(state.pullRequests[0].title).toBe(WORKFLOW_PULL_REQUEST_TITLE);
		expect(state.pullRequests[0].head).toBe(APP_BUILD_WORKFLOW_BRANCH);
		expect(state.pullRequests[0].base).toBe(TRACKED);
		expect(state.branchNamesCreated).toContain(APP_BUILD_WORKFLOW_BRANCH);
	});

	// No production caller had a stored number to pass (the prepare input carried
	// none), so every PR-path preparation after the first called create, and
	// GitHub's "already exists" escaped as a thrown 422. GitHub, not the stored
	// number, is what says the open pull request is there.
	it.each<PullRequestExistsShape>(['coded', 'github422'])(
		'adopts the open pull request GitHub reports, with no stored number (%s refusal)',
		async (shape) => {
			const { writer, state } = fakeWriter({
				tracked: FIRST_CONTENT,
				existingPullRequest: openPullRequest(),
				pullRequestExistsShape: shape
			});
			const result = await writeWorkflow(
				writeInput({
					repository: { owner: OWNER, repo: REPO, trackedBranch: TRACKED, createdByAppWork: false }
				}),
				writer
			);

			expect(result.state).toBe('pullRequestUpdated');
			expect(result.storedWorkflowSha256).toBeNull();
			// Nothing to echo back: the writer never invents a number or a link.
			expect(result).not.toHaveProperty('pullRequestNumber');
			expect(result).not.toHaveProperty('pullRequestUrl');
			expect(state.pullRequests).toEqual([]);
			expect(state.commits.map((commit) => commit.branch)).toEqual([APP_BUILD_WORKFLOW_BRANCH]);
		}
	);

	it('echoes the stored pull request back when GitHub reports it still open', async () => {
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT, existingPullRequest: openPullRequest() });
		const result = await writeWorkflow(
			writeInput({
				repository: { owner: OWNER, repo: REPO, trackedBranch: TRACKED, createdByAppWork: false },
				pullRequestNumber: 7,
				pullRequestUrl: 'https://github.com/ever-works/fixture-app/pull/7'
			}),
			writer
		);

		expect(result).toMatchObject({
			state: 'pullRequestUpdated',
			pullRequestNumber: 7,
			pullRequestUrl: 'https://github.com/ever-works/fixture-app/pull/7'
		});
		expect(state.calls).toContain('createPullRequest');
		expect(state.pullRequests).toEqual([]);
	});

	it('opens a new pull request when the stored one was closed, never "updating" a closed one', async () => {
		// The stored #3 is closed: GitHub has no open pull request for the head, so
		// the create succeeds. Trusting the stored number would leave the Builds
		// waiting on a pull request nobody can merge.
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		const result = await writeWorkflow(
			writeInput({
				repository: { owner: OWNER, repo: REPO, trackedBranch: TRACKED, createdByAppWork: false },
				pullRequestNumber: 3,
				pullRequestUrl: 'https://github.com/ever-works/fixture-app/pull/3'
			}),
			writer
		);

		expect(result.state).toBe('pullRequestOpened');
		expect(result.pullRequestNumber).toBe(7);
		expect(result.pullRequestUrl).toBe('https://github.com/ever-works/fixture-app/pull/7');
		expect(state.pullRequests).toHaveLength(1);
	});

	it('keeps editedByHand when a hand-edited file finds its pull request already open', async () => {
		const { writer } = fakeWriter({ tracked: 'hand edited\n', existingPullRequest: openPullRequest() });
		const result = await writeWorkflow(
			writeInput({ pullRequestNumber: 7, pullRequestUrl: 'https://github.com/ever-works/fixture-app/pull/7' }),
			writer
		);
		expect(result.state).toBe('editedByHand');
		expect(result.pullRequestNumber).toBe(7);
	});

	it('still throws a 422 that is not "already exists"', async () => {
		const noCommits = Object.assign(
			new Error(
				'Validation Failed: {"resource":"PullRequest","code":"custom","message":"No commits between main and ever-works/build-workflow"}'
			),
			{
				status: 422,
				response: {
					data: {
						message: 'Validation Failed',
						errors: [
							{
								resource: 'PullRequest',
								code: 'custom',
								message: 'No commits between main and ever-works/build-workflow'
							}
						]
					}
				}
			}
		);
		const { writer } = fakeWriter({ tracked: FIRST_CONTENT, failPullRequest: noCommits });
		await expect(
			writeWorkflow(
				writeInput({
					repository: { owner: OWNER, repo: REPO, trackedBranch: TRACKED, createdByAppWork: false }
				}),
				writer
			)
		).rejects.toBe(noCommits);
	});

	it('recognises "already exists" by the contract code first, and by the GitHub 422 only as a fallback', () => {
		expect(repositoryWriteErrorCode(Object.assign(new Error('x'), { code: 'pullRequestExists' }))).toBe(
			'pullRequestExists'
		);
		expect(repositoryWriteErrorCode(Object.assign(new Error('x'), { reason: 'pullRequestExists' }))).toBe(
			'pullRequestExists'
		);
		expect(isPullRequestAlreadyExistsError(pullRequestExistsError('coded'))).toBe(true);
		expect(isPullRequestAlreadyExistsError(pullRequestExistsError('github422'))).toBe(true);
		// The errors[] shape alone, with a top-level message that says nothing.
		expect(
			isPullRequestAlreadyExistsError(
				Object.assign(new Error('Validation Failed'), {
					status: 422,
					response: { data: { errors: [{ message: ALREADY_EXISTS_MESSAGE }] } }
				})
			)
		).toBe(true);
		// The wording without the 422 is not enough, and a 422 without the wording is not either.
		expect(isPullRequestAlreadyExistsError(new Error(ALREADY_EXISTS_MESSAGE))).toBe(false);
		expect(
			isPullRequestAlreadyExistsError(
				Object.assign(new Error('Validation Failed: No commits between main and ever-works/build-workflow'), {
					status: 422
				})
			)
		).toBe(false);
		expect(isPullRequestAlreadyExistsError(Object.assign(new Error('x'), { code: 'refRejectedByRule' }))).toBe(
			false
		);
		expect(isPullRequestAlreadyExistsError(null)).toBe(false);
		expect(isPullRequestAlreadyExistsError(undefined)).toBe(false);
	});
});

describe('workflow writer — the bootstrap delivery of plan §4.6 step 0 (APW05-G02)', () => {
	it('lands exactly one bootstrap commit when the branch has no workflow at all', async () => {
		const { writer, state, commitInputs } = fakeWriter({ tracked: null });
		const result = await writeWorkflow(
			writeInput({ lastWrittenWorkflowSha256: null }),
			writer,
			fakeProtection({}).port
		);

		expect(result.state).toBe('committed');
		expect(state.commits).toHaveLength(1);
		expect(commitInputs()[0].message).toBe(WORKFLOW_COMMIT_MESSAGE_ADD);
		expect(commitInputs()[0].files[0].content).toContain('  verify:');
		expect(commitInputs()[0].files[0].content).not.toContain('  build:');
	});

	it('does not call a bootstrap file on the tracked branch a hand edit on the next preparation', async () => {
		// The bootstrap bytes are what the platform wrote, so the second preparation
		// finds `lastWrittenWorkflowSha256` equal to them and delivers normally.
		const { writer } = fakeWriter({ tracked: CONTENT });
		const result = await writeWorkflow(
			writeInput({ lastWrittenWorkflowSha256: sha256Hex(CONTENT) }),
			writer,
			fakeProtection({}).port
		);
		expect(result.state).toBe('unchanged');
	});

	it('gives a Link relation the pull request URL and no commit on the tracked branch', async () => {
		const { writer, state } = fakeWriter({ tracked: null });
		const result = await writeWorkflow(
			writeInput({
				repository: { owner: OWNER, repo: REPO, trackedBranch: TRACKED, createdByAppWork: false },
				lastWrittenWorkflowSha256: null
			}),
			writer
		);

		expect(result.state).toBe('pullRequestOpened');
		expect(result.pullRequestUrl).toBeDefined();
		expect(state.commits.map((commit) => commit.branch)).toEqual([APP_BUILD_WORKFLOW_BRANCH]);
	});
});

/**
 * APW-05 T42 — the removal of §4.6 step 8 (FR-70, ACC-05-30).
 *
 * The generator answers `''` once neither a build nor a check remains
 * (`generator.ts`, T42's checks-only branch), and §4.6 step 8 says what the
 * delivery does with that: "with no checks, nothing is written and an existing
 * checks-only file the platform wrote is replaced by a pull request removing the
 * jobs — **never deleted directly**".
 *
 * So an empty `content` means: the pull request path, always, whatever the branch
 * protection or the relation says; the file's bytes on the pull-request branch
 * become empty, which is the shape "removing the jobs" has through a writer whose
 * four members (plan §4.1:749–751) carry no deletion; and with no file on the
 * tracked branch there is nothing to remove at all — no commit, no pull request.
 */
describe('workflow writer — the removal no build and no check leaves (T42, FR-70, ACC-05-30)', () => {
	it('proposes the removal by pull request, never on the tracked branch', async () => {
		const { writer, state, commitInputs } = fakeWriter({ tracked: CONTENT });
		const result = await writeWorkflow(
			writeInput({ content: '', lastWrittenWorkflowSha256: sha256Hex(CONTENT) }),
			writer,
			fakeProtection({}).port
		);

		expect(result.state).toBe('pullRequestOpened');
		expect(result.pullRequestNumber).toBe(7);
		expect(result.pullRequestUrl).toBe('https://github.com/ever-works/fixture-app/pull/7');
		// No commit on the tracked branch, and exactly one on the delivery branch.
		expect(state.commits.map((commit) => commit.branch)).toEqual([APP_BUILD_WORKFLOW_BRANCH]);
		expect(commitInputs()[0].files).toEqual([{ path: WORKFLOW_PATH, content: '', encoding: 'utf-8' }]);
		expect(commitInputs()[0].message).toBe(WORKFLOW_COMMIT_MESSAGE_REMOVE);
		// The pull request says what it is: not "Add Ever Works build workflow".
		expect(state.pullRequests[0].title).toBe(WORKFLOW_REMOVAL_PULL_REQUEST_TITLE);
		expect(state.pullRequests[0].title).not.toBe(WORKFLOW_PULL_REQUEST_TITLE);
		expect(state.pullRequests[0].head).toBe(APP_BUILD_WORKFLOW_BRANCH);
		expect(state.pullRequests[0].base).toBe(TRACKED);
		// No stored hash: nothing was proven to equal the generated bytes.
		expect(result.storedWorkflowSha256).toBeNull();
	});

	it('writes nothing at all when the tracked branch has no workflow to remove', async () => {
		const { writer, state } = fakeWriter({ tracked: null });
		const result = await writeWorkflow(writeInput({ content: '', lastWrittenWorkflowSha256: null }), writer);

		expect(result).toEqual({ state: 'unchanged', storedWorkflowSha256: null });
		expect(state.commits).toEqual([]);
		expect(state.pullRequests).toEqual([]);
		expect(state.calls.every((call) => call.startsWith('getFileContent'))).toBe(true);
	});

	it('updates the one open pull request instead of opening a second', async () => {
		const { writer, state } = fakeWriter({
			tracked: CONTENT,
			existingPullRequest: openPullRequest(7, 'https://example.invalid/pr/7')
		});
		const result = await writeWorkflow(
			writeInput({
				content: '',
				lastWrittenWorkflowSha256: sha256Hex(CONTENT),
				pullRequestNumber: 7,
				pullRequestUrl: 'https://example.invalid/pr/7'
			}),
			writer
		);

		expect(result.state).toBe('pullRequestUpdated');
		expect(result.pullRequestNumber).toBe(7);
		expect(state.pullRequests).toEqual([]);
		expect(state.commits.map((commit) => commit.branch)).toEqual([APP_BUILD_WORKFLOW_BRANCH]);
	});

	it('takes the pull request path even where a direct commit would be allowed (never deleted directly)', async () => {
		// An unprotected branch the App Work created, no hand edit: the only case in
		// which the direct path is available. The removal still does not use it.
		const { writer, state } = fakeWriter({ tracked: CONTENT });
		await writeWorkflow(
			writeInput({ content: '', lastWrittenWorkflowSha256: sha256Hex(CONTENT) }),
			writer,
			fakeProtection({ classic: { ok: false, status: 404 } }).port
		);
		expect(state.commits.some((commit) => commit.branch === TRACKED)).toBe(false);
		// And the protection read is not even made: there is no direct path to guard.
		expect(state.branchNamesCreated).toContain(APP_BUILD_WORKFLOW_BRANCH);
		expect(state.branchNamesCreated).not.toContain(TRACKED);
	});

	it('adds no commit to the delivery branch when it already carries the empty content', async () => {
		const { writer, state } = fakeWriter({
			tracked: CONTENT,
			branch: '',
			existingPullRequest: openPullRequest(7, 'https://example.invalid/pr/7')
		});
		const result = await writeWorkflow(
			writeInput({
				content: '',
				lastWrittenWorkflowSha256: sha256Hex(CONTENT),
				pullRequestNumber: 7,
				pullRequestUrl: 'https://example.invalid/pr/7'
			}),
			writer
		);
		expect(result.state).toBe('pullRequestUpdated');
		expect(state.commits).toEqual([]);
	});

	it('leaves every non-empty delivery exactly as it was (ACC-05-01, ACC-05-02)', async () => {
		// The removal branch is keyed on the EMPTY content alone; one character is
		// enough to keep the normal rules in force.
		const { writer, state } = fakeWriter({ tracked: FIRST_CONTENT });
		const result = await writeWorkflow(writeInput({ content: '\n' }), writer, fakeProtection({}).port);
		expect(result.state).toBe('committed');
		expect(state.commits.map((commit) => commit.branch)).toEqual([TRACKED]);
		expect(state.pullRequests).toEqual([]);
	});
});

describe('branch protection — the two reads (plan §4.6 step 1, APW05-G16)', () => {
	const coordinates = { owner: OWNER, repo: REPO, branch: TRACKED };

	it('reports unprotected when both reads answer 404', async () => {
		const protection = fakeProtection({ classic: { ok: false, status: 404 } });
		expect(await isBranchProtected(protection.port, coordinates)).toEqual({ protected: false, decision: 'none' });
	});

	it('reports protected by reviews, checks, a ruleset or a 403, and says which', async () => {
		expect(
			await isBranchProtected(
				fakeProtection({ classic: { ok: true, status: 200, data: { required_pull_request_reviews: {} } } })
					.port,
				coordinates
			)
		).toEqual({ protected: true, decision: 'requiredPullRequestReviews' });
		expect(
			await isBranchProtected(
				fakeProtection({ classic: { ok: true, status: 200, data: { required_status_checks: {} } } }).port,
				coordinates
			)
		).toEqual({ protected: true, decision: 'requiredStatusChecks' });
		expect(
			await isBranchProtected(fakeProtection({ classic: { ok: false, status: 403 } }).port, coordinates)
		).toEqual({
			protected: true,
			decision: 'forbidden'
		});
		expect(
			await isBranchProtected(
				fakeProtection({ classic: { ok: false, status: 404 }, rules: [{ type: 'pull_request' }] }).port,
				coordinates
			)
		).toEqual({ protected: true, decision: 'rulesetPullRequest' });
		expect(
			await isBranchProtected(
				fakeProtection({ classic: { ok: false, status: 404 }, rules: [{ type: 'required_status_checks' }] })
					.port,
				coordinates
			)
		).toEqual({ protected: true, decision: 'rulesetStatusChecks' });
	});

	it('ignores a rule that is not active and a rule of another type', async () => {
		const protection = fakeProtection({
			classic: { ok: false, status: 404 },
			rules: [
				{ type: 'pull_request', enforcement: 'disabled' },
				{ type: 'creation' },
				{ type: 'non_fast_forward' }
			]
		});
		expect(await isBranchProtected(protection.port, coordinates)).toEqual({ protected: false, decision: 'none' });
	});

	it('treats an unreadable rules endpoint as no rules known locally', async () => {
		const calls: string[] = [];
		const port: BranchProtectionPort = {
			async readBranchProtection() {
				calls.push('classic');
				return { ok: false, status: 404 };
			},
			async readBranchRules() {
				calls.push('rules');
				return { ok: false, status: 403 };
			}
		};
		expect(await isBranchProtected(port, coordinates)).toEqual({ protected: false, decision: 'none' });
		expect(calls).toEqual(['classic', 'rules']);
	});
});
