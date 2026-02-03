import { Injectable } from '@nestjs/common';
import type {
    IOAuthPlugin,
    OAuthConfig,
    OAuthToken,
    OAuthUser,
    IOAuthFacade,
    OAuthProviderInfo,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, isOAuthPlugin } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { OAuthTokenRepository } from '../database/repositories/oauth-token.repository';

export class OAuthFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'OAuthFacadeError';
    }
}

export class NoOAuthProviderError extends OAuthFacadeError {
    constructor() {
        super('No OAuth provider configured or available', 'getPlugin');
        this.name = 'NoOAuthProviderError';
    }
}

export class OAuthProviderNotFoundError extends OAuthFacadeError {
    constructor(providerId: string) {
        super(`OAuth provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'OAuthProviderNotFoundError';
    }
}

export class OAuthNotSupportedError extends OAuthFacadeError {
    constructor(providerId: string, operation: string) {
        super(`Plugin does not support OAuth: ${providerId}`, operation, providerId);
        this.name = 'OAuthNotSupportedError';
    }
}

/**
 * OAuth Facade Service for managing OAuth connections across all OAuth-capable plugins.
 *
 * This facade is decoupled from git-provider, allowing ANY plugin with OAuth capability
 * to use OAuth authentication (e.g., Slack, Notion, Salesforce, GitHub, etc.).
 */
@Injectable()
export class OAuthFacadeService implements IOAuthFacade {
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.OAUTH;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
    ) {}

    /**
     * Check if any OAuth provider is configured and available.
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Get list of available OAuth providers.
     */
    getAvailableProviders(): OAuthProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: p.manifest.name,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Get the OAuth authorization URL for a provider.
     */
    getAuthorizationUrl(providerId: string, state: string, config?: Partial<OAuthConfig>): string {
        const plugin = this.getPluginSync(providerId);
        return plugin.getAuthorizationUrl(state, config);
    }

    /**
     * Exchange an authorization code for an access token.
     */
    async exchangeCodeForToken(
        providerId: string,
        code: string,
        config?: Partial<OAuthConfig>,
    ): Promise<OAuthToken> {
        const plugin = this.getPluginSync(providerId);
        return plugin.exchangeCodeForToken(code, config);
    }

    /**
     * Get the authenticated user information using an access token.
     */
    async getAuthenticatedUser(providerId: string, token: string): Promise<OAuthUser> {
        const plugin = this.getPluginSync(providerId);
        return plugin.getAuthenticatedUser(token);
    }

    /**
     * Check if a user has valid OAuth credentials for a provider.
     */
    async hasValidCredentials(userId: string, providerId: string): Promise<boolean> {
        try {
            const token = await this.oauthTokenRepository.findByUserAndProvider(userId, providerId);
            return token !== null && !this.oauthTokenRepository.isTokenExpired(token);
        } catch {
            return false;
        }
    }

    /**
     * Get the access token for a user and provider.
     */
    async getAccessToken(userId: string, providerId: string): Promise<string | null> {
        try {
            const oauthToken = await this.oauthTokenRepository.findByUserAndProvider(
                userId,
                providerId,
            );
            if (!oauthToken || this.oauthTokenRepository.isTokenExpired(oauthToken)) {
                return null;
            }
            return oauthToken.accessToken;
        } catch {
            return null;
        }
    }

    /**
     * Revoke/delete OAuth token for a user and provider.
     */
    async revokeToken(userId: string, providerId: string): Promise<void> {
        // Try to call provider's revokeToken if available
        try {
            const plugin = this.getPluginSync(providerId);
            const token = await this.oauthTokenRepository.findByUserAndProvider(userId, providerId);
            if (token && plugin.revokeToken) {
                await plugin.revokeToken(token.accessToken);
            }
        } catch {
            // Continue even if remote revocation fails
        }

        // Always delete from local storage
        await this.oauthTokenRepository.deleteByUserAndProvider(userId, providerId);
    }

    /**
     * Get OAuth plugin synchronously by provider ID.
     * @throws OAuthProviderNotFoundError if provider is not found or not enabled
     * @throws OAuthNotSupportedError if plugin doesn't have OAuth capability
     */
    private getPluginSync(providerId: string): IOAuthPlugin {
        const plugins = this.registry.getByCapability(this.CAPABILITY);

        if (providerId) {
            const registered = plugins.find((p) => p.plugin.id === providerId);
            if (registered?.state === 'enabled') {
                if (!isOAuthPlugin(registered.plugin)) {
                    throw new OAuthNotSupportedError(providerId, 'getPlugin');
                }
                return registered.plugin as IOAuthPlugin;
            }
        }

        // If no specific provider requested, try to find any enabled OAuth provider
        const enabled = plugins.find((p) => p.state === 'enabled');
        if (!enabled) {
            throw new NoOAuthProviderError();
        }
        if (!isOAuthPlugin(enabled.plugin)) {
            throw new OAuthNotSupportedError(enabled.plugin.id, 'getPlugin');
        }
        return enabled.plugin as IOAuthPlugin;
    }
}
