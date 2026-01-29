import type { IPlugin } from '../plugin.interface.js';
import type { GitRepository } from './git-provider.interface.js';

/**
 * OAuth configuration
 */
export interface OAuthConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri: string;
	readonly scopes: readonly string[];
}

/**
 * OAuth token response
 */
export interface OAuthToken {
	readonly accessToken: string;
	readonly tokenType: string;
	readonly scope?: string;
	readonly expiresIn?: number;
	readonly refreshToken?: string;
}

/**
 * OAuth user information
 */
export interface OAuthUser {
	readonly id: string;
	readonly username: string;
	readonly email?: string;
	readonly name?: string;
	readonly avatarUrl?: string;
}

/**
 * Repository permissions (for git OAuth providers)
 */
export interface GitRepositoryPermissions {
	readonly admin: boolean;
	readonly push: boolean;
	readonly pull: boolean;
}

/**
 * Extended repository information with permissions (for git OAuth providers)
 */
export interface GitRepositoryWithPermissions extends GitRepository {
	readonly permissions?: GitRepositoryPermissions;
}

/**
 * OAuth plugin interface
 * Capability: 'oauth'
 *
 * This is a generic OAuth interface for any provider that requires OAuth authentication.
 * For git providers specifically, this is a SEPARATE capability from 'git-provider'.
 * A plugin can implement:
 * - Just IOAuthPlugin (for OAuth-only functionality)
 * - Just IGitProviderPlugin (for git operations without OAuth)
 * - Both interfaces (full git provider with OAuth support)
 *
 * Note: This interface uses token-first parameter order for OAuth operations,
 * which differs from IGitProviderPlugin's token-last convention.
 */
export interface IOAuthPlugin extends IPlugin {
	/**
	 * Get the OAuth authorization URL
	 */
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string;

	/**
	 * Exchange authorization code for access token
	 */
	exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;

	/**
	 * Refresh an access token
	 */
	refreshAccessToken?(refreshToken: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;

	/**
	 * Revoke an access token
	 */
	revokeToken?(token: string): Promise<void>;

	/**
	 * Get authenticated user information
	 */
	getAuthenticatedUser(token: string): Promise<OAuthUser>;

	/**
	 * List repositories accessible by the authenticated user
	 * (Primarily for git OAuth providers)
	 */
	listRepositories?(token: string, page?: number, perPage?: number): Promise<GitRepositoryWithPermissions[]>;

	/**
	 * Get a specific repository
	 * (Primarily for git OAuth providers)
	 */
	getRepository?(token: string, owner: string, repo: string): Promise<GitRepositoryWithPermissions | null>;

	/**
	 * Check if user has access to a repository
	 * (Primarily for git OAuth providers)
	 */
	hasRepositoryAccess?(token: string, owner: string, repo: string): Promise<boolean>;

	/**
	 * Create a new repository
	 * (Primarily for git OAuth providers)
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
 * Type guard for OAuth plugins
 */
export function isOAuthPlugin(plugin: IPlugin): plugin is IOAuthPlugin {
	return plugin.capabilities.includes('oauth');
}
