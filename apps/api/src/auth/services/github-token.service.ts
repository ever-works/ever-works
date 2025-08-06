import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuthTokenService } from './oauth-token.service';
import { OAuthConnectionService } from './oauth-connection.service';
import { AuthProviders } from '../../config/constants';
import { GitHubScopePresets } from '../config/github-scopes.config';

/**
 * Service to ensure GitHub token access with proper permissions
 * This maybe used by the agent package to get tokens for GitHub operations
 */
@Injectable()
export class GitHubTokenService {
    constructor(
        private readonly oauthTokenService: OAuthTokenService,
        private readonly oauthConnectionService: OAuthConnectionService,
    ) {}

    /**
     * Get GitHub token with all agent permissions
     * Throws error if not connected or missing scopes
     */
    async getTokenForAgent(userId: string): Promise<string> {
        // Check if GitHub is connected with proper scopes
        const scopeCheck = await this.oauthConnectionService.checkGitHubScopes(userId);

        if (!scopeCheck.hasAgentScopes) {
            const authUrl = await this.oauthConnectionService.getConnectionUrl(
                userId,
                AuthProviders.GITHUB,
            );

            throw new UnauthorizedException({
                error: 'insufficient_github_permissions',
                message: 'GitHub account needs additional permissions for agent operations',
                currentScopes: scopeCheck.currentScopes,
                missingScopes: scopeCheck.missingScopes,
                authUrl,
            });
        }

        const token = await this.oauthTokenService.getGitHubToken(userId);
        if (!token) {
            throw new UnauthorizedException('GitHub token not found');
        }

        return token;
    }

    /**
     * Check if user has specific GitHub scopes
     */
    async hasScopes(userId: string, requiredScopes: string[]): Promise<boolean> {
        const scopeCheck = await this.oauthConnectionService.checkGitHubScopes(
            userId,
            requiredScopes,
        );
        return scopeCheck.hasScopes;
    }

    /**
     * Get current GitHub connection info
     */
    async getConnectionInfo(userId: string) {
        const connection = await this.oauthConnectionService.checkConnection(
            userId,
            AuthProviders.GITHUB,
        );

        return {
            connected: connection.connected,
            scopes: connection.scopes || [],
            hasAgentScopes:
                connection.connected && (await this.hasScopes(userId, GitHubScopePresets.AGENT)),
            metadata: connection.metadata,
        };
    }
}
