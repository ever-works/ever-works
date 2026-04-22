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
import {
    AuthAccountRepository,
    buildPluginProviderId,
} from '../database/repositories/auth-account.repository';
import { FacadeError } from './base.facade';

export class OAuthFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
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
        private readonly authAccountRepository: AuthAccountRepository,
    ) {}

    private getRequiredScopes(providerId: string): readonly string[] {
        switch (providerId) {
            case 'github':
                return ['repo'];
            default:
                return [];
        }
    }

    private isUsableProviderAccount(
        providerId: string,
        account: {
            accessToken?: string | null;
            scope?: string | null;
            accessTokenExpiresAt?: Date | null;
        },
    ): boolean {
        return (
            !!account.accessToken &&
            !this.authAccountRepository.isAccessTokenExpired(account) &&
            this.authAccountRepository.hasRequiredScopes(
                account,
                this.getRequiredScopes(providerId),
            )
        );
    }

    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'loaded');
    }

    getAvailableProviders(): OAuthProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: p.manifest.name,
            enabled: p.state === 'loaded',
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

            const account = await this.authAccountRepository.findProviderAccount(
                userId,
                buildPluginProviderId(providerId),
            );
            return account !== null && this.isUsableProviderAccount(providerId, account);
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

            const account = await this.authAccountRepository.findProviderAccount(
                userId,
                buildPluginProviderId(providerId),
            );
            if (!account || !this.isUsableProviderAccount(providerId, account)) {
                return null;
            }
            return account.accessToken || null;
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

        const namespacedProviderId = buildPluginProviderId(providerId);
        try {
            const plugin = this.getPluginSync(providerId);
            const account = await this.authAccountRepository.findProviderAccount(
                userId,
                namespacedProviderId,
            );
            if (account?.accessToken && plugin.revokeToken) {
                await plugin.revokeToken(account.accessToken);
            }
        } catch {
            // Continue even if remote revocation fails
        }

        await this.authAccountRepository.deleteProviderAccount(userId, namespacedProviderId);
    }

    private getPluginSync(providerId: string): IOAuthPlugin {
        const plugins = this.registry.getByCapability(this.CAPABILITY);

        if (providerId) {
            const registered = plugins.find((p) => p.plugin.id === providerId);
            if (registered?.state === 'loaded') {
                if (!isOAuthPlugin(registered.plugin)) {
                    throw new OAuthNotSupportedError(providerId, 'getPlugin');
                }
                return registered.plugin as IOAuthPlugin;
            }
        }

        // If no specific provider requested, try to find any enabled OAuth provider
        const enabled = plugins.find((p) => p.state === 'loaded');
        if (!enabled) {
            throw new NoOAuthProviderError();
        }
        if (!isOAuthPlugin(enabled.plugin)) {
            throw new OAuthNotSupportedError(enabled.plugin.id, 'getPlugin');
        }
        return enabled.plugin as IOAuthPlugin;
    }
}
