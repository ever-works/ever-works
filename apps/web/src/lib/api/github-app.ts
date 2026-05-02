import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export interface GitHubAppInstallationRepositoryDto {
    id: string;
    installationEntityId: string;
    githubRepoId: string;
    owner: string;
    repo: string;
    fullName: string;
    isPrivate: boolean;
    defaultBranch: string | null;
    selected: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface GitHubAppInstallationDto {
    id: string;
    installationId: string;
    appSlug: string | null;
    accountLogin: string;
    accountType: string;
    targetType: string;
    createdByUserId: string | null;
    createdByGithubUserId: string | null;
    suspendedAt: string | null;
    deletedAt: string | null;
    rawPayload?: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
    repositories: GitHubAppInstallationRepositoryDto[];
}

export interface GitHubAppOnboardRepositoryResponseDto {
    status: 'pending' | 'success' | 'error';
    workId?: string;
    historyId?: string;
    message: string;
}

export const githubAppAPI = {
    listInstallations: async () => {
        return serverFetch<GitHubAppInstallationDto[]>('/github-app/installations');
    },

    syncInstallation: async (installationId: string) => {
        return serverMutation<GitHubAppInstallationDto>({
            endpoint: `/github-app/installations/${installationId}/sync`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    onboardRepository: async (installationId: string, repositoryId: string) => {
        return serverMutation<GitHubAppOnboardRepositoryResponseDto>({
            endpoint: `/github-app/installations/${installationId}/repositories/${repositoryId}/onboard`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
