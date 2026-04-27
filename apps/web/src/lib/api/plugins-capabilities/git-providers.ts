import 'server-only';
import { serverFetch } from '../server-api';
import type {
    GitUser,
    GitOrganization,
    GitRepositoryWithPermissions,
    PluginIcon,
} from '@ever-works/plugin';

export type { GitUser, GitOrganization, GitRepositoryWithPermissions, PluginIcon };

export interface GitProviderInfo {
    id: string;
    name: string;
    enabled: boolean;
    icon?: PluginIcon;
    description?: string;
    homepage?: string;
}

export interface GitProviderConnectionInfo extends GitProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    authMethod?: 'oauth' | 'personal-access-token';
}

export const gitProvidersAPI = {
    list: async () => {
        return serverFetch<{
            configured: boolean;
            providers: GitProviderInfo[];
        }>('/git-providers');
    },

    checkConnection: async (providerId: string) => {
        return serverFetch<GitProviderConnectionInfo>(`/git-providers/${providerId}/connection`);
    },

    getOrganizations: async (providerId: string) => {
        return serverFetch<{
            success: boolean;
            organizations: GitOrganization[];
            error?: string;
        }>(`/git-providers/${providerId}/organizations`);
    },

    getRepositories: async (providerId: string, page?: number, perPage?: number) => {
        const params = new URLSearchParams();
        if (page) params.append('page', page.toString());
        if (perPage) params.append('perPage', perPage.toString());
        const query = params.toString() ? `?${params.toString()}` : '';

        return serverFetch<{
            success: boolean;
            repositories: GitRepositoryWithPermissions[];
            error?: string;
        }>(`/git-providers/${providerId}/repositories${query}`);
    },

    getUser: async (providerId: string) => {
        return serverFetch<{
            success: boolean;
            user: GitUser | null;
            error?: string;
        }>(`/git-providers/${providerId}/user`);
    },
};
