import type { IPlugin } from '../plugin.interface.js';
import type { GitRepository } from './git-provider.interface.js';

/**
 * OAuth configuration for git providers
 */
export interface GitOAuthConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri: string;
	readonly scopes: readonly string[];
}

/**
 * OAuth token response
 */
export interface GitOAuthToken {
	readonly accessToken: string;
	readonly tokenType: string;
	readonly scope?: string;
	readonly expiresIn?: number;
	readonly refreshToken?: string;
}

/**
 * OAuth user information
 */
export interface GitOAuthUser {
	readonly id: string;
	readonly username: string;
	readonly email?: string;
	readonly name?: string;
	readonly avatarUrl?: string;
}

/**
 * Repository permissions
 */
export interface GitRepositoryPermissions {
	readonly admin: boolean;
	readonly push: boolean;
	readonly pull: boolean;
}

/**
 * Extended repository information with permissions
 */
export interface GitRepositoryWithPermissions extends GitRepository {
	readonly permissions?: GitRepositoryPermissions;
}

/**
 * Git OAuth plugin interface
 * Capability: 'git-oauth'
 *
 * This is a SEPARATE capability from 'git-provider'. A plugin can implement:
 * - Just IGitOAuthPlugin (for OAuth-only functionality)
 * - Just IGitProviderPlugin (for git operations without OAuth)
 * - Both interfaces (full git provider with OAuth support)
 *
 * Note: This interface uses token-first parameter order for OAuth operations,
 * which differs from IGitProviderPlugin's token-last convention.
 */
export interface IGitOAuthPlugin extends IPlugin {
	/**
	 * Get the OAuth authorization URL
	 */
	getAuthorizationUrl(state: string, config?: Partial<GitOAuthConfig>): string;

	/**
	 * Exchange authorization code for access token
	 */
	exchangeCodeForToken(code: string, config?: Partial<GitOAuthConfig>): Promise<GitOAuthToken>;

	/**
	 * Refresh an access token
	 */
	refreshAccessToken?(refreshToken: string, config?: Partial<GitOAuthConfig>): Promise<GitOAuthToken>;

	/**
	 * Revoke an access token
	 */
	revokeToken?(token: string): Promise<void>;

	/**
	 * Get authenticated user information
	 */
	getAuthenticatedUser(token: string): Promise<GitOAuthUser>;

	/**
	 * List repositories accessible by the authenticated user
	 */
	listRepositories(token: string, page?: number, perPage?: number): Promise<GitRepositoryWithPermissions[]>;

	/**
	 * Get a specific repository
	 */
	getRepository(token: string, owner: string, repo: string): Promise<GitRepositoryWithPermissions | null>;

	/**
	 * Check if user has access to a repository
	 */
	hasRepositoryAccess(token: string, owner: string, repo: string): Promise<boolean>;

	/**
	 * Create a new repository
	 */
	createRepository?(token: string, name: string, options?: CreateRepositoryOptions): Promise<GitRepository>;
}

/**
 * Options for creating a repository
 */
export interface CreateRepositoryOptions {
	readonly description?: string;
	readonly isPrivate?: boolean;
	readonly autoInit?: boolean;
	readonly gitignoreTemplate?: string;
	readonly licenseTemplate?: string;
}

/**
 * Type guard for git OAuth plugins
 */
export function isGitOAuthPlugin(plugin: IPlugin): plugin is IGitOAuthPlugin {
	return plugin.capabilities.includes('git-oauth');
}
