import 'server-only';
import { serverFetch } from '../server-api';
import type { OAuthUser } from '@ever-works/plugin';

export type { OAuthUser };

export interface OAuthProviderInfo {
    id: string;
    name: string;
    enabled: boolean;
}

export interface OAuthConnectionInfo extends OAuthProviderInfo {
    connected: boolean;
    username?: string;
    email?: string;
    avatarUrl?: string;
    connectionSource?: 'plugin' | 'social';
}

export const oauthAPI = {
    list: async () => {
        return serverFetch<{
            configured: boolean;
            providers: OAuthProviderInfo[];
        }>('/oauth/providers');
    },

    checkConnection: async (providerId: string) => {
        return serverFetch<OAuthConnectionInfo>(`/oauth/${providerId}/connection`);
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
        }>(`/oauth/${providerId}/connect/url${query}`);
    },

    connectCallback: async (providerId: string, code: string, state?: string) => {
        const params = new URLSearchParams({ code });
        if (state) params.append('state', state);
        return serverFetch<OAuthConnectionInfo>(
            `/oauth/${providerId}/callback/plugins?${params.toString()}`,
        );
    },

    getUser: async (providerId: string) => {
        return serverFetch<{
            success: boolean;
            user: OAuthUser | null;
            error?: string;
        }>(`/oauth/${providerId}/user`);
    },

    disconnect: async (providerId: string) => {
        return serverFetch<void>(`/oauth/${providerId}`, { method: 'DELETE' });
    },
};
