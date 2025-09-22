'use server';

import { authAPI } from '@/lib/api';
import { setOAuthStateCookie } from '@/lib/auth';
import { ROUTES, routeWithParams, withAppUrl } from '@/lib/constants';
import { generateHexToken } from '@/lib/utils/random';

export async function checkGitHubConnection() {
    try {
        return await authAPI.oauth_connections.checkConnection('github');
    } catch (error) {
        console.error('Failed to check GitHub connection:', error);
        return {
            success: false,
            connected: false,
            error: error instanceof Error ? error.message : 'Failed to check connection',
        };
    }
}

export async function checkOAuthConnection(provider: string) {
    try {
        return await authAPI.oauth_connections.checkConnection(provider);
    } catch (error) {
        console.error(`Failed to check ${provider} connection:`, error);

        return {
            success: false,
            connected: false,
            error:
                error instanceof Error ? error.message : `Failed to check ${provider} connection`,
        };
    }
}

export async function connectGitHub(returnPath?: string) {
    try {
        // Generate state for OAuth
        const state = generateHexToken(16);
        await setOAuthStateCookie(state);

        const params = new URLSearchParams({ process: 'connect' });
        if (returnPath) {
            params.append('returnPath', returnPath);
        }

        // Set callback URL with return path
        const callbackPath = routeWithParams(ROUTES.API_AUTH_CALLBACK, { provider: 'github' });

        const response = await authAPI.oauth_connections.getConnectUrl(
            'github',
            withAppUrl(callbackPath) + `?${params.toString()}`,
            state,
        );

        return {
            success: true,
            url: response.url,
            state: response.state,
        };
    } catch (error) {
        console.error('Failed to get GitHub connect URL:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to connect GitHub',
        };
    }
}

export async function disconnectGitHub() {
    try {
        await authAPI.oauth_connections.disconnect('github');
        return {
            success: true,
            message: 'GitHub account disconnected successfully',
        };
    } catch (error) {
        console.error('Failed to disconnect GitHub:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to disconnect GitHub',
        };
    }
}
