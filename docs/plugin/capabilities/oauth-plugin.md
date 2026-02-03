# Creating an OAuth Plugin

This guide explains how to create an OAuth-only plugin for Ever Works. OAuth plugins enable user authentication and authorization with external services like Google, Twitter, LinkedIn, etc.

> **Note:** If you need git repository operations along with OAuth, see [Git Provider Plugin Guide](./git-provider-plugin.md) instead.

## Overview

An OAuth plugin implements the `IOAuthPlugin` interface and provides:

- **Authorization URL generation** - Where to redirect users to authorize
- **Token exchange** - Converting authorization code to access token
- **User info retrieval** - Getting authenticated user details
- **Optional token refresh** - Refreshing expired tokens
- **Optional token revocation** - Revoking user access

## Quick Start

```typescript
import type {
	IPlugin,
	IOAuthPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	OAuthConfig,
	OAuthToken,
	OAuthUser
} from '@ever-works/plugin';

export class GoogleOAuthPlugin implements IPlugin, IOAuthPlugin {
	readonly id = 'google-oauth';
	readonly name = 'Google OAuth';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'integration';
	readonly capabilities = ['oauth'] as const;
	readonly configurationMode = 'admin-only';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			clientId: {
				type: 'string',
				title: 'Client ID',
				'x-envVar': 'PLUGIN_GOOGLE_CLIENT_ID',
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'Client Secret',
				'x-secret': true,
				'x-envVar': 'PLUGIN_GOOGLE_CLIENT_SECRET',
				'x-adminOnly': true,
				'x-scope': 'global'
			}
		}
	};

	// IOAuthPlugin implementation
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string {
		/* ... */
	}
	async exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		/* ... */
	}
	async getAuthenticatedUser(token: string): Promise<OAuthUser> {
		/* ... */
	}

	// IPlugin lifecycle
	async onLoad(context: PluginContext): Promise<void> {
		/* ... */
	}
	async onEnable(context: PluginContext): Promise<void> {
		/* ... */
	}
	async onDisable(context: PluginContext): Promise<void> {
		/* ... */
	}
	async onUnload(): Promise<void> {
		/* ... */
	}
	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		/* ... */
	}
	getManifest(): PluginManifest {
		/* ... */
	}
}
```

## Complete Implementation

### 1. Project Setup

```bash
mkdir packages/plugins/google-oauth
cd packages/plugins/google-oauth
pnpm init
```

**package.json:**

```json
{
	"name": "@ever-works/google-oauth-plugin",
	"version": "1.0.0",
	"type": "module",
	"main": "./dist/index.js",
	"module": "./dist/index.mjs",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"import": "./dist/index.mjs",
			"require": "./dist/index.js",
			"types": "./dist/index.d.ts"
		}
	},
	"scripts": {
		"build": "tsup",
		"dev": "tsup --watch"
	},
	"dependencies": {
		"@ever-works/plugin": "workspace:*"
	},
	"devDependencies": {
		"tsup": "^8.0.0",
		"typescript": "^5.0.0"
	}
}
```

### 2. Full Plugin Implementation

**src/google-oauth.plugin.ts:**

