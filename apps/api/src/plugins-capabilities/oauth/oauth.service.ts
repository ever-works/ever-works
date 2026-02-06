import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { OAuthFacadeService } from '@packages/agent/facades';
import { OAuthTokenRepository } from '@packages/agent/database';
import { PluginSettingsService } from '@packages/agent/plugins';
import type { OAuthConfig, OAuthProviderInfo } from '@ever-works/plugin';

export interface OAuthConnectionInfo extends OAuthProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
}

@Injectable()
export class OAuthService {
    private readonly logger = new Logger(OAuthService.name);
    private stateStore = new Map<string, { userId: string; expires: Date }>();

    constructor(
        private readonly oauthFacade: OAuthFacadeService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
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

        const hasCredentials = await this.oauthFacade.hasValidCredentials(userId, providerId);

        if (!hasCredentials) {
            return { ...provider, connected: false };
        }

        try {
            const token = await this.oauthFacade.getAccessToken(userId, providerId);
            if (!token) {
                return { ...provider, connected: false };
            }

            const user = await this.oauthFacade.getAuthenticatedUser(providerId, token);
            return {
                ...provider,
                connected: true,
                username: user.username,
                email: user.email,
                avatarUrl: user.avatarUrl,
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
        const finalState = state || this.generateState(userId);
        this.storeState(finalState, userId);

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
        if (state && !this.verifyState(state, userId)) {
            throw new BadRequestException('Invalid state parameter');
        }

        const config = await this.getOAuthConfig(providerId);
        const token = await this.oauthFacade.exchangeCodeForToken(providerId, code, config);
        const user = await this.oauthFacade.getAuthenticatedUser(providerId, token.accessToken);

        let expiresAt: Date | undefined;
        if (token.expiresIn) {
            expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + token.expiresIn);
        }

        await this.oauthTokenRepository.upsert({
            userId,
            provider: providerId,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            tokenType: token.tokenType,
            scope: token.scope,
            expiresAt,
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
        };
    }

    async disconnectProvider(userId: string, providerId: string): Promise<void> {
        await this.oauthFacade.revokeToken(userId, providerId);
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

    generateState(userId: string): string {
        const state = randomBytes(16).toString('hex');
        this.storeState(state, userId);
        return state;
    }

    storeState(state: string, userId: string): void {
        const expires = new Date();
        expires.setMinutes(expires.getMinutes() + 10);
        this.stateStore.set(state, { userId, expires });
        this.cleanupExpiredStates();
    }

    verifyState(state: string, userId: string): boolean {
        const stored = this.stateStore.get(state);
        if (!stored || stored.userId !== userId || new Date() > stored.expires) {
            return false;
        }
        this.stateStore.delete(state);
        return true;
    }

    private cleanupExpiredStates(): void {
        const now = new Date();
        for (const [state, data] of this.stateStore.entries()) {
            if (now > data.expires) {
                this.stateStore.delete(state);
            }
        }
    }
}
