import type { IPlugin } from '../plugin.interface.js';

export interface OAuthConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri: string;
	readonly scopes: readonly string[];
	readonly forceConsent?: boolean;
}

export interface OAuthToken {
	readonly accessToken: string;
	readonly tokenType: string;
	readonly scope?: string;
	readonly expiresIn?: number;
	readonly refreshToken?: string;
}

export interface OAuthUser {
	readonly id: string;
	readonly username: string;
	readonly email?: string;
	readonly name?: string;
	readonly avatarUrl?: string;
}

/**
 * OAuth plugin for authentication/authorization.
 * For Git operations, use 'git-provider' capability separately.
 */
export interface IOAuthPlugin extends IPlugin {
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string;
	exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;
	refreshAccessToken?(refreshToken: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;
	revokeToken?(token: string): Promise<void>;
	getAuthenticatedUser(token: string): Promise<OAuthUser>;
}

export function isOAuthPlugin(plugin: IPlugin): plugin is IOAuthPlugin {
	return plugin.capabilities.includes('oauth');
}
