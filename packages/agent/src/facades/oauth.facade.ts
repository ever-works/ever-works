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

@Injectable()
export class OAuthFacadeService implements IOAuthFacade {
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.OAUTH;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
    ) {}

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    getAvailableProviders(): OAuthProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: p.manifest.name,
            enabled: p.state === 'enabled',
        }));
    }

    getAuthorizationUrl(providerId: string, state: string, config?: Partial<OAuthConfig>): string {
        const plugin = this.getPluginSync(providerId);
        return plugin.getAuthorizationUrl(state, config);
    }

    async exchangeCodeForToken(
        providerId: string,
        code: string,
        config?: Partial<OAuthConfig>,
    ): Promise<OAuthToken> {
        const plugin = this.getPluginSync(providerId);
        return plugin.exchangeCodeForToken(code, config);
    }

    async getAuthenticatedUser(providerId: string, token: string): Promise<OAuthUser> {
        const plugin = this.getPluginSync(providerId);
        return plugin.getAuthenticatedUser(token);
    }

    async hasValidCredentials(userId: string, providerId: string): Promise<boolean> {
        try {
            const isEnabled = await this.registry.isPluginEnabledForScope(
                providerId,
                undefined,
                userId,
            );
            if (!isEnabled) return false;

            const token = await this.oauthTokenRepository.findByUserAndProvider(userId, providerId);
            return token !== null && !this.oauthTokenRepository.isTokenExpired(token);
        } catch {
            return false;
        }
    }

    async getAccessToken(userId: string, providerId: string): Promise<string | null> {
        try {
            const isEnabled = await this.registry.isPluginEnabledForScope(
                providerId,
                undefined,
                userId,
            );
            if (!isEnabled) return null;

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

    async revokeToken(userId: string, providerId: string): Promise<void> {
        const isEnabled = await this.registry.isPluginEnabledForScope(
            providerId,
            undefined,
            userId,
        );
        if (!isEnabled) return;

        try {
            const plugin = this.getPluginSync(providerId);
            const token = await this.oauthTokenRepository.findByUserAndProvider(userId, providerId);
            if (token && plugin.revokeToken) {
                await plugin.revokeToken(token.accessToken);
            }
        } catch {
            // Continue even if remote revocation fails
        }

        await this.oauthTokenRepository.deleteByUserAndProvider(userId, providerId);
    }

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
