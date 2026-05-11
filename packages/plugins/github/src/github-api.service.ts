import { Octokit, RequestError } from 'octokit';
import type {
	GitRepository,
	GitUser,
	GitOrganization,
	GitBranch,
	GitCommit,
	GitPullRequest,
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
	TransferRepoResult
} from '@ever-works/plugin/git';

function sanitizeDescription(description?: string): string {
	if (!description) return '';
	return description
		.replace(/[\r\n]+/g, ' ')
		.trim()
		.slice(0, 500);
}

export class GitHubApiService {
	private createOctokit(token: string, baseUrl?: string): Octokit {
		return new Octokit({
			...(token ? { auth: token } : {}),
			baseUrl: baseUrl || 'https://api.github.com'
		});
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

		return {
			number: data.number,
			title: data.title,
			state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
			head: data.head.ref,
			base: data.base.ref,
			url: data.html_url,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			body: data.body ?? undefined
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

			return {
				number: data.number,
				title: data.title,
				state: data.merged ? 'merged' : (data.state as 'open' | 'closed'),
				head: data.head.ref,
				base: data.base.ref,
				url: data.html_url,
				createdAt: data.created_at,
				updatedAt: data.updated_at,
				body: data.body ?? undefined
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

		return data.map((pr) => ({
			number: pr.number,
			title: pr.title,
			state: pr.merged_at ? 'merged' : (pr.state as 'open' | 'closed'),
			head: pr.head.ref,
			base: pr.base.ref,
			url: pr.html_url,
			createdAt: pr.created_at,
			updatedAt: pr.updated_at,
			body: pr.body ?? undefined
		}));
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

		return {
			number: data.number,
			title: data.title,
			state: data.merged_at ? 'merged' : (data.state as 'open' | 'closed'),
			head: data.head.ref,
			base: data.base.ref,
			url: data.html_url,
			createdAt: data.created_at,
			updatedAt: data.updated_at,
			body: data.body ?? undefined
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
