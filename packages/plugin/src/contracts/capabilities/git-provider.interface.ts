import type { IPlugin } from '../plugin.interface.js';

// ============================================
// AUTHENTICATION & COMMITTER TYPES
// ============================================

/**
 * Git authentication credentials
 */
export interface GitAuth {
	/** Authentication username ('x-access-token' for GitHub, 'oauth2' for GitLab) */
	readonly username: 'x-access-token' | 'oauth2' | string;
	/** Authentication token or password */
	readonly password: string;
}

/**
 * Commit author information
 */
export interface GitCommitter {
	readonly name?: string;
	readonly email?: string;
}

// ============================================
// REPOSITORY & BRANCH TYPES
// ============================================

/**
 * Repository information
 */
export interface GitRepository {
	readonly owner: string;
	readonly name: string;
	readonly fullName: string;
	readonly description?: string;
	readonly defaultBranch: string;
	readonly isPrivate: boolean;
	readonly url: string;
	readonly cloneUrl: string;
	/** Whether this is a fork */
	readonly isFork?: boolean;
	/** Parent repository if this is a fork */
	readonly parent?: {
		readonly owner: string;
		readonly name: string;
		readonly fullName: string;
	};
}

/**
 * Branch information
 */
export interface GitBranch {
	readonly name: string;
	readonly commit: string;
	readonly isDefault: boolean;
	readonly isProtected?: boolean;
}

/**
 * Commit information
 */
export interface GitCommit {
	readonly sha: string;
	readonly message: string;
	readonly author: GitCommitter;
	readonly date: string;
}

// ============================================
// FILE STATUS TYPES
// ============================================

/**
 * File status in git
 */
export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

/**
 * File change information
 */
export interface GitFileChange {
	readonly path: string;
	readonly status: GitFileStatus;
	readonly oldPath?: string;
}

// ============================================
// LOCAL GIT OPERATION OPTIONS
// ============================================

/**
 * Clone or pull options
 */
export interface GitCloneOptions {
	readonly owner: string;
	readonly repo: string;
	readonly token: string;
	readonly committer?: GitCommitter;
	readonly branch?: string;
	readonly autoSwitchToMainBranch?: boolean;
}

/**
 * Push options
 */
export interface GitPushOptions {
	readonly dir: string;
	readonly token: string;
	readonly force?: boolean;
	readonly maxRetries?: number;
}

// ============================================
// API OPERATION OPTIONS
// ============================================

/**
 * Options for creating a repository
 */
export interface CreateRepoOptions {
	/** Repository name */
	readonly name: string;
	/** Repository description */
	readonly description?: string;
	/** Whether the repository should be private */
	readonly isPrivate?: boolean;
	/** Organization to create the repository in (if not personal) */
	readonly organization?: string;
}

/**
 * Options for creating a pull request
 */
export interface CreatePROptions {
	/** Repository owner */
	readonly owner: string;
	/** Repository name */
	readonly repo: string;
	/** Pull request title */
	readonly title: string;
	/** Source branch (the branch with changes) */
	readonly head: string;
	/** Target branch (the branch to merge into) */
	readonly base: string;
	/** Pull request body/description */
	readonly body?: string;
	/** Whether to create as a draft */
	readonly draft?: boolean;
}

/**
 * Options for merging a pull request
 */
export interface MergeOptions {
	/** Commit title for the merge commit */
	readonly commitTitle?: string;
	/** Commit message for the merge commit */
	readonly commitMessage?: string;
	/** Merge method */
	readonly mergeMethod?: 'merge' | 'squash' | 'rebase';
}

/**
 * Result of a merge operation
 */
export interface MergeResult {
	/** SHA of the merge commit */
	readonly sha: string;
	/** Whether the merge was successful */
	readonly merged: boolean;
	/** Optional message */
	readonly message?: string;
}

// ============================================
// USER & ORGANIZATION TYPES
// ============================================

/**
 * Git user information
 */
export interface GitUser {
	/** Unique identifier */
	readonly id: string;
	/** Username/login */
	readonly login: string;
	/** Display name */
	readonly name?: string;
	/** Email address */
	readonly email?: string;
	/** Avatar URL */
	readonly avatarUrl?: string;
}

/**
 * Git organization information
 */
export interface GitOrganization {
	/** Unique identifier */
	readonly id: string;
	/** Organization login/slug */
	readonly login: string;
	/** Display name */
	readonly name?: string;
	/** Avatar URL */
	readonly avatarUrl?: string;
}

/**
 * Pull request information
 */
export interface GitPullRequest {
	/** Pull request number */
	readonly number: number;
	/** Pull request title */
	readonly title: string;
	/** Current state */
	readonly state: 'open' | 'closed' | 'merged';
	/** Source branch */
	readonly head: string;
	/** Target branch */
	readonly base: string;
	/** Web URL for the pull request */
	readonly url: string;
	/** Creation timestamp */
	readonly createdAt: string;
	/** Last update timestamp */
	readonly updatedAt: string;
	/** Optional body/description */
	readonly body?: string;
}

// ============================================
// LOCAL GIT OPERATIONS INTERFACE
// ============================================

/**
 * Interface for local git operations (clone, pull, push, commit, etc.)
 *
 * These operations work with the local filesystem using isomorphic-git.
 * They are implemented ONCE in BaseGitProvider and shared by all providers.
 * Plugin developers do NOT need to implement these - they just extend BaseGitProvider.
 */
export interface IGitOperations {
	/**
	 * Clone or pull a repository to local filesystem
	 * @returns The local directory path
	 */
	cloneOrPull(options: GitCloneOptions): Promise<string>;

