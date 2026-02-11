'use server';

import { oauthAPI, gitProvidersAPI } from '@/lib/api';
import { setOAuthStateCookie } from '@/lib/auth';
import { ROUTES, routeWithParams, withAppUrl } from '@/lib/constants';
import { generateHexToken } from '@/lib/utils/random';

export async function checkGitProviderConnection(providerId: string) {
    try {
        if (!providerId) {
            return { success: false, connected: false, error: 'Git provider ID is required' };
        }
        const result = await gitProvidersAPI.checkConnection(providerId);
        return { success: true, ...result };
    } catch (error) {
        console.error(`Failed to check git provider connection:`, error);
        return {
            success: false,
            connected: false,
            error: error instanceof Error ? error.message : 'Failed to check connection',
        };
    }
}

export async function getGitProviderOrganizations(providerId: string) {
    try {
        if (!providerId) {
            return { success: false, organizations: [], error: 'Git provider ID is required' };
        }
        return await gitProvidersAPI.getOrganizations(providerId);
    } catch (error) {
        console.error('Failed to fetch organizations:', error);
        return {
            success: false,
            organizations: [],
            error: error instanceof Error ? error.message : 'Failed to fetch organizations',
        };
    }
}

/**
 * Connect to an OAuth provider (used for git providers and any OAuth-capable plugin)
 */
export async function connectOAuthProvider(
    providerId: string,
    returnPath?: string,
    forceConsent?: boolean,
) {
    try {
        if (!providerId) {
            return { success: false, error: 'Provider ID is required' };
        }

        const state = generateHexToken(16);
        await setOAuthStateCookie(state);

        const params = new URLSearchParams();
        if (returnPath) {
            params.append('returnPath', returnPath);
        }

        const queryString = params.toString();
        const callbackPath = routeWithParams(ROUTES.API_OAUTH_PLUGINS_CALLBACK, { providerId });
        const callbackUrl = withAppUrl(callbackPath) + (queryString ? `?${queryString}` : '');

        const response = await oauthAPI.getConnectUrl(providerId, callbackUrl, state, forceConsent);

        return { success: true, url: response.url, state: response.state };
    } catch (error) {
        console.error('Failed to get OAuth connect URL:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to connect provider',
        };
    }
}

/**
 * @deprecated Use connectOAuthProvider instead
 */
export async function connectGitProvider(
    providerId: string,
    returnPath?: string,
    forceConsent?: boolean,
) {
    return connectOAuthProvider(providerId, returnPath, forceConsent);
}

export async function disconnectOAuthProvider(providerId: string) {
    try {
        if (!providerId) {
            return { success: false, error: 'Provider ID is required' };
        }
        await oauthAPI.disconnect(providerId);
        return { success: true, message: 'Provider disconnected successfully' };
    } catch (error) {
        console.error('Failed to disconnect OAuth provider:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to disconnect provider',
        };
    }
}

/**
 * @deprecated Use disconnectOAuthProvider instead
 */
export async function disconnectGitProvider(providerId: string) {
    return disconnectOAuthProvider(providerId);
}
