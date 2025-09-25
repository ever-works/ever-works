import { Injectable } from '@nestjs/common';
import { UserRepository } from './repositories/user.repository';
import { User } from '../entities/user.entity';
import { config } from '@src/config';

/**
 * Service to handle GitHub token retrieval for users
 * Ensures user has oauth tokens loaded before accessing
 */
@Injectable()
export class UserGitHubService {
    constructor(private readonly userRepository: UserRepository) {}

    /**
     * Get GitHub token for a user
     * Ensures oauth tokens are loaded and returns the token
     */
    async getGitToken(user: User): Promise<string | null> {
        // For mocked/system users, use environment variable
        if (user.local) {
            return config.github.getApiKey() || null;
        }

        // If oauth tokens aren't loaded, fetch the user with relations
        if (!user.oauthTokens) {
            const userWithTokens = await this.userRepository.findByIdWithTokens(user.id);
            if (!userWithTokens) {
                return null;
            }
            user = userWithTokens;
        }

        // Use the entity method which handles the logic
        return user.getGitToken();
    }

    /**
     * Check if user has GitHub connected with required scopes
     */
    async hasGitHubAccess(user: User, requiredScopes?: string[]): Promise<boolean> {
        if (user.local) {
            return !!config.github.getApiKey();
        }

        // Ensure oauth tokens are loaded
        if (!user.oauthTokens) {
            const userWithTokens = await this.userRepository.findByIdWithTokens(user.id);
            if (!userWithTokens) {
                return false;
            }
            user = userWithTokens;
        }

        const githubToken = user.oauthTokens.find((token) => token.provider === 'github');
        if (!githubToken) {
            return false;
        }

        // If no specific scopes required, just check if connected
        if (!requiredScopes || requiredScopes.length === 0) {
            return true;
        }

        // Check if token has all required scopes
        const tokenScopes = githubToken.scope?.split(' ') || [];
        return requiredScopes.every((scope) => tokenScopes.includes(scope));
    }

    /**
     * Get OAuth token metadata
     */
    async getGitHubTokenInfo(user: User) {
        if (user.local) {
            return {
                type: 'environment',
                scopes: ['all'], // Env token typically has full access
                username: config.github.getOwner(),
            };
        }

        // Ensure oauth tokens are loaded
        if (!user.oauthTokens) {
            const userWithTokens = await this.userRepository.findByIdWithTokens(user.id);
            if (!userWithTokens) {
                return null;
            }
            user = userWithTokens;
        }

        const githubToken = user.oauthTokens.find((token) => token.provider === 'github');
        if (!githubToken) {
            return null;
        }

        return {
            type: 'oauth',
            scopes: githubToken.scope?.split(' ') || [],
            username: githubToken.metadata?.login,
            expiresAt: githubToken.expiresAt,
        };
    }
}
