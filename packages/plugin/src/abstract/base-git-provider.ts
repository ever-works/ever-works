import { BasePlugin } from './base-plugin.js';
import type {
	IGitOperations,
	GitAuth,
	GitCommitter,
	GitCloneOptions,
	GitPushOptions,
	GitFileChange
} from '../contracts/capabilities/git-provider.interface.js';
import type { PluginCategory } from '../contracts/plugin-manifest.types.js';

/**
 * Abstract base class for Git provider plugins.
 *
 * This class defines the contract for git providers. It declares:
 * 1. Provider-specific methods: `getAuth()`, `getCloneUrl()`, `getWebUrl()`, `providerName`
 * 2. Local git operations from `IGitOperations`
 *
 * ## Implementation Note
 *
 * Local git operations (clone, push, commit, etc.) are the same for all providers.
 * They use isomorphic-git with provider-specific auth credentials.
 *
 * `BaseGitProvider` is the shared plugin-side contract. Provider plugins can
 * implement the local operations directly with isomorphic-git, or compose a
 * shared helper from their own package when multiple providers need the same
 * clone/commit/push behavior.
 *
 * ## Example
 *
 * ```typescript
 * class GitHubPlugin extends BaseGitProvider implements IGitProviderPlugin {
 *     readonly id = 'github';
 *     readonly name = 'GitHub';
 *     readonly version = '1.0.0';
 *     readonly providerName = 'github';
 *
 *     // Provider-specific auth (different for each provider)
 *     getAuth(token: string): GitAuth {
 *         return { username: 'x-access-token', password: token };
 *     }
 *
 *     getCloneUrl(owner: string, repo: string): string {
 *         return `https://github.com/${owner}/${repo}.git`;
 *     }
 *
 *     getWebUrl(owner: string, repo: string): string {
 *         return `https://github.com/${owner}/${repo}`;
 *     }
 *
 *     // Local git operations - use isomorphic-git
 *     // (same implementation for all providers, just uses different auth)
 *
 *     // API operations - provider-specific
 *     async createRepository(options, token) { ... }
 *     async getRepository(owner, repo, token) { ... }
 * }
 * ```
 */
export abstract class BaseGitProvider extends BasePlugin implements IGitOperations {
	readonly category: PluginCategory = 'git-provider';
	readonly capabilities: readonly string[] = ['git-provider'];

	/** Provider name (e.g., 'github', 'gitlab', 'bitbucket') */
	abstract readonly providerName: string;

	// ========================================
	// PROVIDER-SPECIFIC METHODS
	// These differ between GitHub, GitLab, etc.
	// ========================================

	/**
	 * Get authentication credentials for this provider.
	 *
	 * Each provider has a different auth format:
	 * - GitHub: `{ username: 'x-access-token', password: token }`
	 * - GitLab: `{ username: 'oauth2', password: token }`
	 * - Bitbucket: `{ username: 'x-token-auth', password: token }`
	 */
	abstract getAuth(token: string): GitAuth;

	/**
	 * Get the HTTPS clone URL for a repository.
	 *
	 * Examples:
	 * - GitHub: `https://github.com/${owner}/${repo}.git`
	 * - GitLab: `https://gitlab.com/${owner}/${repo}.git`
	 */
	abstract getCloneUrl(owner: string, repo: string): string;

	/**
	 * Get the web URL for a repository (for viewing in browser).
	 *
	 * Examples:
	 * - GitHub: `https://github.com/${owner}/${repo}`
	 * - GitLab: `https://gitlab.com/${owner}/${repo}`
	 */
	abstract getWebUrl(owner: string, repo: string): string;

	// ========================================
	// LOCAL GIT OPERATIONS (IGitOperations)
	// Same implementation for all providers
	// ========================================

	abstract cloneOrPull(options: GitCloneOptions): Promise<string>;
	abstract pull(dir: string, token: string, committer?: GitCommitter): Promise<void>;
	abstract add(dir: string, paths: string | string[]): Promise<void>;
	abstract addAll(dir: string): Promise<void>;
	abstract commit(dir: string, message: string, committer?: GitCommitter): Promise<string>;
	abstract push(options: GitPushOptions): Promise<void>;
	abstract getCurrentBranch(dir: string): Promise<string | null>;
	abstract getMainBranch(dir: string): Promise<string | null>;
	abstract switchBranch(dir: string, branch: string, create?: boolean): Promise<string>;
	abstract getStatus(dir: string): Promise<GitFileChange[]>;
	abstract getLocalDir(owner: string, repo: string): string;
	abstract removeLocalDir(owner: string, repo: string): Promise<void>;
	abstract replaceRemote(dir: string, remote: string, url: string): Promise<void>;
	abstract renameBranch(dir: string, oldName: string, newName: string): Promise<void>;

	// ========================================
	// HELPER METHODS
	// ========================================

	/**
	 * Get default committer information.
	 * Override in subclass to customize.
	 */
	protected getDefaultCommitter(): GitCommitter {
		return {
			name: 'Ever Works Bot',
			email: 'bot@ever.works'
		};
	}

	/**
	 * Merge provided committer with defaults.
	 */
	protected mergeCommitter(committer?: GitCommitter): GitCommitter {
		const defaults = this.getDefaultCommitter();
		return {
			name: committer?.name || defaults.name,
			email: committer?.email || defaults.email
		};
	}

	/**
	 * Check if a work is a valid git repository.
	 */
	protected async isGitRepository(dir: string): Promise<boolean> {
		try {
			await this.getCurrentBranch(dir);
			return true;
		} catch {
			return false;
		}
	}
}
