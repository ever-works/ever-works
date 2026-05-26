import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { OAuthFacadeService } from '@ever-works/agent/facades';
import {
    AuthAccountRepository,
    PLUGIN_PROVIDER_PREFIX,
    buildPluginProviderId,
} from '@ever-works/agent/database';
import { PluginSettingsService } from '@ever-works/agent/plugins';
import type { OAuthConfig, OAuthProviderInfo } from '@ever-works/plugin';

export interface OAuthConnectionInfo extends OAuthProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    connectionSource?: 'plugin' | 'social';
}

@Injectable()
export class OAuthService {
    private readonly logger = new Logger(OAuthService.name);

    constructor(
        private readonly oauthFacade: OAuthFacadeService,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly pluginSettingsService: PluginSettingsService,
    ) {}

    isConfigured(): boolean {
        return this.oauthFacade.isConfigured();
    }

    getAvailableProviders(): OAuthProviderInfo[] {
        return this.oauthFacade.getAvailableProviders();
    }

    async checkConnection(userId: string, providerId: string): Promise<OAuthConnectionInfo> {
        const provider = this.oauthFacade.getAvailableProviders().find((p) => p.id === providerId);

        if (!provider) {
            return {
                id: providerId,
                name: 'Unknown',
                enabled: false,
                connected: false,
            };
        }

        try {
            const account = await this.authAccountRepository.findConnectedProviderAccount(
                userId,
                providerId,
                { usePluginProviderId: true },
            );
            if (!account?.accessToken) {
                return { ...provider, connected: false };
            }

            const user = await this.oauthFacade.getAuthenticatedUser(
                providerId,
                account.accessToken,
            );

            const connectionSource = account.providerId.startsWith(PLUGIN_PROVIDER_PREFIX)
                ? 'plugin'
                : 'social';

            return {
                ...provider,
                connected: true,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
                connectionSource,
            };
        } catch (error) {
            this.logger.warn(`Failed to get user info for provider ${providerId}:`, error);
            return { ...provider, connected: false };
        }
    }

    async getUser(userId: string, providerId: string) {
        const token = await this.oauthFacade.getAccessToken(userId, providerId);
        if (!token) {
            throw new BadRequestException(`No valid token for provider ${providerId}`);
        }
        return this.oauthFacade.getAuthenticatedUser(providerId, token);
    }

    async hasValidCredentials(userId: string, providerId: string): Promise<boolean> {
        return this.oauthFacade.hasValidCredentials(userId, providerId);
    }

    async getOAuthUrl({
        userId,
        providerId,
        redirectUri,
        state,
        forceConsent,
    }: {
        userId: string;
        providerId: string;
        redirectUri: string;
        state?: string;
        forceConsent?: boolean;
    }): Promise<{ url: string; state: string }> {
        void userId;
        const finalState = state || randomBytes(16).toString('hex');

        const config = await this.getOAuthConfig(providerId, redirectUri);
        const url = this.oauthFacade.getAuthorizationUrl(providerId, finalState, {
            ...config,
            forceConsent,
        });

        return { url, state: finalState };
    }

    async handleOAuthCallback(
        userId: string,
        providerId: string,
        code: string,
        state?: string,
    ): Promise<OAuthConnectionInfo> {
        void userId;
        void state;

        const config = await this.getOAuthConfig(providerId);
        const token = await this.oauthFacade.exchangeCodeForToken(providerId, code, config);
        const user = await this.oauthFacade.getAuthenticatedUser(providerId, token.accessToken);

        let expiresAt: Date | undefined;
        if (token.expiresIn) {
            expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + token.expiresIn);
        }

        await this.authAccountRepository.upsertProviderAccount({
            userId,
            providerId: buildPluginProviderId(providerId),
            accountId: user.id,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            tokenType: token.tokenType,
            scope: token.scope,
            accessTokenExpiresAt: expiresAt,
            email: user.email || null,
            username: user.username,
            metadata: {
                oauthUserId: user.id,
                name: user.name,
                avatarUrl: user.avatarUrl,
            },
        });

