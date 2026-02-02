import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { GitFacadeService, GitProviderInfo } from '@packages/agent/facades';
import { OAuthTokenRepository } from '@packages/agent/database';
import { PluginSettingsService } from '@packages/agent/plugins';
import type {
    GitOrganization,
    GitUser,
    GitRepositoryWithPermissions,
    OAuthConfig,
} from '@ever-works/plugin';

export interface GitProviderConnectionInfo extends GitProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
}

/**
 * Service providing git provider operations through the plugin system.
 * Acts as an abstraction layer between the API and the GitFacade.
 */
@Injectable()
export class GitProviderService {
    private readonly logger = new Logger(GitProviderService.name);
    private stateStore = new Map<string, { userId: string; expires: Date }>();

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly pluginSettingsService: PluginSettingsService,
    ) {}

    /**
     * Check if any git provider is configured and available
     */
    isConfigured(): boolean {
        return this.gitFacade.isConfigured();
    }

    /**
     * Get list of available git providers
     */
    getAvailableProviders(): GitProviderInfo[] {
        return this.gitFacade.getAvailableProviders();
    }

    /**
     * Check connection status for a specific provider
     */
    async checkConnection(userId: string, providerId: string): Promise<GitProviderConnectionInfo> {
        const provider = this.gitFacade.getAvailableProviders().find((p) => p.id === providerId);

        if (!provider) {
            return {
                id: providerId,
                name: 'Unknown',
                enabled: false,
                connected: false,
            };
        }

        const hasCredentials = await this.gitFacade.hasValidCredentials({
            userId,
            providerId: provider.id,
        });

        if (!hasCredentials) {
            return {
                ...provider,
                connected: false,
            };
        }

        try {
            const user = await this.gitFacade.getUser({
                userId,
                providerId: provider.id,
            });

            return {
                ...provider,
                connected: true,
                username: user.login,
                email: user.email,
                avatarUrl: user.avatarUrl,
            };
        } catch (error) {
            this.logger.warn(`Failed to get user info for provider ${provider.id}:`, error);
            return {
                ...provider,
                connected: false,
            };
        }
    }

    /**
     * Get user information from the git provider
     */
    async getUser(userId: string, providerId: string): Promise<GitUser> {
        return this.gitFacade.getUser({
            userId,
            providerId,
        });
    }

    /**
     * Get organizations accessible by the user
     */
    async getOrganizations(userId: string, providerId: string): Promise<GitOrganization[]> {
        return this.gitFacade.getOrganizations({
            userId,
            providerId,
        });
    }

    /**
     * Get repositories accessible by the user
     */
    async getRepositories(
        userId: string,
        providerId: string,
        page?: number,
        perPage?: number,
    ): Promise<GitRepositoryWithPermissions[]> {
        return this.gitFacade.listRepositories(
            {
                userId,
                providerId,
            },
            page,
            perPage,
        );
    }

    /**
     * Check if user has valid credentials for a provider
     */
    async hasValidCredentials(userId: string, providerId: string): Promise<boolean> {
        return this.gitFacade.hasValidCredentials({
            userId,
            providerId,
        });
    }

    // OAuth methods

    async getOAuthUrl(
        userId: string,
        providerId: string,
        redirectUri: string,
        state?: string,
    ): Promise<{ url: string; state: string }> {
        const finalState = state || this.generateState(userId);
        this.storeState(finalState, userId);

        // Get OAuth config from plugin settings and environment
        const config = await this.getOAuthConfig(providerId, redirectUri);

        const url = this.gitFacade.getOAuthUrl(providerId, finalState, config);
        return { url, state: finalState };
    }

    async handleOAuthCallback(
        userId: string,
        providerId: string,
        code: string,
        state?: string,
    ): Promise<GitProviderConnectionInfo> {
        // Verify state if provided
        if (state && !this.verifyState(state, userId)) {
            throw new BadRequestException('Invalid state parameter');
        }

        // Get OAuth config
        const config = await this.getOAuthConfig(providerId);

        // Exchange code for token via the plugin
        const token = await this.gitFacade.exchangeCodeForToken(providerId, code, config);

        // Get user info via the plugin
        const user = await this.gitFacade.getOAuthUser(providerId, token.accessToken);

        // Calculate expiration time if provided
        let expiresAt: Date | undefined;
        if (token.expiresIn) {
            expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + token.expiresIn);
        }

        // Store token in database
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

        const providerInfo = this.gitFacade
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
        await this.oauthTokenRepository.deleteByUserAndProvider(userId, providerId);
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
