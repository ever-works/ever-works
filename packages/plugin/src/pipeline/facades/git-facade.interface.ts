import type { GitCommitter, GitFileChange } from '../../contracts/capabilities/git-provider.interface.js';

/**
 * Options for cloning or pulling a repository.
 */
export interface GitFacadeCloneOptions {
	/** Repository owner (user or organization) */
	readonly owner: string;
	/** Repository name */
	readonly repo: string;
	/** Git committer info for pull operations */
	readonly committer?: GitCommitter;
	/** Branch to checkout after clone */
	readonly branch?: string;
	/** Auto-switch to main branch if specified branch doesn't exist */
	readonly autoSwitchToMainBranch?: boolean;
}

/**
 * Options for pushing to a repository.
 */
export interface GitFacadePushOptions {
	/** Local directory path */
	readonly dir: string;
	/** Force push */
	readonly force?: boolean;
	/** Max retry attempts */
	readonly maxRetries?: number;
}

/**
 * Git Facade interface for pipeline steps.
 *
 * This interface defines git operations available to pipeline steps
 * via the StepExecutionContext. The actual implementation lives in packages/agent
 * as a NestJS service.
 *
 * All operations that work on a local repository require `providerId`
 * as the FIRST parameter to ensure the correct plugin implementation is used.
 *
 * The actual implementation in packages/agent handles:
 * - Provider resolution
 * - OAuth token management
 * - Error handling
 */
export interface IGitFacade {
	// ==========================================
	// Local Git Operations (require providerId)
	// ==========================================

	/**
	 * Stage files for commit.
	 *
	 * @param providerId - Git provider ID (e.g., 'github', 'gitlab')
	 * @param dir - Local repository directory path
	 * @param paths - File path(s) to stage
	 */
	add(providerId: string, dir: string, paths: string | string[]): Promise<void>;

	/**
	 * Stage all changes for commit.
	 *
	 * @param providerId - Git provider ID
	 * @param dir - Local repository directory path
	 */
	addAll(providerId: string, dir: string): Promise<void>;

	/**
	 * Create a commit with staged changes.
	 *
	 * @param providerId - Git provider ID
	 * @param dir - Local repository directory path
	 * @param message - Commit message
	 * @param committer - Optional committer info
	 * @returns Commit SHA
	 */
	commit(providerId: string, dir: string, message: string, committer?: GitCommitter): Promise<string>;

	/**
	 * Get the current branch name.
	 *
	 * @param providerId - Git provider ID
	 * @param dir - Local repository directory path
	 * @returns Current branch name or null if not on a branch
	 */
	getCurrentBranch(providerId: string, dir: string): Promise<string | null>;

	/**
	 * Get the main/default branch name.
	 *
	 * @param providerId - Git provider ID
	 * @param dir - Local repository directory path
	 * @returns Main branch name or null
	 */
	getMainBranch(providerId: string, dir: string): Promise<string | null>;

	/**
	 * Switch to a branch, optionally creating it.
	 *
	 * @param providerId - Git provider ID
	 * @param dir - Local repository directory path
	 * @param branch - Branch name to switch to
	 * @param create - Create the branch if it doesn't exist
	 * @returns The branch name
	 */
	switchBranch(providerId: string, dir: string, branch: string, create?: boolean): Promise<string>;

	/**
	 * Get the status of the working directory.
	 *
	 * @param providerId - Git provider ID
	 * @param dir - Local repository directory path
	 * @returns List of file changes
	 */
	getStatus(providerId: string, dir: string): Promise<GitFileChange[]>;

	// ==========================================
	// URL Methods (require providerId)
	// ==========================================

	/**
	 * Get the clone URL for a repository.
	 *
	 * @param providerId - Git provider ID
	 * @param owner - Repository owner
	 * @param repo - Repository name
	 */
	getCloneUrl(providerId: string, owner: string, repo: string): string;

	/**
	 * Get the web URL for a repository.
	 *
	 * @param providerId - Git provider ID
	 * @param owner - Repository owner
	 * @param repo - Repository name
	 */
	getWebUrl(providerId: string, owner: string, repo: string): string;

	/**
	 * Get the local directory path for a repository.
	 *
	 * @param providerId - Git provider ID
	 * @param owner - Repository owner
	 * @param repo - Repository name
	 */
	getLocalDir(providerId: string, owner: string, repo: string): string;

	/**
	 * Remove the local directory for a repository.
	 *
	 * @param providerId - Git provider ID
	 * @param owner - Repository owner
	 * @param repo - Repository name
	 */
	removeLocalDir(providerId: string, owner: string, repo: string): Promise<void>;

	/**
	 * Get the raw file URL for a file in a repository.
	 *
	 * @param providerId - Git provider ID
	 * @param owner - Repository owner
	 * @param repo - Repository name
	 * @param branch - Branch name
	 * @param path - File path within the repository
	 */
	getRawFileUrl(providerId: string, owner: string, repo: string, branch: string, path: string): string;

	// ==========================================
	// Utility Methods
	// ==========================================

	/**
	 * Check if any git provider is configured.
	 */
	isConfigured(): boolean;
}