```typescript
import type {
	IPlugin,
	IOAuthPlugin,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	PluginSettings,
	OAuthConfig,
	OAuthToken,
	OAuthUser
} from '@ever-works/plugin';

interface GoogleOAuthSettings {
	clientId?: string;
	clientSecret?: string;
}

const DEFAULT_SCOPES = ['openid', 'email', 'profile'] as const;

export class GoogleOAuthPlugin implements IPlugin, IOAuthPlugin {
	// ─────────────────────────────────────────────────────────────────
	// Plugin Identity
	// ─────────────────────────────────────────────────────────────────

	readonly id = 'google-oauth';
	readonly name = 'Google OAuth';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'integration';
	readonly capabilities: readonly string[] = ['oauth'];
	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'admin-only';

	// ─────────────────────────────────────────────────────────────────
	// Settings Schema
	// ─────────────────────────────────────────────────────────────────

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			clientId: {
				type: 'string',
				title: 'Client ID',
				description: 'Google OAuth 2.0 Client ID from Google Cloud Console',
				'x-envVar': 'PLUGIN_GOOGLE_CLIENT_ID',
				'x-writeOnly': true,
				'x-adminOnly': true,
				'x-scope': 'global'
			},
			clientSecret: {
				type: 'string',
				title: 'Client Secret',
				description: 'Google OAuth 2.0 Client Secret',
				'x-secret': true,
				'x-masked': true,
				'x-writeOnly': true,
				'x-envVar': 'PLUGIN_GOOGLE_CLIENT_SECRET',
				'x-adminOnly': true,
				'x-scope': 'global'
			}
		}
	};

	// ─────────────────────────────────────────────────────────────────
	// Private State
	// ─────────────────────────────────────────────────────────────────

	private context?: PluginContext;

	// ─────────────────────────────────────────────────────────────────
	// IOAuthPlugin - Required Methods
	// ─────────────────────────────────────────────────────────────────

	/**
	 * Generate the OAuth authorization URL.
	 *
	 * The platform calls this method when a user initiates OAuth login.
	 * The user will be redirected to this URL to authorize your app.
	 *
	 * @param state - CSRF protection state (generated by platform)
	 * @param config - OAuth configuration (clientId, redirectUri, scopes)
	 * @returns Full authorization URL with query parameters
	 */
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string {
		const clientId = config?.clientId;
		const redirectUri = config?.redirectUri;
		const scopes = config?.scopes || DEFAULT_SCOPES;

		if (!clientId) {
			throw new Error('Google OAuth client ID not configured');
		}

		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri || '',
			response_type: 'code',
			scope: scopes.join(' '),
			state,
			access_type: 'offline', // Request refresh token
			prompt: 'consent' // Always show consent screen for refresh token
		});

		return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
	}

	/**
	 * Exchange authorization code for access token.
	 *
	 * Called by the platform after the user authorizes and is redirected
	 * back to the callback URL with an authorization code.
	 *
	 * @param code - Authorization code from the OAuth callback
	 * @param config - OAuth configuration (clientId, clientSecret, redirectUri)
	 * @returns Access token and optional refresh token
	 */
	async exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		const clientId = config?.clientId;
		const clientSecret = config?.clientSecret;
		const redirectUri = config?.redirectUri;

		if (!clientId || !clientSecret) {
			throw new Error('Google OAuth credentials not configured');
		}

		const response = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri || '',
				grant_type: 'authorization_code'
			})
		});

		const data = await response.json();

		if (data.error) {
			throw new Error(`Google OAuth error: ${data.error_description || data.error}`);
		}

		return {
			accessToken: data.access_token,
			tokenType: data.token_type || 'Bearer',
			scope: data.scope,
			expiresIn: data.expires_in,
			refreshToken: data.refresh_token // Only returned on first authorization
		};
	}

	/**
	 * Get authenticated user information.
	 *
	 * Called by the platform after successful token exchange to get
	 * user details for creating/updating the user record.
	 *
	 * @param token - Access token from exchangeCodeForToken
	 * @returns User information
	 */
	async getAuthenticatedUser(token: string): Promise<OAuthUser> {
		const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
			headers: {
				Authorization: `Bearer ${token}`
			}
		});

		if (!response.ok) {
			throw new Error('Failed to get Google user info');
		}

		const data = await response.json();

		return {
			id: data.id,
			username: data.email, // Google uses email as username
			email: data.email,
			name: data.name,
			avatarUrl: data.picture
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// IOAuthPlugin - Optional Methods
	// ─────────────────────────────────────────────────────────────────

	/**
	 * Refresh an expired access token.
	 *
	 * Called by the platform when an access token has expired and
	 * a refresh token is available.
	 *
	 * @param refreshToken - Refresh token from original authorization
	 * @param config - OAuth configuration
	 * @returns New access token
	 */
	async refreshAccessToken(refreshToken: string, config?: Partial<OAuthConfig>): Promise<OAuthToken> {
		const clientId = config?.clientId;
		const clientSecret = config?.clientSecret;

		if (!clientId || !clientSecret) {
			throw new Error('Google OAuth credentials not configured');
		}

		const response = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: 'refresh_token'
			})
		});

		const data = await response.json();

		if (data.error) {
			throw new Error(`Google OAuth refresh error: ${data.error_description || data.error}`);
		}

		return {
			accessToken: data.access_token,
			tokenType: data.token_type || 'Bearer',
			scope: data.scope,
			expiresIn: data.expires_in
			// Note: Google doesn't return a new refresh token
		};
	}

	/**
	 * Revoke a token (logout/disconnect).
	 *
	 * Called when a user disconnects their account or logs out.
	 *
	 * @param token - Access token or refresh token to revoke
	 */
	async revokeToken(token: string): Promise<void> {
		const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
			method: 'POST'
		});

		if (!response.ok) {
			const data = await response.json();
			throw new Error(`Failed to revoke token: ${data.error_description || data.error}`);
		}
	}

	// ─────────────────────────────────────────────────────────────────
	// IPlugin - Lifecycle Methods
	// ─────────────────────────────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Google OAuth Plugin loaded');
	}

	async onEnable(context: PluginContext): Promise<void> {
		context.logger.log('Google OAuth Plugin enabled');
	}

	async onDisable(context: PluginContext): Promise<void> {
		context.logger.log('Google OAuth Plugin disabled');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		// OAuth plugins typically don't need custom validation
		// The platform validates against the JSON schema automatically
		return { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		// Optionally test the OAuth endpoint
		try {
			const response = await fetch('https://accounts.google.com/.well-known/openid-configuration');
			if (response.ok) {
				return {
					status: 'healthy',
					message: 'Google OAuth endpoint reachable',
					checkedAt: Date.now()
				};
			}
		} catch {
			// Fall through to unhealthy
		}

		return {
			status: 'unhealthy',
			message: 'Cannot reach Google OAuth endpoint',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Google OAuth 2.0 authentication',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: false,
			autoEnable: false,
			visibility: 'user-only',
			icon: {
				type: 'lucide',
				value: 'Chrome', // Or use a custom SVG
				backgroundColor: '#4285F4'
			}
		};
	}

	// ─────────────────────────────────────────────────────────────────
	// Private Helpers
	// ─────────────────────────────────────────────────────────────────

	private async getSettings(): Promise<GoogleOAuthSettings> {
		if (!this.context) return {};
		const settings = await this.context.getSettings();
		return {
			clientId: settings?.clientId as string | undefined,
			clientSecret: settings?.clientSecret as string | undefined
		};
	}
}

export default GoogleOAuthPlugin;
```

