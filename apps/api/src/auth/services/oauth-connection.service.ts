import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { OAuthTokenRepository } from '@packages/agent/database';
import { OAuthTokenService } from './oauth-token.service';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { AuthProviders, config } from '../../config/constants';
import { GitHubScopePresets, hasRequiredAgentScopes } from '../config/github-scopes.config';

interface ConnectionInfo {
    provider: string;
    connected: boolean;
    scopes?: string[];
    connectedAt?: Date;
    metadata?: Record<string, any>;
}

interface GitHubRepository {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    permissions: {
        admin: boolean;
        push: boolean;
        pull: boolean;
    };
}

/**
 * Service to manage OAuth connections for users
 * Handles connection, disconnection, and scope management
 */
@Injectable()
export class OAuthConnectionService {
    private readonly logger = new Logger(OAuthConnectionService.name);
    private stateStore = new Map<string, { userId: string; expires: Date }>();

    constructor(
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly oauthTokenService: OAuthTokenService,
        private readonly httpService: HttpService,
    ) {}

    /**
     * Get all OAuth connections for a user
     */
    async getUserConnections(userId: string): Promise<ConnectionInfo[]> {
        const tokens = await this.oauthTokenRepository.findByUserId(userId);

        const connections: ConnectionInfo[] = [
            {
                provider: AuthProviders.GITHUB,
                connected: false,
            },
            {
                provider: AuthProviders.GOOGLE,
                connected: false,
            },
        ];

        for (const token of tokens) {
            const connection = connections.find((c) => c.provider === token.provider);
            if (connection) {
                connection.connected = true;
                connection.scopes = token.scope?.split(' ') || [];
                connection.connectedAt = token.createdAt;
                connection.metadata = token.metadata;
            }
        }

        return connections;
    }

    /**
     * Check if a specific provider is connected
     */
    async checkConnection(userId: string, provider: string): Promise<ConnectionInfo> {
        const token = await this.oauthTokenRepository.findByUserAndProvider(userId, provider);

        return {
            provider,
            connected: !!token,
            scopes: token?.scope?.split(' ') || [],
            connectedAt: token?.createdAt,
            metadata: token?.metadata,
        };
    }

    /**
     * Generate OAuth authorization URL for connecting a provider
     */
    async getConnectionUrl(
        userId: string,
        provider: string,
        additionalScopes?: string[],
    ): Promise<string> {
        const state = this.generateState(userId);

        switch (provider) {
            case AuthProviders.GITHUB:
                return this.getGitHubAuthUrl(state, additionalScopes);
            case AuthProviders.GOOGLE:
                return this.getGoogleAuthUrl(state, additionalScopes);
            default:
                throw new BadRequestException(`Unsupported provider: ${provider}`);
        }
    }

    private getGitHubAuthUrl(state: string, additionalScopes?: string[]): string {
        // Use comprehensive agent scopes by default
        const scopes =
            additionalScopes && additionalScopes.length > 0
                ? additionalScopes
                : GitHubScopePresets.AGENT;

        const params = new URLSearchParams({
            client_id: config.github.clientId(),
            redirect_uri: config.github.connectCallbackUrl(),
            scope: scopes.join(' '),
            state,
        });

        return `https://github.com/login/oauth/authorize?${params}`;
    }

    private getGoogleAuthUrl(state: string, additionalScopes?: string[]): string {
        const baseScopes = ['email', 'profile'];
        const scopes = [...baseScopes, ...(additionalScopes || [])];

        const params = new URLSearchParams({
            client_id: config.google.clientId()!,
            redirect_uri: config.google.callbackUrl(),
            response_type: 'code',
            scope: scopes.join(' '),
            state,
            access_type: 'offline',
            prompt: 'consent', // Force consent to get refresh token
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }

    /**
     * Handle OAuth callback for connecting a provider
     */
    async handleConnectionCallback(
        userId: string,
        provider: string,
        code: string,
    ): Promise<ConnectionInfo> {
        switch (provider) {
            case AuthProviders.GITHUB:
                return this.handleGitHubCallback(userId, code);
            case AuthProviders.GOOGLE:
                return this.handleGoogleCallback(userId, code);
            default:
                throw new BadRequestException(`Unsupported provider: ${provider}`);
        }
    }

    private async handleGitHubCallback(userId: string, code: string): Promise<ConnectionInfo> {
        console.log('handleGitHubCallback');
        // Exchange code for token
        const tokenResponse = await firstValueFrom(
            this.httpService.post(
                'https://github.com/login/oauth/access_token',
                {
                    client_id: config.github.clientId(),
                    client_secret: config.github.clientSecret(),
                    code,
                },
                {
                    headers: {
                        Accept: 'application/json',
                    },
                },
            ),
        );

        const { access_token, scope, token_type } = tokenResponse.data;

        // Get user info
        const userResponse = await firstValueFrom(
            this.httpService.get('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                    Accept: 'application/vnd.github+json',
                },
            }),
        );

        // Store token
        await this.oauthTokenRepository.upsert({
            userId,
            provider: AuthProviders.GITHUB,
            accessToken: access_token,
            tokenType: token_type,
            scope,
            metadata: {
                login: userResponse.data.login,
                nodeId: userResponse.data.node_id,
                type: userResponse.data.type,
            },
        });

        return {
            provider: AuthProviders.GITHUB,
            connected: true,
            scopes: scope?.split(' ') || [],
            connectedAt: new Date(),
            metadata: {
                username: userResponse.data.login,
            },
        };
    }

