import { Injectable, Logger } from '@nestjs/common';
import { OAuthTokenRepository } from '@packages/agent/database';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { config } from '../../config/constants';

@Injectable()
export class OAuthTokenService {
    private readonly logger = new Logger(OAuthTokenService.name);

    constructor(
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly httpService: HttpService,
    ) {}

    /**
     * Get valid OAuth token for a user and provider
     * Automatically refreshes if expired (when refresh token available)
     */
    async getValidToken(userId: string, provider: string): Promise<string | null> {
        const tokenData = await this.oauthTokenRepository.findByUserAndProvider(userId, provider);

        if (!tokenData) {
            return null;
        }

        // Check if token is expired
        if (await this.oauthTokenRepository.isTokenExpired(tokenData)) {
            this.logger.debug(`OAuth token expired for user ${userId}, provider ${provider}`);

            // Try to refresh if we have a refresh token
            if (tokenData.refreshToken && provider === 'google') {
                return await this.refreshGoogleToken(userId, tokenData.refreshToken);
            }

            // GitHub tokens don't expire by default
            // For other providers, return null if expired without refresh capability
            return null;
        }

        return tokenData.accessToken;
    }

    /**
     * Refresh Google OAuth token
     */
    private async refreshGoogleToken(userId: string, refreshToken: string): Promise<string | null> {
        try {
            const response = await firstValueFrom(
                this.httpService.post('https://oauth2.googleapis.com/token', {
                    client_id: config.google.clientId(),
                    client_secret: config.google.clientSecret(),
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                }),
            );

            const { access_token, expires_in, token_type } = response.data;

            const expiresAt = new Date();
            expiresAt.setSeconds(expiresAt.getSeconds() + expires_in);

            // Update stored token
            await this.oauthTokenRepository.upsert({
                userId,
                provider: 'google',
                accessToken: access_token,
                refreshToken: refreshToken, // Keep the same refresh token
                tokenType: token_type,
                expiresAt,
            });

            return access_token;
        } catch (error) {
            this.logger.error('Failed to refresh Google token', error);
            return null;
        }
    }

    /**
     * Get user's GitHub access token
     */
    async getGitHubToken(userId: string): Promise<string | null> {
        return await this.getValidToken(userId, 'github');
    }

    /**
     * Get user's Google access token
     */
    async getGoogleToken(userId: string): Promise<string | null> {
        return await this.getValidToken(userId, 'google');
    }

    /**
     * Revoke OAuth tokens for a user and provider
     */
    async revokeTokens(userId: string, provider: string): Promise<void> {
        const tokenData = await this.oauthTokenRepository.findByUserAndProvider(userId, provider);

        if (!tokenData) {
            return;
        }

        // Provider-specific revocation
        try {
            if (provider === 'google') {
                await this.revokeGoogleToken(tokenData.accessToken);
            } else if (provider === 'github') {
                await this.revokeGitHubToken(tokenData.accessToken);
            }
        } catch (error) {
            this.logger.error(`Failed to revoke ${provider} token`, error);
        }

        // Remove from database
        await this.oauthTokenRepository.deleteByUserAndProvider(userId, provider);
    }

    private async revokeGoogleToken(accessToken: string): Promise<void> {
        await firstValueFrom(
            this.httpService.post(`https://oauth2.googleapis.com/revoke?token=${accessToken}`),
        );
    }

    private async revokeGitHubToken(accessToken: string): Promise<void> {
        const clientId = config.github.clientId();
        const clientSecret = config.github.clientSecret();

        await firstValueFrom(
            this.httpService.delete(`https://api.github.com/applications/${clientId}/token`, {
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString(
                        'base64',
                    )}`,
                },
                data: {
                    access_token: accessToken,
                },
            }),
        );
    }
}