	/**
	 * Pull latest changes from remote
	 */
	pull(dir: string, token: string, committer?: GitCommitter): Promise<void>;

	/**
	 * Add files to staging
	 */
	add(dir: string, paths: string | string[]): Promise<void>;

	/**
	 * Add all changes to staging
	 */
	addAll(dir: string): Promise<void>;

	/**
	 * Create a commit
	 * @returns The commit SHA
	 */
	commit(dir: string, message: string, committer?: GitCommitter): Promise<string>;

	/**
	 * Push changes to remote
	 */
	push(options: GitPushOptions): Promise<void>;

	/**
	 * Get current branch name
	 */
	getCurrentBranch(dir: string): Promise<string | null>;

	/**
	 * Get main/default branch name from remote
	 */
	getMainBranch(dir: string): Promise<string | null>;

	/**
	 * Switch to a branch, optionally creating it
	 * @returns The branch name
	 */
	switchBranch(dir: string, branch: string, create?: boolean): Promise<string>;

	/**
	 * Get file change status
	 */
	getStatus(dir: string): Promise<GitFileChange[]>;

	/**
	 * Get local directory path for a repository
	 */
	getLocalDir(owner: string, repo: string): string;

	/**
	 * Remove local repository directory
	 */
	removeLocalDir(owner: string, repo: string): Promise<void>;
}

// ============================================
// GIT PROVIDER PLUGIN INTERFACE
// ============================================

/**
 * Git provider plugin interface for PROVIDER-SPECIFIC API operations.
 *
 * This interface defines what plugins must implement for their specific provider.
 * Local git operations (clone, push, commit) are inherited from BaseGitProvider.
 *
 * Plugin Implementation Pattern:
 * ```typescript
 * class GitHubPlugin extends BaseGitProvider implements IGitProviderPlugin {
 *     // BaseGitProvider gives you: clone, push, commit, pull, etc.
 *     // You implement: getAuth, getCloneUrl, getWebUrl, and API operations
 * }
 * ```
 *
 * Capability: 'git-provider'
 */
export interface IGitProviderPlugin extends IPlugin {
	/** Provider name (e.g., 'github', 'gitlab', 'bitbucket') */
	readonly providerName: string;

	// ========================================
	// AUTHENTICATION (required for local git ops in base class)
	// ========================================

	/**
	 * Get authentication credentials for this provider.
	 * Called by BaseGitProvider for clone/push operations.
	 */
	getAuth(token: string): GitAuth;

	/**
	 * Get the clone URL for a repository.
	 * Called by BaseGitProvider for clone operations.
	 */
	getCloneUrl(owner: string, repo: string): string;

	/**
	 * Get the web URL for a repository
	 */
	getWebUrl(owner: string, repo: string): string;

	// ========================================
	// REPOSITORY API OPERATIONS
	// ========================================

	/**
	 * Create a new repository via provider API
	 */
	createRepository(options: CreateRepoOptions, token: string): Promise<GitRepository>;

	/**
	 * Get repository information via provider API
	 * @returns Repository info or null if not found
	 */
	getRepository(owner: string, repo: string, token: string): Promise<GitRepository | null>;

	/**
	 * Delete a repository via provider API
	 */
	deleteRepository(owner: string, repo: string, token: string): Promise<void>;

	/**
	 * Update repository settings via provider API
	 */
	updateRepository?(
		owner: string,
		repo: string,
		data: { isPrivate?: boolean; description?: string },
		token: string
	): Promise<GitRepository>;

	// ========================================
	// USER & ORGANIZATION API OPERATIONS
	// ========================================

	/**
	 * Get the authenticated user via provider API
	 */
	getUser(token: string): Promise<GitUser>;

	/**
	 * Get organizations the user belongs to via provider API
	 */
	getOrganizations(token: string): Promise<GitOrganization[]>;

	// ========================================
	// BRANCH API OPERATIONS
	// ========================================

	/**
	 * List branches in a repository via provider API
	 */
	listBranches(owner: string, repo: string, token: string): Promise<GitBranch[]>;

	/**
	 * Create a branch via provider API
	 */
	createBranch?(owner: string, repo: string, name: string, fromRef: string, token: string): Promise<GitBranch>;

	/**
	 * Delete a branch via provider API
	 */
	deleteBranch?(owner: string, repo: string, name: string, token: string): Promise<void>;

	// ========================================
	// PULL REQUEST API OPERATIONS
	// ========================================

	/**
	 * Create a pull request via provider API
	 */
	createPullRequest(options: CreatePROptions, token: string): Promise<GitPullRequest>;

	/**
	 * Get a pull request by number via provider API
	 */
	getPullRequest?(owner: string, repo: string, prNumber: number, token: string): Promise<GitPullRequest | null>;

	/**
	 * Merge a pull request via provider API
	 */
	mergePullRequest(
		owner: string,
		repo: string,
		prNumber: number,
		options: MergeOptions | undefined,
		token: string
	): Promise<MergeResult>;

	// ========================================
	// UTILITY API OPERATIONS
	// ========================================

	/**
	 * Check if a repository exists via provider API
	 */
	repositoryExists?(owner: string, repo: string, token: string): Promise<boolean>;

	/**
	 * Get the latest commit on a branch via provider API
	 */
	getLatestCommit?(owner: string, repo: string, branch: string, token: string): Promise<GitCommit | null>;
}

/**
 * Type guard for git provider plugins
 */
export function isGitProviderPlugin(plugin: IPlugin): plugin is IGitProviderPlugin {
	return plugin.capabilities.includes('git-provider');
}