### 3. Export the Plugin

**src/index.ts:**

```typescript
export { GoogleOAuthPlugin, default } from './google-oauth.plugin.js';
```

## OAuth Flow Explained

The platform handles the OAuth flow automatically. Here's what happens:

### 1. User Initiates Login

```
User clicks "Connect with Google"
    ↓
Platform calls plugin.getAuthorizationUrl(state, config)
    ↓
User redirected to: https://accounts.google.com/o/oauth2/v2/auth?...
```

### 2. User Authorizes

```
User grants permission on Google
    ↓
Google redirects to: https://your-app.com/api/v1/auth/oauth/callback?code=xxx&state=yyy
```

### 3. Token Exchange

```
Platform receives callback
    ↓
Platform calls plugin.exchangeCodeForToken(code, config)
    ↓
Plugin exchanges code for access token
    ↓
Platform stores token in oauth_tokens table
```

### 4. Get User Info

```
Platform calls plugin.getAuthenticatedUser(accessToken)
    ↓
Plugin fetches user info from provider
    ↓
Platform creates/updates user record
```

## Callback URL Configuration

When creating your OAuth application on the provider's developer console, configure this callback URL:

```
https://your-domain.com/api/v1/auth/oauth/callback
```

The callback URL is the same for all OAuth plugins. The platform routes the callback to the correct plugin using the `state` parameter.

### Example: Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Go to **APIs & Services** > **Credentials**
4. Click **Create Credentials** > **OAuth client ID**
5. Select **Web application**
6. Add authorized redirect URI: `https://your-domain.com/api/v1/auth/oauth/callback`
7. Copy the **Client ID** and **Client Secret**

## Environment Variables

Configure these environment variables for your OAuth plugin:

```bash
# .env
PLUGIN_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
PLUGIN_GOOGLE_CLIENT_SECRET=your-google-client-secret
```

## IOAuthPlugin Interface Reference

```typescript
interface IOAuthPlugin extends IPlugin {
	/**
	 * Generate authorization URL for OAuth redirect.
	 * @param state - CSRF protection state token
	 * @param config - OAuth configuration (clientId, redirectUri, scopes)
	 */
	getAuthorizationUrl(state: string, config?: Partial<OAuthConfig>): string;

	/**
	 * Exchange authorization code for access token.
	 * @param code - Authorization code from OAuth callback
	 * @param config - OAuth configuration (clientId, clientSecret, redirectUri)
	 */
	exchangeCodeForToken(code: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;

	/**
	 * Refresh an expired access token (optional).
	 * @param refreshToken - Refresh token from original authorization
	 * @param config - OAuth configuration
	 */
	refreshAccessToken?(refreshToken: string, config?: Partial<OAuthConfig>): Promise<OAuthToken>;

	/**
	 * Revoke a token (optional).
	 * @param token - Access or refresh token to revoke
	 */
	revokeToken?(token: string): Promise<void>;

	/**
	 * Get authenticated user information.
	 * @param token - Valid access token
	 */
	getAuthenticatedUser(token: string): Promise<OAuthUser>;
}
```

