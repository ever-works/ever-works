import type { OAuthConfig, OAuthToken, OAuthUser } from '../../contracts/capabilities/oauth.interface.js';

/**
 * Information about an available OAuth provider.
 */
export interface OAuthProviderInfo {
	/** Provider plugin ID */
	id: string;
	/** Human-readable provider name */
	name: string;
	/** Whether the provider is enabled */
	enabled: boolean;
}

/**
 * OAuth Facade interface for managing OAuth connections.
 *
 * This interface defines OAuth operations available through the facade layer.
 * The actual implementation lives in packages/agent as a NestJS service.
 *
 * This facade is separate from git-provider to allow ANY plugin with OAuth
 * capability to use OAuth authentication (e.g., Slack, Notion, Salesforce).
 */
export interface IOAuthFacade {
	/**
	 * Check if any OAuth provider is configured and available.
	 */
	isConfigured(): boolean;

	/**
	 * Get list of available OAuth providers.
	 */
	getAvailableProviders(): OAuthProviderInfo[];

	/**
	 * Get the OAuth authorization URL for a provider.
	 *
	 * @param providerId - OAuth provider ID
	 * @param state - CSRF protection state parameter
	 * @param config - Optional OAuth configuration override
	 * @returns Authorization URL to redirect user to
	 */
	getAuthorizationUrl(providerId: string, state: string, config?: Partial<OAuthConfig>): string;

	/**
	 * Exchange an authorization code for an access token.
	 *
	 * @param providerId - OAuth provider ID
	 * @param code - Authorization code from OAuth callback
	 * @param config - Optional OAuth configuration override
	 * @returns OAuth token response
	 */
	exchangeCodeForToken(providerId: string, code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;

	/**
	 * Get the authenticated user information using an access token.
	 *
	 * @param providerId - OAuth provider ID
	 * @param token - Access token
	 * @returns User information from the OAuth provider
	 */
	getAuthenticatedUser(providerId: string, token: string): Promise<OAuthUser>;

	/**
	 * Check if a user has valid OAuth credentials for a provider.
	 *
	 * @param userId - User ID
	 * @param providerId - OAuth provider ID
	 * @returns True if user has valid, non-expired credentials
	 */
	hasValidCredentials(userId: string, providerId: string): Promise<boolean>;

	/**
	 * Get the access token for a user and provider.
	 *
	 * @param userId - User ID
	 * @param providerId - OAuth provider ID
	 * @returns Access token or null if not found/expired
	 */
	getAccessToken(userId: string, providerId: string): Promise<string | null>;

	/**
	 * Revoke/delete OAuth token for a user and provider.
	 *
	 * @param userId - User ID
	 * @param providerId - OAuth provider ID
	 */
	revokeToken(userId: string, providerId: string): Promise<void>;
}