    private async handleGoogleCallback(userId: string, code: string): Promise<ConnectionInfo> {
        // Exchange code for token
        const tokenResponse = await firstValueFrom(
            this.httpService.post('https://oauth2.googleapis.com/token', {
                code,
                client_id: config.google.clientId(),
                client_secret: config.google.clientSecret(),
                redirect_uri: config.google.callbackUrl(),
                grant_type: 'authorization_code',
            }),
        );

        const { access_token, refresh_token, expires_in, scope, token_type } = tokenResponse.data;

        const expiresAt = new Date();
        expiresAt.setSeconds(expiresAt.getSeconds() + expires_in);

        // Get user info
        const userResponse = await firstValueFrom(
            this.httpService.get('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: {
                    Authorization: `Bearer ${access_token}`,
                },
            }),
        );

        // Store token
        await this.oauthTokenRepository.upsert({
            userId,
            provider: AuthProviders.GOOGLE,
            accessToken: access_token,
            refreshToken: refresh_token,
            tokenType: token_type,
            scope,
            expiresAt,
            metadata: {
                sub: userResponse.data.id,
                email: userResponse.data.email,
                emailVerified: userResponse.data.verified_email,
            },
        });

        return {
            provider: AuthProviders.GOOGLE,
            connected: true,
            scopes: scope?.split(' ') || [],
            connectedAt: new Date(),
            metadata: {
                email: userResponse.data.email,
            },
        };
    }

    /**
     * Request additional scopes for an existing connection
     */
    async requestAdditionalScopes(
        userId: string,
        provider: string,
        scopes: string[],
    ): Promise<{ authUrl: string }> {
        const existingToken = await this.oauthTokenRepository.findByUserAndProvider(
            userId,
            provider,
        );

        if (!existingToken) {
            throw new BadRequestException(`${provider} is not connected`);
        }

        const existingScopes = existingToken.scope?.split(' ') || [];
        const newScopes = scopes.filter((s) => !existingScopes.includes(s));

        if (newScopes.length === 0) {
            throw new BadRequestException('All requested scopes are already granted');
        }

        const authUrl = await this.getConnectionUrl(userId, provider, [
            ...existingScopes,
            ...newScopes,
        ]);

        return { authUrl };
    }

    /**
     * Disconnect a provider
     */
    async disconnectProvider(userId: string, provider: string): Promise<void> {
        await this.oauthTokenService.revokeTokens(userId, provider);
    }

    /**
     * Get GitHub repositories with current permissions
     */
    async getGitHubRepositories(userId: string): Promise<GitHubRepository[]> {
        const token = await this.oauthTokenService.getGitHubToken(userId);

        if (!token) {
            throw new BadRequestException('GitHub is not connected');
        }

        try {
            const response = await firstValueFrom(
                this.httpService.get('https://api.github.com/user/repos', {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github+json',
                    },
                    params: {
                        per_page: 100,
                        sort: 'updated',
                    },
                }),
            );

            return response.data;
        } catch (error) {
            this.logger.error('Failed to fetch GitHub repositories', error);
            throw new BadRequestException('Failed to fetch repositories');
        }
    }

    /**
     * Check if user has required GitHub scopes
     */
    async checkGitHubScopes(
        userId: string,
        requiredScopes?: string[],
    ): Promise<{
        hasScopes: boolean;
        currentScopes: string[];
        missingScopes: string[];
        hasAgentScopes: boolean;
    }> {
        const connection = await this.checkConnection(userId, AuthProviders.GITHUB);

        if (!connection.connected) {
            const agentCheck = hasRequiredAgentScopes([]);
            return {
                hasScopes: false,
                currentScopes: [],
                missingScopes: requiredScopes || agentCheck.missing,
                hasAgentScopes: false,
            };
        }

        const currentScopes = connection.scopes || [];
        const agentCheck = hasRequiredAgentScopes(currentScopes);

        // If no specific scopes requested, check for agent scopes
        if (!requiredScopes || requiredScopes.length === 0) {
            return {
                hasScopes: agentCheck.hasAll,
                currentScopes,
                missingScopes: agentCheck.missing,
                hasAgentScopes: agentCheck.hasAll,
            };
        }

        const missingScopes = requiredScopes.filter((s) => !currentScopes.includes(s));

        return {
            hasScopes: missingScopes.length === 0,
            currentScopes,
            missingScopes,
            hasAgentScopes: agentCheck.hasAll,
        };
    }

    storeState(state: string, userId: string) {
        const expires = new Date();
        expires.setMinutes(expires.getMinutes() + 10); // 10 minute expiry

        this.stateStore.set(state, { userId, expires });
    }

    /**
     * Generate and store state for OAuth flow
     */
    generateState(userId: string): string {
        const state = randomBytes(16).toString('hex');
        const expires = new Date();
        expires.setMinutes(expires.getMinutes() + 10); // 10 minute expiry

        this.stateStore.set(state, { userId, expires });

        // Clean up expired states
        this.cleanupExpiredStates();

        return state;
    }

    /**
     * Verify state parameter
     */
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