## OAuthConfig and OAuthToken Types

```typescript
interface OAuthConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri: string;
	readonly scopes: readonly string[];
}

interface OAuthToken {
	readonly accessToken: string;
	readonly tokenType: string; // e.g., "Bearer"
	readonly scope?: string; // Granted scopes
	readonly expiresIn?: number; // Seconds until expiration
	readonly refreshToken?: string; // For refreshing expired tokens
}

interface OAuthUser {
	readonly id: string; // Provider's user ID
	readonly username: string; // Display name or email
	readonly email?: string;
	readonly name?: string; // Full name
	readonly avatarUrl?: string;
}
```

## Testing Your Plugin

**src/**tests**/google-oauth.plugin.spec.ts:**

```typescript
import { GoogleOAuthPlugin } from '../google-oauth.plugin';

describe('GoogleOAuthPlugin', () => {
	let plugin: GoogleOAuthPlugin;

	beforeEach(() => {
		plugin = new GoogleOAuthPlugin();
	});

	describe('identity', () => {
		it('should have correct id and capabilities', () => {
			expect(plugin.id).toBe('google-oauth');
			expect(plugin.capabilities).toContain('oauth');
			expect(plugin.capabilities).not.toContain('git-provider');
		});
	});

	describe('getAuthorizationUrl', () => {
		it('should generate valid authorization URL', () => {
			const url = plugin.getAuthorizationUrl('test-state', {
				clientId: 'test-client-id',
				redirectUri: 'https://app.com/callback',
				scopes: ['openid', 'email']
			});

			expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
			expect(url).toContain('client_id=test-client-id');
			expect(url).toContain('state=test-state');
			expect(url).toContain('response_type=code');
			expect(url).toContain('scope=openid+email');
		});

		it('should use default scopes when not provided', () => {
			const url = plugin.getAuthorizationUrl('state', {
				clientId: 'client-id',
				redirectUri: 'https://app.com/callback'
			});

			expect(url).toContain('scope=openid+email+profile');
		});

		it('should throw if clientId not provided', () => {
			expect(() => plugin.getAuthorizationUrl('state', {})).toThrow('Google OAuth client ID not configured');
		});
	});

	describe('exchangeCodeForToken', () => {
		it('should throw if credentials not provided', async () => {
			await expect(plugin.exchangeCodeForToken('code', {})).rejects.toThrow(
				'Google OAuth credentials not configured'
			);
		});
	});

	describe('manifest', () => {
		it('should return valid manifest', () => {
			const manifest = plugin.getManifest();

			expect(manifest.id).toBe('google-oauth');
			expect(manifest.capabilities).toContain('oauth');
			expect(manifest.category).toBe('integration');
		});
	});
});
```

## Common OAuth Providers

Here are authorization and token URLs for common OAuth providers:

| Provider  | Authorization URL                                                  | Token URL                                                      |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| Google    | `https://accounts.google.com/o/oauth2/v2/auth`                     | `https://oauth2.googleapis.com/token`                          |
| GitHub    | `https://github.com/login/oauth/authorize`                         | `https://github.com/login/oauth/access_token`                  |
| GitLab    | `https://gitlab.com/oauth/authorize`                               | `https://gitlab.com/oauth/token`                               |
| Microsoft | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` |
| Twitter   | `https://twitter.com/i/oauth2/authorize`                           | `https://api.twitter.com/2/oauth2/token`                       |
| LinkedIn  | `https://www.linkedin.com/oauth/v2/authorization`                  | `https://www.linkedin.com/oauth/v2/accessToken`                |
| Discord   | `https://discord.com/api/oauth2/authorize`                         | `https://discord.com/api/oauth2/token`                         |

## See Also

- [Git Provider Plugin Guide](./git-provider-plugin.md) - For OAuth + Git operations
- [Plugin Architecture Guide](../PLUGIN_ARCHITECTURE_GUIDE.md) - Complete plugin system overview
- [Plugin Package Guide](../PLUGIN_PACKAGE_GUIDE.md) - Package structure and conventions
