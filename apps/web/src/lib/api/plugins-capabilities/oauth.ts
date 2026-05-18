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

    /**
     * Get the OAuth authorization URL for a plugin/git-provider connection.
     * The API mints the CSRF `state` nonce server-side and returns it in
     * the response. Callers MUST mirror that state into their own
     * host-scoped `oauth_state` cookie and validate it on the OAuth
     * callback. See C-03 in `docs/specs/security/THREAT-MODEL.md`.
     */
    getConnectUrl: async (providerId: string, callbackUrl?: string, forceConsent?: boolean) => {
        const params = new URLSearchParams();
        if (callbackUrl) params.append('callbackUrl', callbackUrl);
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

    /**
     * Get OAuth authorization URL for the GitHub read-packages flow. The
     * resulting token is stored in plugin settings under `readPackagesPat`
     * instead of replacing the main OAuth connection. Same C-03 contract
     * as {@link getConnectUrl} — state is server-minted and returned.
     */
    getReadPackagesConnectUrl: async (
        providerId: string,
        callbackUrl?: string,
        forceConsent?: boolean,
    ) => {
        const params = new URLSearchParams();
        if (callbackUrl) params.append('callbackUrl', callbackUrl);
        if (forceConsent) params.append('forceConsent', 'true');
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<{
            url: string;
            state: string;
        }>(`/oauth/${providerId}/read-packages/connect/url${query}`);
    },

    /** Callback for the read-packages OAuth flow (server-side, no UI). */
    readPackagesCallback: async (providerId: string, code: string, state?: string) => {
        const params = new URLSearchParams({ code });
        if (state) params.append('state', state);
        return serverFetch<{ providerId: string; connected: true }>(
            `/oauth/${providerId}/callback/plugins/read-packages?${params.toString()}`,
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
