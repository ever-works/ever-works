import 'server-only';
import { serverFetch } from './server-api';
import type { GitUser, GitOrganization, GitRepositoryWithPermissions } from '@ever-works/plugin';

// Re-export plugin types for convenience
export type { GitUser, GitOrganization, GitRepositoryWithPermissions };

// API-specific types (responses from git-provider controller)
export interface GitProviderInfo {
    id: string;
    name: string;
    enabled: boolean;
}

export interface GitProviderConnectionInfo extends GitProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
}

export const gitProvidersAPI = {
    list: async () => {
        return serverFetch<{
            configured: boolean;
            providers: GitProviderInfo[];
        }>('/git-providers');
    },

    getDefault: async () => {
        return serverFetch<{
            configured: boolean;
            provider: GitProviderInfo | null;
        }>('/git-providers/default');
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

    getConnectUrl: async (
        providerId: string,
        callbackUrl?: string,
        state?: string,
        forceConsent?: boolean,
    ) => {
        const params = new URLSearchParams();
        if (callbackUrl) params.append('callbackUrl', callbackUrl);
        if (state) params.append('state', state);
        if (forceConsent) params.append('forceConsent', 'true');
        const query = params.toString() ? `?${params.toString()}` : '';

        return serverFetch<{
            url: string;
            state: string;
        }>(`/git-providers/${providerId}/connect/url${query}`);
    },

    disconnect: async (providerId: string) => {
        return serverFetch<void>(`/git-providers/${providerId}`, {
            method: 'DELETE',
        });
    },

    /**
     * Handle OAuth callback for a git provider
     * Called from the frontend callback route after OAuth redirect
     */
    connectCallback: async (providerId: string, code: string, state?: string) => {
        const params = new URLSearchParams({ code });
        if (state) params.append('state', state);

        return serverFetch<GitProviderConnectionInfo>(
            `/git-providers/${providerId}/callback?${params.toString()}`,
        );
    },
};
