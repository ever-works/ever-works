'use server';

import { gitProvidersAPI } from '@/lib/api';
import { setOAuthStateCookie } from '@/lib/auth';
import { ROUTES, routeWithParams, withAppUrl } from '@/lib/constants';
import { generateHexToken } from '@/lib/utils/random';

export async function checkGitProviderConnection(providerId: string) {
    try {
        if (!providerId) {
            return {
                success: false,
                connected: false,
                error: 'Git provider ID is required',
            };
        }

        const result = await gitProvidersAPI.checkConnection(providerId);
        return {
            success: true,
            ...result,
        };
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
            return {
                success: false,
                organizations: [],
                error: 'Git provider ID is required',
            };
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

export async function connectGitProvider(
    providerId: string,
    returnPath?: string,
    forceConsent?: boolean,
) {
    try {
        if (!providerId) {
            return {
                success: false,
                error: 'Git provider ID is required',
            };
        }

        const state = generateHexToken(16);
        await setOAuthStateCookie(state);

        const params = new URLSearchParams();
        if (returnPath) {
            params.append('returnPath', returnPath);
        }

        const callbackPath = routeWithParams(ROUTES.API_GIT_PROVIDER_CALLBACK, {
            providerId: providerId,
        });
        const queryString = params.toString();
        const callbackUrl = withAppUrl(callbackPath) + (queryString ? `?${queryString}` : '');

        const response = await gitProvidersAPI.getConnectUrl(
            providerId,
            callbackUrl,
            state,
            forceConsent,
        );

        return {
            success: true,
            url: response.url,
            state: response.state,
        };
    } catch (error) {
        console.error('Failed to get git provider connect URL:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to connect git provider',
        };
    }
}

export async function disconnectGitProvider(providerId: string) {
    try {
        if (!providerId) {
            return {
                success: false,
                error: 'Git provider ID is required',
            };
        }

        await gitProvidersAPI.disconnect(providerId);
        return {
            success: true,
            message: 'Git provider disconnected successfully',
        };
    } catch (error) {
        console.error('Failed to disconnect git provider:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to disconnect git provider',
        };
    }
}
