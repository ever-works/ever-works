import type { IPlugin } from '../plugin.interface.js';

export interface GitAuth {
	readonly username: 'x-access-token' | 'oauth2' | string;
	readonly password: string;
}

export interface GitCommitter {
	readonly name?: string;
	readonly email?: string;
}

export interface GitRepository {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly description?: string;
	readonly defaultBranch: string;
	readonly isPrivate: boolean;
	readonly url: string;
	readonly cloneUrl: string;
	readonly isFork?: boolean;
	readonly parent?: {
		readonly owner: string;
		readonly name: string;
		readonly fullName: string;
	};
}

export interface GitBranch {
	readonly name: string;
	readonly commit: string;
	readonly isDefault: boolean;
	readonly isProtected?: boolean;
}

export interface GitCommit {
	readonly sha: string;
	readonly message: string;
	readonly author: GitCommitter;
	readonly date: string;
}

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitFileChange {
	readonly path: string;
	readonly status: GitFileStatus;
	readonly oldPath?: string;
}

export interface GitCloneOptions {
	readonly owner: string;
	readonly repo: string;
	readonly token: string;
	readonly committer?: GitCommitter;
	readonly branch?: string;
	readonly autoSwitchToMainBranch?: boolean;
}

export interface GitPushOptions {
	readonly dir: string;
	readonly token: string;
	readonly force?: boolean;
	readonly maxRetries?: number;
}

export interface CreateRepoOptions {
	readonly name: string;
	readonly description?: string;
	readonly isPrivate?: boolean;
	readonly organization?: string;
}

export interface UpdateRepoOptions {
	readonly isPrivate?: boolean;
	readonly description?: string;
	readonly defaultBranch?: string;
}

export interface ForkRepositoryOptions {
	readonly name?: string;
	readonly organization?: string;
	readonly defaultBranchOnly?: boolean;
}

export interface CreatePROptions {
	readonly owner: string;
	readonly repo: string;
	readonly title: string;
	readonly head: string;
	readonly base: string;
	readonly body?: string;
	readonly draft?: boolean;
}

export interface MergeOptions {
	readonly commitTitle?: string;
	readonly commitMessage?: string;
	readonly mergeMethod?: 'merge' | 'squash' | 'rebase';
}

export interface MergeResult {
	readonly sha: string;
	readonly merged: boolean;
	readonly message?: string;
}

export interface GitUser {
	readonly id: string;
	readonly login: string;
	readonly name?: string;
	readonly email?: string;
	readonly avatarUrl?: string;
}

export interface GitOrganization {
	readonly id: string;
	readonly login: string;
	readonly name?: string;
	readonly avatarUrl?: string;
}

export interface GitPullRequest {
	readonly number: number;
	readonly title: string;
	readonly state: 'open' | 'closed' | 'merged';
	readonly head: string;
	readonly base: string;
	readonly url: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly body?: string;
}

export interface GitRepositoryPermissions {
	readonly admin: boolean;
	readonly push: boolean;
	readonly pull: boolean;
}

export interface GitRepositoryWithPermissions extends GitRepository {
	readonly permissions?: GitRepositoryPermissions;
}

export interface ListRepositoriesOptions {
	owner?: string;
	type?: 'user' | 'org';
}

export interface GitPullRequestFile {
	readonly filename: string;
	readonly status: string;
	readonly additions: number;
	readonly deletions: number;
	readonly patch?: string;
}

export interface ListPullRequestsOptions {
	readonly state?: 'open' | 'closed' | 'all';
	readonly perPage?: number;
	readonly page?: number;
}

/**
 * Local git operations using isomorphic-git.
 * Implemented in BaseGitProvider - plugin developers extend that class.
 */