        const providerInfo = this.oauthFacade
            .getAvailableProviders()
            .find((p) => p.id === providerId);

        return {
            id: providerId,
            name: providerInfo?.name || providerId,
            enabled: providerInfo?.enabled ?? true,
            connected: true,
            username: user.username,
            email: user.email,
            avatarUrl: user.avatarUrl,
            connectionSource: 'plugin',
        };
    }

    async disconnectProvider(userId: string, providerId: string): Promise<void> {
        await this.oauthFacade.revokeToken(userId, providerId);
    }

    /**
     * Variant of {@link getOAuthUrl} that requests the GitHub `read:packages`
     * and `write:packages` scopes regardless of the plugin's configured
     * scopes. Used by the "Authorize with GitHub" button on the GitHub
     * plugin's `readPackagesPat` field — the resulting token is stored in
     * plugin settings instead of replacing the user's main OAuth connection.
     *
     * The exact same `oauthFacade.getAuthorizationUrl()` path is used; only
     * the `scopes` slice of the config is overridden, so providers that
     * ignore `scopes` (non-OAuth-with-scopes flows) keep behaving as before.
     */
    async getReadPackagesOAuthUrl({
        userId,
        providerId,
        redirectUri,
        state,
        forceConsent,
    }: {
        userId: string;
        providerId: string;
        redirectUri: string;
        state?: string;
        forceConsent?: boolean;
    }): Promise<{ url: string; state: string }> {
        void userId;
        const finalState = state || randomBytes(16).toString('hex');

        const config = await this.getOAuthConfig(providerId, redirectUri);
        const url = this.oauthFacade.getAuthorizationUrl(providerId, finalState, {
            ...config,
            scopes: ['read:packages', 'write:packages'],
            forceConsent,
        });

        return { url, state: finalState };
    }

    /**
     * Callback handler for the read-packages OAuth flow. Exchanges the code
     * for a token (using the SAME GitHub OAuth app credentials as the main
     * flow) and writes the resulting access token to the user's GitHub
     * plugin settings under `readPackagesPat` — the same field a user can
     * fill manually with a fine-grained PAT.
     *
     * Critically, this does NOT touch `authAccountRepository`. The main
     * GitHub OAuth connection (used for git operations, repo OAuth scopes)
     * is left untouched; the two tokens live independently.
     */
    async handleReadPackagesOAuthCallback(
        userId: string,
        providerId: string,
        code: string,
        state?: string,
    ): Promise<{ providerId: string; connected: true }> {
        void state;

        const config = await this.getOAuthConfig(providerId);
        const token = await this.oauthFacade.exchangeCodeForToken(providerId, code, config);
        let readPackagesPatOwner: string | undefined;

        try {
            const user = await this.oauthFacade.getAuthenticatedUser(providerId, token.accessToken);
            readPackagesPatOwner = user.username;
        } catch (error) {
            this.logger.warn(
                `Stored read-packages token for user ${userId} on plugin ${providerId}, but failed to resolve token owner:`,
                error,
            );
        }

        await this.pluginSettingsService.updateUserSettings(
            providerId,
            userId,
            {
                readPackagesPat: token.accessToken,
                ...(readPackagesPatOwner ? { readPackagesPatOwner } : {}),
            },
            { secretKeys: ['readPackagesPat'] },
        );

        this.logger.log(
            `Stored read-packages OAuth token for user ${userId} on plugin ${providerId}`,
        );

        return { providerId, connected: true };
    }

    private async getOAuthConfig(
        providerId: string,
        redirectUri?: string,
    ): Promise<Partial<OAuthConfig>> {
        const settings = await this.pluginSettingsService.getSettings(providerId, {
            includeSecrets: true,
        });

        const clientId = settings?.clientId as string | undefined;
        const clientSecret = settings?.clientSecret as string | undefined;

        if (!clientId || !clientSecret) {
            throw new BadRequestException(
                `OAuth credentials not configured for provider: ${providerId}`,
            );
        }

        return {
            clientId,
            clientSecret,
            redirectUri,
            scopes: settings?.scopes as readonly string[] | undefined,
        };
    }
}
