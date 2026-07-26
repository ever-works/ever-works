import { Octokit, RequestError } from 'octokit';
import type {
	GitRepository,
	GitUser,
	GitOrganization,
	GitBranch,
	GitCommit,
	GitPullRequest,
	GitPullRequestAuthor,
	GitPullRequestFile,
	CreateRepoOptions,
	UpdateRepoOptions,
	CreatePROptions,
	MergeOptions,
	MergeResult,
	ForkRepositoryOptions,
	GitRepositoryWithPermissions,
	ListRepositoriesOptions,
	ListPullRequestsOptions,
	TransferRepoOptions,
	TransferRepoResult,
	GitCheckConclusion,
	GitCheckStatus,
	GitDiffFile,
	GitDiffOptions,
	GitDiffResult,
	GitPullRequestCheck,
	GitPullRequestStatus,
	GitReviewDecision
} from '@ever-works/plugin/git';
import { capChecks, capDiffFiles, deriveCiState, resolveDiffCaps } from '@ever-works/plugin/git';
import { GitHubVerifiedOrgService, parseVerifiedOrgs } from './github-verified-org.service.js';

/**
 * PR insights (kanban run cockpit M5/M6) — GitHub's check vocabulary
 * mapped onto the provider-neutral contract vocabulary. Anything not
 * listed degrades to `unknown`/`null` rather than being guessed at: an
 * unrecognised conclusion must never be laundered into a pass.
 */
const CHECK_STATUS_MAP: Record<string, GitCheckStatus> = {
	queued: 'queued',
	in_progress: 'in_progress',
	waiting: 'queued',
	requested: 'queued',
	pending: 'queued',
	completed: 'completed'
};

const CHECK_CONCLUSION_MAP: Record<string, GitCheckConclusion> = {
	success: 'success',
	failure: 'failure',
	neutral: 'neutral',
	cancelled: 'cancelled',
	timed_out: 'timed_out',
	action_required: 'action_required',
	skipped: 'skipped',
	stale: 'stale',
	// Legacy commit-status states share the rollup vocabulary.
	error: 'failure'
};

const REVIEW_DECISION_MAP: Record<string, GitReviewDecision> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes_requested',
	REVIEW_REQUIRED: 'review_required'
};

/** Pages of check-runs/statuses to read before giving up (rate budget). */
const CHECKS_PER_PAGE = 100;

/** GitHub file payload → the contract's provider-neutral diff row. */
function toDiffFile(file: {
	filename: string;
	status?: string;
	additions?: number;
	deletions?: number;
	patch?: string;
}): GitDiffFile {
	return {
		path: file.filename,
		status: file.status ?? 'modified',
		additions: file.additions ?? 0,
		deletions: file.deletions ?? 0,
		...(file.patch ? { patch: file.patch } : {})
	};
}

function sanitizeDescription(description?: string): string {
	if (!description) return '';
	return description
		.replace(/[\r\n]+/g, ' ')
		.trim()
		.slice(0, 500);
}

export class GitHubApiService {
	/**
	 * Verified-org membership check for PR authors. C-11 in the
	 * 2026-05-17 security audit — the community-PR pipeline uses
	 * `GitPullRequest.author.orgVerified` to decide whether to
	 * auto-apply a PR. Default constructed here so existing callers
	 * (`new GitHubApiService()`) keep working; tests may inject a
	 * custom instance.
	 */
	constructor(private readonly verifiedOrgService: GitHubVerifiedOrgService = new GitHubVerifiedOrgService()) {}

	private createOctokit(token: string, baseUrl?: string): Octokit {
		return new Octokit({
			...(token ? { auth: token } : {}),
			baseUrl: baseUrl || 'https://api.github.com'
		});
	}

