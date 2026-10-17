import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { OAuthFacadeService } from '@ever-works/agent/facades';
import {
    AuthAccountRepository,
    PLUGIN_PROVIDER_PREFIX,
    buildPluginProviderId,
} from '@ever-works/agent/database';
import { PluginSettingsService } from '@ever-works/agent/plugins';
import { config as agentConfig } from '@ever-works/agent/config';
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
        const url = await this.oauthFacade.getAuthorizationUrl(providerId, finalState, {
            ...config,
            scopes: withAppWorksScopes(providerId, config.scopes),
            forceConsent,
        });

        return { url, state: finalState };
    }

    /**
     * EW-722 #20: the OAuth `state` CSRF check happens in the controller
     * (`OAuthStateService.verify` against the `ew_oauth_state` cookie)
     * BEFORE this method runs — it deliberately takes no `state` param so
     * a future caller can't bypass verification by invoking it directly
     * with an attacker-supplied state.
     */
    async handleOAuthCallback(
        userId: string,
        providerId: string,
        code: string,
    ): Promise<OAuthConnectionInfo> {
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
        const url = await this.oauthFacade.getAuthorizationUrl(providerId, finalState, {
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
     *
     * EW-722 #20: like {@link handleOAuthCallback}, the `state` CSRF check
     * happens in the controller before this method runs.
     */
    async handleReadPackagesOAuthCallback(
        userId: string,
        providerId: string,
        code: string,
    ): Promise<{ providerId: string; connected: true }> {
        const config = await this.getOAuthConfig(providerId);
        const token = await this.oauthFacade.exchangeCodeForToken(providerId, code, config);
        let readPackagesPatOwner = '';

        try {
            const user = await this.oauthFacade.getAuthenticatedUser(providerId, token.accessToken);
            readPackagesPatOwner = user.username;
        } catch (error) {
            this.logger.warn(
                `Exchanged read-packages token for user ${userId} on plugin ${providerId}, but failed to resolve token owner:`,
                error,
            );
        }

        await this.pluginSettingsService.updateUserSettings(
            providerId,
            userId,
            { readPackagesPat: token.accessToken, readPackagesPatOwner },
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

/**
 * The GitHub scopes App Works cannot build without (2026-10-17, lane aw-builds-2).
 *
 * An App Work's Build commits `.github/workflows/ever-works-build.yml` into the
 * member's repository, and GitHub only lets an OAuth token write that directory
 * with the `workflow` scope (APW-02 plan §4's permission matrix). The GitHub
 * plugin's default scope list already carries it (`GITHUB_FULL_SCOPES`); this
 * covers an operator-configured `scopes` setting that does not, while App Works
 * is switched on. Additive only: a configured scope is never removed, and with no
 * configured list the plugin's own default applies unchanged.
 */
export const APP_WORKS_REQUIRED_GITHUB_SCOPES = ['repo', 'workflow'] as const;

export function withAppWorksScopes(
    providerId: string,
    scopes: readonly string[] | undefined,
): readonly string[] | undefined {
    if (providerId !== 'github' || !scopes || scopes.length === 0) return scopes;
    let enabled = false;
    try {
        enabled = agentConfig.everWorks.apps.worksEnabled();
    } catch {
        enabled = false;
    }
    if (!enabled) return scopes;
    const missing = APP_WORKS_REQUIRED_GITHUB_SCOPES.filter((scope) => !scopes.includes(scope));
    return missing.length === 0 ? scopes : [...scopes, ...missing];
}
