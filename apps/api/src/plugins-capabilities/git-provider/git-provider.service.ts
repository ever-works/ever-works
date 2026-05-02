import { Injectable, Logger } from '@nestjs/common';
import { GitFacadeService, GitProviderInfo } from '@ever-works/agent/facades';
import { AuthAccountRepository } from '@ever-works/agent/database';
import type { GitOrganization, GitUser, GitRepositoryWithPermissions } from '@ever-works/plugin';

export type GitAuthMethod = 'oauth' | 'personal-access-token';

export interface GitProviderConnectionInfo extends GitProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    authMethod?: GitAuthMethod;
}

@Injectable()
export class GitProviderService {
    private readonly logger = new Logger(GitProviderService.name);

    constructor(
        private readonly gitFacade: GitFacadeService,
        private readonly authAccountRepository: AuthAccountRepository,
    ) {}

    isConfigured(): boolean {
        return this.gitFacade.isConfigured();
    }

    getAvailableProviders(): GitProviderInfo[] {
        return this.gitFacade.getAvailableProviders();
    }

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

        const oauthAccount = await this.authAccountRepository.findConnectedProviderAccount(
            userId,
            providerId,
            { usePluginProviderId: true },
        );

        // Check for PAT credentials via GitFacade (which checks plugin settings)
        const hasAnyCredentials =
            !!oauthAccount || (await this.gitFacade.hasValidCredentials({ userId, providerId }));

        if (!hasAnyCredentials) {
            return { ...provider, connected: false };
        }

        try {
            const user = await this.gitFacade.getUser(
                oauthAccount?.accessToken
                    ? { providerId, token: oauthAccount.accessToken }
                    : { userId, providerId },
            );
            return {
                ...provider,
                connected: true,
                username: user.login,
                email: user.email,
                avatarUrl: user.avatarUrl,
                authMethod: oauthAccount ? 'oauth' : 'personal-access-token',
            };
        } catch (error) {
            this.logger.warn(`Failed to get user info for provider ${providerId}:`, error);
            return { ...provider, connected: false };
        }
    }

    async getUser(userId: string, providerId: string): Promise<GitUser> {
        return this.gitFacade.getUser({ userId, providerId });
    }

    async getOrganizations(userId: string, providerId: string): Promise<GitOrganization[]> {
        return this.gitFacade.getOrganizations({ userId, providerId });
    }

    async getRepositories(
        userId: string,
        providerId: string,
        page?: number,
        perPage?: number,
    ): Promise<GitRepositoryWithPermissions[]> {
        return this.gitFacade.listRepositories({ userId, providerId }, page, perPage);
    }

    async hasValidCredentials(userId: string, providerId: string): Promise<boolean> {
        // Check both OAuth and PAT credentials via GitFacade
        return this.gitFacade.hasValidCredentials({ userId, providerId });
    }
}
