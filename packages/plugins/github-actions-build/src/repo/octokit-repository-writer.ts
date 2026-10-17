import type {
	CreatePROptions,
	GitBranch,
	GitPullRequest,
	RepositoryCommitInput,
	RepositoryWriteErrorCode,
	RepositoryWriter
} from '@ever-works/plugin';

/**
 * APW-05 T16 remainder (outstanding-work A0.4, ledger D19) — the clone-free
 * {@link RepositoryWriter} over GitHub's REST API.
 *
 * ## Why the build plugin carries its own writer
 *
 * `prepareRepository` needs four repository operations — read a file, land one
 * commit, create a branch, open a pull request — and plan §4.1 says the facade
 * binds them "to `GitFacadeService`". That facade has three of the four but no
 * `commitFiles` (APW-03 T22 declares it and has not landed), so every production
 * prepare answered `pluginUnavailable` before the request was even built. This
 * plugin already holds Octokit and the member's token, and every one of the four
 * is a plain REST call, so it supplies the writer itself
 * (`IBuildPlugin.repositoryWriter?`) and the facade prefers it. When APW-03 T22
 * lands a git-provider `commitFiles`, the facade may bind that instead; nothing
 * in `workflow-writer.ts` changes either way.
 *
 * ## The refusal codes the contract names
 *
 * A refusal is THROWN with `code` set, which is what `repositoryWriteErrorCode`
 * reads:
 *
 *  - `nonFastForward` — `PATCH …/git/refs/heads/<branch>` answered 422 "not a
 *    fast forward": the branch moved under us, and the caller retries from a
 *    fresh head (never a force-push);
 *  - `refRejectedByRule` — 409/422 mentioning a protection rule or a
 *    required status/review: the caller switches to the pull-request path;
 *  - `pullRequestExists` — 422 "A pull request already exists";
 *  - `workflowPermissionMissing` (2026-10-17) — the credential cannot write
 *    under `.github/workflows/`: an OAuth token or classic PAT without the
 *    `workflow` scope, or a GitHub App installation without `Workflows: write`
 *    (APW-02 plan §4's permission matrix). Checked BEFORE the commit when the
 *    scopes are known or readable (`x-oauth-scopes`), and translated from
 *    GitHub's own refusal otherwise, so the member is told to reconnect GitHub
 *    with the `workflow` scope instead of seeing a bare 403/404.
 *
 * Every other failure is rethrown untouched.
 */

/** The subset of Octokit's surface this writer uses. */
export interface OctokitRequester {
	request(
		route: string,
		params?: Record<string, unknown>
	): Promise<{ data: unknown; status?: number; headers?: Record<string, unknown> }>;
}

/** What the facade knows about the credential (see `BuildAuth`). */
export interface RepositoryWriterCredential {
	readonly credential?: 'oauth' | 'githubApp' | 'pat' | 'unknown';
	readonly scopes?: readonly string[] | null;
}

/** The directory GitHub guards with the `workflow` scope / `Workflows: write` permission. */
export const WORKFLOWS_DIRECTORY = '.github/workflows/';

/** An error carrying one of the contract's refusal codes. */
export class RepositoryWriteError extends Error {
	constructor(
		readonly code: RepositoryWriteErrorCode,
		message: string,
		readonly cause?: unknown,
		/** `workflowPermissionMissing` only: which credential, and what it lacks. */
		readonly credential?: string,
		readonly missing?: string
	) {
		super(message);
		this.name = 'RepositoryWriteError';
	}
}

/**
 * The refusal for a credential that cannot write `.github/workflows/`. Names what
 * to grant: the `workflow` OAuth scope, or the App's `Workflows: write`.
 */