	/**
	 * Build the `author` field for a `GitPullRequest` by inspecting
	 * the GitHub API `user` payload + (when configured) calling out
	 * to `GET /orgs/{org}/members/{username}` for each org in
	 * `COMMUNITY_PR_VERIFIED_ORGS`. Returns `undefined` when the
	 * upstream `user` is null (rare — ghost users).
	 *
	 * @param user GitHub user payload (`pr.user` from Octokit).
	 * @param token The same token used to fetch the PR — reused for
	 *   the membership lookup so the operator doesn't need a second
	 *   credential.
	 * @param baseUrl GitHub Enterprise base URL, if any.
	 */
	private async buildPrAuthor(
		user: { login?: string | null; type?: string | null } | null | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestAuthor | undefined> {
		if (!user?.login) return undefined;

		const verifiedOrgs = parseVerifiedOrgs(process.env.COMMUNITY_PR_VERIFIED_ORGS);
		let orgVerified: boolean | undefined;
		if (verifiedOrgs.length > 0) {
			try {
				orgVerified = await this.verifiedOrgService.isVerifiedMember({
					username: user.login,
					token,
					baseUrl,
					verifiedOrgs
				});
			} catch {
				// Defensive: any unexpected exception means "couldn't verify".
				orgVerified = false;
			}
		}

		const author: GitPullRequestAuthor = {
			username: user.login,
			...(user.type ? { type: user.type } : {}),
			...(orgVerified === undefined ? {} : { orgVerified })
		};
		return author;
	}

	async getUser(token: string, baseUrl?: string): Promise<GitUser> {
		const octokit = this.createOctokit(token, baseUrl);
		const { data } = await octokit.rest.users.getAuthenticated();

		return {
			id: String(data.id),
			login: data.login,
			name: data.name ?? undefined,
			email: data.email ?? undefined,
			avatarUrl: data.avatar_url
		};
	}

	async getOrganizations(token: string, baseUrl?: string): Promise<GitOrganization[]> {
		const octokit = this.createOctokit(token, baseUrl);
		const { data } = await octokit.rest.orgs.listForAuthenticatedUser();

		return data.map((org) => ({
			id: String(org.id),
			login: org.login,
			name: org.description ?? undefined,
			avatarUrl: org.avatar_url
		}));
	}

	async getRepository(
		owner: string,
		repo: string,
		token: string,
		baseUrl?: string
	): Promise<GitRepositoryWithPermissions | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.get({ owner, repo });

			return {
				owner: data.owner.login,
				name: data.name,
				fullName: data.full_name,
				description: data.description ?? undefined,
				defaultBranch: data.default_branch,
				isPrivate: data.private,
				url: data.html_url,
				cloneUrl: data.clone_url,
				isFork: data.fork,
				parent: data.parent
					? {
							owner: data.parent.owner.login,
							name: data.parent.name,
							fullName: data.parent.full_name
						}
					: undefined,
				permissions: data.permissions
					? {
							admin: data.permissions.admin ?? false,
							push: data.permissions.push ?? false,
							pull: data.permissions.pull ?? false
						}
					: undefined
			};
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	async listRepositories(
		token: string,
		page: number = 1,
		perPage: number = 30,
		baseUrl?: string,
		options?: ListRepositoriesOptions
	): Promise<GitRepositoryWithPermissions[]> {
		const octokit = this.createOctokit(token, baseUrl);

		let data;
		if (options?.type === 'org' && options?.owner) {
			try {
				const response = await octokit.rest.repos.listForOrg({
					org: options.owner,
					page,
					per_page: perPage,
					sort: 'updated'
				});
				data = response.data;
			} catch (err) {
				if (err instanceof RequestError && (err.status === 404 || err.status === 403)) {
					return [];
				}
				throw err;
			}
		} else if (options?.type === 'user') {
			const response = await octokit.rest.repos.listForAuthenticatedUser({
				affiliation: 'owner',
				page,
				per_page: perPage,
				sort: 'updated'
			});
			data = response.data;
		} else {
			const response = await octokit.rest.repos.listForAuthenticatedUser({
				page,
				per_page: perPage,
				sort: 'updated'
			});
			data = response.data;
		}

		return data.map((repo) => ({
			owner: repo.owner.login,
			name: repo.name,
			fullName: repo.full_name,
			description: repo.description ?? undefined,
			defaultBranch: repo.default_branch ?? 'main',
			isPrivate: repo.private,
			url: repo.html_url,
			cloneUrl: repo.clone_url ?? `https://github.com/${repo.full_name}.git`,
			isFork: repo.fork,
			permissions: repo.permissions
				? {
						admin: repo.permissions.admin ?? false,
						push: repo.permissions.push ?? false,
						pull: repo.permissions.pull ?? false
					}
				: undefined
		}));
	}

	async createRepository(options: CreateRepoOptions, token: string, baseUrl?: string): Promise<GitRepository> {
		const octokit = this.createOctokit(token, baseUrl);
		const sanitizedDesc = sanitizeDescription(options.description);

		let data;
		if (options.organization) {
			const existing = await this.getRepository(options.organization, options.name, token, baseUrl);
			if (existing) return existing;

			const res = await octokit.rest.repos.createInOrg({
				org: options.organization,
				name: options.name,
				description: sanitizedDesc,
				private: options.isPrivate ?? true
			});
			data = res.data;
		} else {
			const { data: user } = await octokit.rest.users.getAuthenticated();
			const existing = await this.getRepository(user.login, options.name, token, baseUrl);
			if (existing) return existing;

			const res = await octokit.rest.repos.createForAuthenticatedUser({
				name: options.name,
				description: sanitizedDesc,
				private: options.isPrivate ?? true
			});
			data = res.data;
		}

		return {
			owner: data.owner.login,
			name: data.name,
			fullName: data.full_name,
			description: data.description ?? undefined,
			defaultBranch: data.default_branch,
			isPrivate: data.private,
			url: data.html_url,
			cloneUrl: data.clone_url
		};
	}

	async deleteRepository(owner: string, repo: string, token: string, baseUrl?: string): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);
		await octokit.rest.repos.delete({ owner, repo });
	}

	async transferRepository(
		owner: string,
		repo: string,
		options: TransferRepoOptions,
		token: string,
		baseUrl?: string
	): Promise<TransferRepoResult> {
		const octokit = this.createOctokit(token, baseUrl);
		// GitHub's transfer API returns 202 with the source repo payload;
		// the new owner must accept the transfer on github.com before it
		// completes. The returned repo data describes the OLD location and
		// isn't useful to consumers — omit `newRepository` and let callers
		// re-resolve once the transfer settles.
		await octokit.rest.repos.transfer({
			owner,
			repo,
			new_owner: options.newOwner,
			...(options.teamIds && options.teamIds.length > 0 ? { team_ids: [...options.teamIds] } : {})
		});

		return {
			status: 'pending_recipient_acceptance',
			providerAcceptanceUrl: `https://github.com/${options.newOwner}`
		};
	}

	async updateRepository(
		owner: string,
		repo: string,
		data: UpdateRepoOptions,
		token: string,
		baseUrl?: string
	): Promise<GitRepository> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data: updated } = await octokit.rest.repos.update({
			owner,
			repo,
			private: data.isPrivate,
			description: data.description ? sanitizeDescription(data.description) : undefined,
			default_branch: data.defaultBranch
		});

		return {
			owner: updated.owner.login,
			name: updated.name,
			fullName: updated.full_name,
			description: updated.description ?? undefined,
			defaultBranch: updated.default_branch,
			isPrivate: updated.private,
			url: updated.html_url,
			cloneUrl: updated.clone_url
		};
	}

	async forkRepository(
		owner: string,
		repo: string,
		options: ForkRepositoryOptions,
		token: string,
		baseUrl?: string
	): Promise<GitRepository | null> {
		const octokit = this.createOctokit(token, baseUrl);

		if (options.name) {
			const targetOwner = options.organization || (await this.getUser(token, baseUrl)).login;
			const existing = await this.getRepository(targetOwner, options.name, token, baseUrl);
			if (existing) {
				return existing;
			}
		}

		const { data } = await octokit.rest.repos.createFork({
			owner,
			repo,
			name: options.name,
			organization: options.organization,
			default_branch_only: options.defaultBranchOnly
		});

		const newOwner = data.owner.login;
		const newName = data.name;

		const REPO_CHECK_INTERVAL_MS = 5000;
		const MAX_REPO_CHECK_ATTEMPTS = 24;

		for (let attempt = 1; attempt <= MAX_REPO_CHECK_ATTEMPTS; attempt++) {
			try {
				await octokit.rest.repos.get({ owner: newOwner, repo: newName });
				return await this.getRepository(newOwner, newName, token, baseUrl);
			} catch (err) {
				if (err instanceof RequestError && err.status === 404) {
					if (attempt < MAX_REPO_CHECK_ATTEMPTS) {
						await new Promise((resolve) => setTimeout(resolve, REPO_CHECK_INTERVAL_MS));
					}
				} else {
					throw err;
				}
			}
		}

		return null;
	}

	async createRepositoryFromTemplate(
		templateOwner: string,
		templateRepo: string,
		options: CreateRepoOptions,
		token: string,
		baseUrl?: string
	): Promise<GitRepository | null> {
		const octokit = this.createOctokit(token, baseUrl);
		const targetOwner = options.organization || (await this.getUser(token, baseUrl)).login;

		const existing = await this.getRepository(targetOwner, options.name, token, baseUrl);
		if (existing) return existing;

		await octokit.rest.repos.createUsingTemplate({
			template_owner: templateOwner,
			template_repo: templateRepo,
			owner: targetOwner,
			name: options.name,
			description: sanitizeDescription(options.description),
			private: options.isPrivate ?? true,
			include_all_branches: true
		});

		return this.getRepository(targetOwner, options.name, token, baseUrl);
	}

	async listBranches(owner: string, repo: string, token: string, baseUrl?: string): Promise<GitBranch[]> {
		const octokit = this.createOctokit(token, baseUrl);
		const branches: GitBranch[] = [];

		const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
		const defaultBranch = repoData.default_branch;

		for await (const response of octokit.paginate.iterator(octokit.rest.repos.listBranches, {
			owner,
			repo,
			per_page: 100
		})) {
			for (const branch of response.data) {
				branches.push({
					name: branch.name,
					commit: branch.commit.sha,
					isDefault: branch.name === defaultBranch,
					isProtected: branch.protected
				});
			}
		}

		return branches;
	}

	async createBranch(
		owner: string,
		repo: string,
		name: string,
		fromRef: string,
		token: string,
		baseUrl?: string
	): Promise<GitBranch> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data: ref } = await octokit.rest.git.getRef({
			owner,
			repo,
			ref: `heads/${fromRef}`
		});

		await octokit.rest.git.createRef({
			owner,
			repo,
			ref: `refs/heads/${name}`,
			sha: ref.object.sha
		});

		return {
			name,
			commit: ref.object.sha,
			isDefault: false,
			isProtected: false
		};
	}

	async deleteBranch(owner: string, repo: string, name: string, token: string, baseUrl?: string): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);
		await octokit.rest.git.deleteRef({
			owner,
			repo,
			ref: `heads/${name}`
		});
	}

	async getLatestCommit(
		owner: string,
		repo: string,
		branch: string,
		token: string,
		baseUrl?: string
	): Promise<GitCommit | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });

			return {
				sha: data.commit.sha,
				message: data.commit.commit.message,
				author: {
					name: data.commit.commit.author?.name,
					email: data.commit.commit.author?.email
				},
				date: data.commit.commit.committer?.date || new Date().toISOString()
			};
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	async createPullRequest(options: CreatePROptions, token: string, baseUrl?: string): Promise<GitPullRequest> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.create({
			owner: options.owner,
			repo: options.repo,
			title: options.title,
			head: options.head,
			base: options.base,
			body: options.body || `Pull request from ${options.head} to ${options.base}`,
			draft: options.draft || false
		});

		const author = await this.buildPrAuthor(data.user, token, baseUrl);
		return {
			number: data.number,
			title: data.title,
			state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
			head: data.head.ref,
			base: data.base.ref,
			url: data.html_url,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			body: data.body ?? undefined,
			...(author ? { author } : {})
		};
	}

	async getPullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequest | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: prNumber
			});

			const author = await this.buildPrAuthor(data.user, token, baseUrl);
			return {
				number: data.number,
				title: data.title,
				state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
				head: data.head.ref,
				base: data.base.ref,
				url: data.html_url,
				createdAt: data.created_at,
				updatedAt: data.updated_at,
				body: data.body ?? undefined,
				...(author ? { author } : {})
			};
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	async mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<MergeResult> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.merge({
			owner,
			repo,
			pull_number: prNumber,
			commit_title: options?.commitTitle,
			commit_message: options?.commitMessage,
			merge_method: options?.mergeMethod || 'merge'
		});

		return {
			sha: data.sha,
			merged: data.merged,
			message: data.message
		};
	}

	async listPullRequests(
		owner: string,
		repo: string,
		options: ListPullRequestsOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequest[]> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.list({
			owner,
			repo,
			state: options?.state || 'open',
			per_page: options?.perPage || 30,
			page: options?.page || 1
		});

		// Map sequentially: the per-author verified-org call is cached, so
		// a batch of PRs from the same author hits GitHub once. Different
		// authors still trigger N lookups (bounded by per_page). The cap
		// in the community-PR pipeline (max 10/PR per run) keeps total
		// fan-out small enough to stay well under GitHub's 5000/hour
		// authenticated rate limit.
		const result: GitPullRequest[] = [];
		for (const pr of data) {
			const author = await this.buildPrAuthor(pr.user, token, baseUrl);
			result.push({
				number: pr.number,
				title: pr.title,
				state: pr.merged_at ? 'merged' : (pr.state as 'open' | 'closed'),
				head: pr.head.ref,
				base: pr.base.ref,
				url: pr.html_url,
				createdAt: pr.created_at,
				updatedAt: pr.updated_at,
				body: pr.body ?? undefined,
				...(author ? { author } : {})
			});
		}
		return result;
	}

	async getPullRequestFiles(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestFile[]> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.listFiles({
			owner,
			repo,
			pull_number: prNumber,
			per_page: 100
		});

		return data.map((file) => ({
			filename: file.filename,
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			patch: file.patch
		}));
	}

	/**
	 * PR insights (kanban M5) — PR state + review decision + rolled-up CI
	 * for the board's review pill.
	 *
	 * Three API reads, all bounded: the PR itself, its head commit's
	 * check-runs, and its head commit's legacy commit-statuses (many
	 * external CI providers still only publish the latter — reading both
	 * is what makes the dot honest across setups). A missing PR resolves
	 * to `null`; a checks read that 404s/403s (e.g. a token without
	 * `checks:read`) degrades to "no checks" rather than failing the
	 * whole status — a pill with an unknown dot beats no pill at all.
	 */
	async getPullRequestStatus(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequestStatus | null> {
		const octokit = this.createOctokit(token, baseUrl);

		let pr;
		try {
			const response = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
			pr = response.data;
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) return null;
			throw err;
		}

		const headSha: string | null = pr.head?.sha ?? null;
		const checks = headSha ? await this.readChecks(octokit, owner, repo, headSha) : [];
		const capped = capChecks(checks);

		const merged = pr.merged === true || pr.merged_at != null;
		const state: GitPullRequestStatus['state'] = merged
			? 'merged'
			: pr.state === 'closed'
				? 'closed'
				: pr.draft === true
					? 'draft'
					: 'open';

		const rawDecision = (pr as { review_decision?: string | null }).review_decision;
		const reviewDecision: GitReviewDecision | null = rawDecision
			? (REVIEW_DECISION_MAP[rawDecision] ?? null)
			: null;

		return {
			number: pr.number,
			state,
			merged,
			mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
			headSha,
			reviewDecision,
			ciState: deriveCiState(capped),
			checks: capped,
			url: pr.html_url,
			title: pr.title
		};
	}

	/**
	 * Read check-runs AND commit-statuses for one commit and normalise
	 * both onto the contract vocabulary. Best-effort per source: a token
	 * missing one scope still gets the other half.
	 */
	private async readChecks(
		octokit: Octokit,
		owner: string,
		repo: string,
		ref: string
	): Promise<GitPullRequestCheck[]> {
		const out: GitPullRequestCheck[] = [];

		try {
			const { data } = await octokit.rest.checks.listForRef({
				owner,
				repo,
				ref,
				per_page: CHECKS_PER_PAGE
			});
			for (const run of data.check_runs ?? []) {
				const check: GitPullRequestCheck = {
					name: run.name,
					status: CHECK_STATUS_MAP[run.status] ?? 'unknown',
					conclusion: run.conclusion ? (CHECK_CONCLUSION_MAP[run.conclusion] ?? null) : null,
					...(run.details_url ? { detailsUrl: run.details_url } : {})
				};
				out.push(check);
			}
		} catch {
			// `checks:read` not granted, or a provider without the Checks
			// API. Fall through to commit statuses.
		}

		try {
			const { data } = await octokit.rest.repos.listCommitStatusesForRef({
				owner,
				repo,
				ref,
				per_page: CHECKS_PER_PAGE
			});
			// Statuses are append-only per context — keep the newest per
			// context so a fixed re-run doesn't leave a stale red behind.
			const newestByContext = new Map<string, (typeof data)[number]>();
			for (const status of data) {
				if (!newestByContext.has(status.context)) newestByContext.set(status.context, status);
			}
			for (const status of newestByContext.values()) {
				const settled = status.state !== 'pending';
				out.push({
					name: status.context,
					status: settled ? 'completed' : 'queued',
					conclusion: settled ? (CHECK_CONCLUSION_MAP[status.state] ?? null) : null,
					...(status.target_url ? { detailsUrl: status.target_url } : {})
				});
			}
		} catch {
			// Same posture — an unreadable source contributes nothing.
		}

		return out;
	}

	/**
	 * PR insights (kanban M6) — capped PR diff. The file cap is applied at
	 * the REQUEST (`per_page`) so we never pull a 3,000-file PR into
	 * memory just to slice it; `capDiffFiles` then enforces the byte
	 * budget and the final file cap with the shared rule.
	 */
	async getPullRequestDiff(
		owner: string,
		repo: string,
		prNumber: number,
		opts: GitDiffOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitDiffResult> {
		const octokit = this.createOctokit(token, baseUrl);
		const { maxFiles } = resolveDiffCaps(opts);

		const { data } = await octokit.rest.pulls.listFiles({
			owner,
			repo,
			pull_number: prNumber,
			// One extra so `totalFiles > files.length` can prove there IS
			// more without a second round trip.
			per_page: Math.min(maxFiles + 1, 100)
		});

		return capDiffFiles(data.map(toDiffFile), opts);
	}

	/**
	 * PR insights (kanban M6) — `base...head` compare for a branch that
	 * has no PR yet. Same caps, same shape.
	 */
	async getCompareDiff(
		owner: string,
		repo: string,
		base: string,
		head: string,
		opts: GitDiffOptions | undefined,
		token: string,
		baseUrl?: string
	): Promise<GitDiffResult> {
		const octokit = this.createOctokit(token, baseUrl);
		const { maxFiles } = resolveDiffCaps(opts);

		const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
			owner,
			repo,
			basehead: `${base}...${head}`,
			per_page: Math.min(maxFiles + 1, 100)
		});

		return capDiffFiles((data.files ?? []).map(toDiffFile), opts);
	}

	async createPullRequestComment(
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
		token: string,
		baseUrl?: string
	): Promise<{ id: number; body: string }> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: prNumber,
			body
		});

		return { id: data.id, body: data.body || '' };
	}

	async closePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		token: string,
		baseUrl?: string
	): Promise<GitPullRequest> {
		const octokit = this.createOctokit(token, baseUrl);

		const { data } = await octokit.rest.pulls.update({
			owner,
			repo,
			pull_number: prNumber,
			state: 'closed'
		});

		const author = await this.buildPrAuthor(data.user, token, baseUrl);
		return {
			number: data.number,
			title: data.title,
			state: data.merged_at ? 'merged' : (data.state as 'open' | 'closed'),
			head: data.head.ref,
			base: data.base.ref,
			url: data.html_url,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			body: data.body ?? undefined,
			...(author ? { author } : {})
		};
	}

	async repositoryExists(owner: string, repo: string, token: string, baseUrl?: string): Promise<boolean> {
		const repository = await this.getRepository(owner, repo, token, baseUrl);
		return repository !== null;
	}

	async hasRepositoryAccess(owner: string, repo: string, token: string, baseUrl?: string): Promise<boolean> {
		try {
			const octokit = this.createOctokit(token, baseUrl);
			await octokit.rest.repos.get({ owner, repo });
			return true;
		} catch (err) {
			if (err instanceof RequestError && (err.status === 404 || err.status === 403)) {
				return false;
			}
			throw err;
		}
	}

	async hasForkRelationship(
		forkOwner: string,
		forkRepo: string,
		parentOwner: string,
		parentRepo: string,
		token: string,
		baseUrl?: string
	): Promise<boolean> {
		const repository = await this.getRepository(forkOwner, forkRepo, token, baseUrl);
		if (!repository || !repository.isFork || !repository.parent) {
			return false;
		}

		return repository.parent.owner === parentOwner && repository.parent.name === parentRepo;
	}

	// Content access methods

	async getFileContent(
		owner: string,
		repo: string,
		path: string,
		token: string,
		ref?: string,
		baseUrl?: string
	): Promise<{ content: string; encoding: string } | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.getContent({
				owner,
				repo,
				path,
				ref
			});

			if ('content' in data && data.type === 'file') {
				const content = Buffer.from(data.content, 'base64').toString('utf-8');
				return { content, encoding: 'utf-8' };
			}

			return null;
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	/**
	 * EW-641 Phase 1B/d row 18b — list commits touching `path` via
	 * `GET /repos/{owner}/{repo}/commits?path=…`. Newest first, capped
	 * to `[1, 100]` (the GitHub `per_page` limit).
	 */
	async listFileCommits(
		owner: string,
		repo: string,
		path: string,
		token: string,
		limit?: number,
		baseUrl?: string
	): Promise<GitCommit[]> {
		const octokit = this.createOctokit(token, baseUrl);
		const perPage = typeof limit === 'number' ? Math.min(Math.max(Math.floor(limit), 1), 100) : 25;

		try {
			const { data } = await octokit.rest.repos.listCommits({
				owner,
				repo,
				path,
				per_page: perPage
			});

			// Some commits are signed by GitHub Actions / bots where the
			// `commit.author.name` field is set but `data.author` (the
			// repo-user record) is null — fall back to the commit-level
			// author so the dialog still shows a meaningful display name.
			return data.map(
				(row): GitCommit => ({
					sha: row.sha,
					message: row.commit.message,
					author: {
						name: row.commit.author?.name ?? row.author?.login ?? '',
						email: row.commit.author?.email ?? ''
					},
					date: row.commit.author?.date ?? row.commit.committer?.date ?? ''
				})
			);
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return [];
			}
			throw err;
		}
	}

	async getReadme(
		owner: string,
		repo: string,
		token: string,
		ref?: string,
		baseUrl?: string
	): Promise<{ content: string; path: string } | null> {
		const octokit = this.createOctokit(token, baseUrl);

		// Try GitHub's dedicated readme API first
		try {
			const { data } = await octokit.rest.repos.getReadme({
				owner,
				repo,
				ref
			});

			if (data.content && data.encoding === 'base64') {
				const content = Buffer.from(data.content, 'base64').toString('utf-8');
				return { content, path: data.name };
			}
		} catch {
			// Fall through to manual lookup
		}

		// Fallback: try common README filenames
		const readmeFiles = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];

		for (const filename of readmeFiles) {
			const result = await this.getFileContent(owner, repo, filename, token, ref, baseUrl);
			if (result) {
				return { content: result.content, path: filename };
			}
		}

		return null;
	}

	getRawFileUrl(owner: string, repo: string, branch: string, path: string): string {
		// Security (URL injection / path traversal): owner/repo/branch/path are
		// interpolated straight into a raw.githubusercontent.com URL whose result
		// is fed to fetch() (source-repo-analyzer) and may be rendered in the UI.
		// A segment containing `..`, an encoded slash (%2F), a backslash, or a
		// CR/LF sequence could traverse to a different repository or inject into
		// the URL. Reject those vectors; legitimate GitHub owner/repo/branch/path
		// values pass through unchanged. Fail closed by throwing -- the sole caller
		// wraps this in try/catch and falls through to the next candidate.
		const rejectSegment = (segment: string, allowSlash: boolean): void => {
			// Control chars (incl. CR/LF/NUL/DEL), backslash, and % (percent-encoding
			// such as %2F) are never valid here and all enable URL/path injection.
			for (let idx = 0; idx < segment.length; idx++) {
				const code = segment.charCodeAt(idx);
				const ch = segment[idx];
				if (code <= 0x1f || code === 0x7f || ch === '\\' || ch === '%') {
					throw new Error('getRawFileUrl: illegal character in URL segment');
				}
			}
			// A `..` or `.` that is a WHOLE path component (slash-delimited, or the
			// entire value) is traversal; a literal `..` inside a longer filename
			// (e.g. a..b.txt) is harmless and stays allowed.
			if (segment.split('/').some((p) => p === '..' || p === '.')) {
				throw new Error('getRawFileUrl: path traversal in URL segment');
			}
			// owner/repo/branch are single path segments and must not contain a
			// slash of their own; only path may legitimately contain `/`.
			if (!allowSlash && segment.includes('/')) {
				throw new Error('getRawFileUrl: unexpected slash in URL segment');
			}
		};
		rejectSegment(owner, false);
		rejectSegment(repo, false);
		rejectSegment(branch, false);
		rejectSegment(path, true);

		return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
	}

	async getWorkContents(
		owner: string,
		repo: string,
		path: string,
		token: string,
		baseUrl?: string
	): Promise<Array<{ name: string; type: 'file' | 'dir' | 'submodule' | 'symlink'; path: string }> | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.repos.getContent({
				owner,
				repo,
				path
			});

			if (!Array.isArray(data)) {
				return null;
			}

			return data.map((item) => ({
				name: item.name,
				type: item.type as 'file' | 'dir' | 'submodule' | 'symlink',
				path: item.path
			}));
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}
}