export interface IGitOperations {
	cloneOrPull(options: GitCloneOptions): Promise<string>;
	pull(dir: string, token: string, committer?: GitCommitter): Promise<void>;
	add(dir: string, paths: string | string[]): Promise<void>;
	addAll(dir: string): Promise<void>;
	commit(dir: string, message: string, committer?: GitCommitter): Promise<string | null>;
	push(options: GitPushOptions): Promise<void>;
	getCurrentBranch(dir: string): Promise<string | null>;
	getMainBranch(dir: string): Promise<string | null>;
	switchBranch(dir: string, branch: string, create?: boolean): Promise<string>;
	getStatus(dir: string): Promise<GitFileChange[]>;
	getLocalDir(owner: string, repo: string): string;
	removeLocalDir(owner: string, repo: string): Promise<void>;
	replaceRemote(dir: string, remote: string, url: string): Promise<void>;
	renameBranch(dir: string, oldName: string, newName: string): Promise<void>;
}

/**
 * Git provider plugin for provider-specific API operations.
 * Also includes local git operations (clone, push, commit) via IGitOperations.
 */
export interface IGitProviderPlugin extends IPlugin, IGitOperations {
	readonly providerName: string;

	// Authentication
	getAuth(token: string): GitAuth;
	getCloneUrl(owner: string, repo: string): string;
	getWebUrl(owner: string, repo: string): string;

	// Repository operations
	listRepositories?(
		token: string,
		page?: number,
		perPage?: number,
		options?: ListRepositoriesOptions
	): Promise<GitRepositoryWithPermissions[]>;
	createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository>;
	getRepository(owner: string, repo: string, token: string): Promise<GitRepositoryWithPermissions | null>;
	hasRepositoryAccess?(owner: string, repo: string, token: string): Promise<boolean>;
	deleteRepository(owner: string, repo: string, token: string): Promise<void>;
	updateRepository?(owner: string, repo: string, data: UpdateRepoOptions, token: string): Promise<GitRepository>;

	// User & organization
	getUser(token: string): Promise<GitUser>;
	getOrganizations(token: string): Promise<GitOrganization[]>;

	// Branch operations
	listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]>;
	createBranch?(owner: string, repo: string, name: string, fromRef: string, token: string): Promise<GitBranch>;
	deleteBranch?(owner: string, repo: string, name: string, token: string): Promise<void>;

	// Pull request operations
	createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest>;
	getPullRequest?(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequest | null>;
	mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string
	): Promise<MergeResult>;

	// Fork & template operations
	forkRepository?(
		owner: string,
		repo: string,
		options: ForkRepositoryOptions,
		token: string
	): Promise<GitRepository | null>;
	createRepositoryFromTemplate?(
		templateOwner: string,
		templateRepo: string,
		options: CreateRepoOptions,
		token: string
	): Promise<GitRepository | null>;
	hasForkRelationship?(
		forkOwner: string,
		forkRepo: string,
		parentOwner: string,
		parentRepo: string,
		token: string
	): Promise<boolean>;

	// Community PR operations
	listPullRequests?(
		owner: string,
		repo: string,
		options: ListPullRequestsOptions | undefined,
		token: string
	): Promise<GitPullRequest[]>;
	getPullRequestFiles?(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequestFile[]>;
	createPullRequestComment?(
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
		token: string
	): Promise<{ id: number; body: string }>;
	closePullRequest?(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequest>;

	// Utility
	repositoryExists?(owner: string, repo: string, token: string): Promise<boolean>;
	getLatestCommit?(owner: string, repo: string, branch: string, token: string): Promise<GitCommit | null>;

	// Content access (for analyzing repositories)
	getFileContent?(
		owner: string,
		repo: string,
		path: string,
		ref?: string,
		token?: string
	): Promise<{ content: string; encoding: string } | null>;
	getReadme?(
		owner: string,
		repo: string,
		ref?: string,
		token?: string
	): Promise<{ content: string; path: string } | null>;
	getRawFileUrl?(owner: string, repo: string, branch: string, path: string): string;
	getDirectoryContents?(
		owner: string,
		repo: string,
		path: string,
		token: string
	): Promise<Array<{ name: string; type: 'file' | 'dir' | 'submodule' | 'symlink'; path: string }> | null>;
}

export function isGitProviderPlugin(plugin: IPlugin): plugin is IGitProviderPlugin {
	return plugin.capabilities.includes('git-provider');
}