export function workflowPermissionMissingError(credential: string, cause?: unknown): RepositoryWriteError {
	const app = credential === 'githubApp';
	return new RepositoryWriteError(
		'workflowPermissionMissing',
		app
			? 'The GitHub App installation cannot write workflow files: grant it "Workflows: Read and write".'
			: 'The GitHub connection cannot write workflow files: reconnect GitHub and grant the "workflow" scope.',
		cause,
		credential,
		app ? 'workflows:write' : 'workflow'
	);
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

function statusOf(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === 'number' ? status : undefined;
}

function messageOf(error: unknown): string {
	const candidate = error as { message?: unknown; response?: { data?: { message?: unknown; errors?: unknown } } };
	const parts: string[] = [];
	if (typeof candidate?.message === 'string') parts.push(candidate.message);
	const data = candidate?.response?.data;
	if (typeof data?.message === 'string') parts.push(data.message);
	if (Array.isArray(data?.errors)) {
		for (const entry of data.errors) {
			const message = (entry as { message?: unknown })?.message;
			if (typeof message === 'string') parts.push(message);
		}
	}
	return parts.join(' | ');
}

/** GitHub's wording for a ref update a rule refused (branch protection, rulesets). */
const RULE_REFUSAL =
	/protected branch|ruleset|rule violation|required status|required review|push declined|cannot be updated/i;

/**
 * GitHub's wordings for "this credential may not touch a workflow file":
 * "refusing to allow an OAuth App to create or update workflow … without
 * `workflow` scope" and "… a GitHub App … without `workflows` permission".
 */
const WORKFLOW_REFUSAL = /workflow[^|]*\b(scope|permission)|\b(scope|permission)[^|]*workflow/i;

/** The App API's answer to a write the installation's permissions do not cover. */
const INTEGRATION_REFUSAL = /resource not accessible by integration/i;

/** `x-oauth-scopes` as a list, or `null` when the header is absent (App / fine-grained tokens). */
function scopesFromHeader(headers: Record<string, unknown> | undefined): string[] | null {
	const header = headers?.['x-oauth-scopes'];
	if (typeof header !== 'string') return null;
	return header
		.split(',')
		.map((scope) => scope.trim())
		.filter(Boolean);
}

/**
 * The writer for one repository, bound to one token.
 *
 * `trackedBranch` is the default `ref` for {@link RepositoryWriter.getFileContent}
 * — the contract's "default: the tracked branch".
 */
export function octokitRepositoryWriter(
	octokit: OctokitRequester,
	repository: { readonly owner: string; readonly repo: string; readonly trackedBranch?: string },
	credential: RepositoryWriterCredential = {}
): RepositoryWriter {
	const base = { owner: repository.owner, repo: repository.repo };
	const kind = credential.credential ?? 'unknown';

	async function headOf(ref: string): Promise<string> {
		if (FULL_SHA.test(ref)) return ref;
		const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
			...base,
			ref: `heads/${ref}`
		});
		const sha = (data as { object?: { sha?: unknown } })?.object?.sha;
		if (typeof sha !== 'string') throw new Error(`github-actions-build: no head commit for ${ref}`);
		return sha;
	}

	/**
	 * Before a commit that touches `.github/workflows/`: a credential whose scopes
	 * are known (or readable from `GET /user`'s `x-oauth-scopes`) and lack
	 * `workflow` is refused up front, with nothing written. A GitHub App token
	 * answers no scopes header; its permissions are left to the write's own answer.
	 */
	async function assertCanWriteWorkflows(): Promise<void> {
		if (kind === 'githubApp') return;
		let scopes: readonly string[] | null = credential.scopes ?? null;
		if (!scopes) {
			try {
				scopes = scopesFromHeader((await octokit.request('GET /user')).headers);
			} catch {
				scopes = null;
			}
		}
		if (scopes && !scopes.includes('workflow')) {
			throw workflowPermissionMissingError(kind === 'pat' ? 'pat' : 'oauth');
		}
	}

	/**
	 * A write refusal on a workflow commit, translated when it is GitHub's workflow
	 * guard — only the explicit "… workflow … scope/permission" wording. The App's
	 * generic "Resource not accessible by integration" is NOT read as a workflow
	 * refusal here: it is just as much a missing `Contents: write` (CodeRabbit
	 * #2686). See the ref update in {@link commit} for the one place it is.
	 */
	function translateWorkflowRefusal(error: unknown, touchesWorkflows: boolean): unknown {
		if (!touchesWorkflows || error instanceof RepositoryWriteError) return error;
		const message = messageOf(error);
		if (WORKFLOW_REFUSAL.test(message)) {
			return workflowPermissionMissingError(/github app|integration/i.test(message) ? 'githubApp' : kind, error);
		}
		return error;
	}

	/** The four-call commit of {@link RepositoryWriter.commitFiles}. */
	async function commit(input: RepositoryCommitInput, touchesWorkflows: boolean): Promise<{ commitSha: string }> {
		const { data: baseCommit } = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
			...base,
			commit_sha: input.baseSha
		});
		const baseTree = (baseCommit as { tree?: { sha?: unknown } })?.tree?.sha;
		if (typeof baseTree !== 'string') {
			throw new Error(`github-actions-build: commit ${input.baseSha} has no tree`);
		}

		const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = [];
		for (const file of input.files) {
			const { data: blob } = await octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
				...base,
				content: file.content,
				encoding: file.encoding === 'base64' ? 'base64' : 'utf-8'
			});
			const sha = (blob as { sha?: unknown })?.sha;
			if (typeof sha !== 'string') throw new Error(`github-actions-build: no blob sha for ${file.path}`);
			tree.push({ path: file.path, mode: '100644', type: 'blob', sha });
		}

		const { data: newTree } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
			...base,
			base_tree: baseTree,
			tree
		});
		const { data: created } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
			...base,
			message: input.message,
			tree: (newTree as { sha: string }).sha,
			parents: [input.baseSha]
		});
		const commitSha = (created as { sha: string }).sha;

		try {
			await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
				...base,
				ref: `heads/${input.branch}`,
				sha: commitSha,
				// Never a force-push: a moved branch is `nonFastForward`.
				force: false
			});
		} catch (error) {
			const status = statusOf(error);
			const message = messageOf(error);
			if (status === 422 && /fast[ -]?forward/i.test(message)) {
				throw new RepositoryWriteError(
					'nonFastForward',
					`${input.branch} moved; retry from its new head`,
					error
				);
			}
			if ((status === 409 || status === 422 || status === 403) && RULE_REFUSAL.test(message)) {
				throw new RepositoryWriteError('refRejectedByRule', `${input.branch} refused the update`, error);
			}
			// The blob, tree and commit above were written, so `Contents: write` is
			// granted; an App refusing only the ref update of a workflow commit is the
			// missing `Workflows: write`. Earlier in the sequence the same wording is a
			// different missing permission and is passed through untouched.
			if (touchesWorkflows && status === 403 && INTEGRATION_REFUSAL.test(message)) {
				throw workflowPermissionMissingError('githubApp', error);
			}
			throw error;
		}
		return { commitSha };
	}

	return {
		async getFileContent(path, ref) {
			try {
				const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
					...base,
					path,
					...((ref ?? repository.trackedBranch) ? { ref: ref ?? repository.trackedBranch } : {})
				});
				const file = data as { type?: unknown; content?: unknown; encoding?: unknown };
				if (Array.isArray(data) || file?.type !== 'file' || typeof file.content !== 'string') return null;
				return {
					content: file.content,
					encoding: typeof file.encoding === 'string' ? file.encoding : 'base64'
				};
			} catch (error) {
				// A file that does not exist is not an error (plan §4.6 steps 4, 5).
				if (statusOf(error) === 404) return null;
				throw error;
			}
		},

		async commitFiles(input: RepositoryCommitInput) {
			const touchesWorkflows = input.files.some((file) => file.path.startsWith(WORKFLOWS_DIRECTORY));
			if (touchesWorkflows) await assertCanWriteWorkflows();
			try {
				return await commit(input, touchesWorkflows);
			} catch (error) {
				throw translateWorkflowRefusal(error, touchesWorkflows);
			}
		},

		async createBranch(name: string, fromRef: string): Promise<GitBranch> {
			try {
				const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
					...base,
					branch: name
				});
				const branch = data as { name?: string; commit?: { sha?: string }; protected?: boolean };
				// An existing branch is returned rather than recreated (the contract).
				return {
					name: branch.name ?? name,
					commit: branch.commit?.sha ?? '',
					isDefault: false,
					isProtected: branch.protected === true
				};
			} catch (error) {
				if (statusOf(error) !== 404) throw error;
			}
			const sha = await headOf(fromRef);
			await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
				...base,
				ref: `refs/heads/${name}`,
				sha
			});
			return { name, commit: sha, isDefault: false };
		},

		async createPullRequest(options: Omit<CreatePROptions, 'owner' | 'repo'>): Promise<GitPullRequest> {
			try {
				const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
					...base,
					title: options.title,
					head: options.headOwner ? `${options.headOwner}:${options.head}` : options.head,
					base: options.base,
					...(options.body ? { body: options.body } : {}),
					...(options.draft ? { draft: true } : {})
				});
				const pr = data as {
					number: number;
					title?: string;
					state?: string;
					html_url?: string;
					created_at?: string;
					updated_at?: string;
					body?: string | null;
				};
				return {
					number: pr.number,
					title: pr.title ?? options.title,
					state: pr.state === 'closed' ? 'closed' : 'open',
					head: options.head,
					base: options.base,
					url: pr.html_url ?? '',
					createdAt: pr.created_at ?? new Date().toISOString(),
					updatedAt: pr.updated_at ?? new Date().toISOString(),
					...(pr.body ? { body: pr.body } : {})
				};
			} catch (error) {
				if (statusOf(error) === 422 && /pull request already exists/i.test(messageOf(error))) {
					throw new RepositoryWriteError('pullRequestExists', 'an open pull request already exists', error);
				}
				throw error;
			}
		}
	};
}
