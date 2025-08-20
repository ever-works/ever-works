'use server';

import { authAPI } from '@/lib/api';
import { setOAuthStateCookie } from '@/lib/auth';
import { withAppUrl } from '@/lib/constants';

export async function checkGitHubConnection() {
    try {
        const connection = await authAPI.oauth_connections.checkConnection('github');
        return {
            success: true,
            connected: connection.connected || false,
            scopes: connection.scopes,
        };
    } catch (error) {
        console.error('Failed to check GitHub connection:', error);
        return {
            success: false,
            connected: false,
            error: error instanceof Error ? error.message : 'Failed to check connection',
        };
    }
}

export async function connectGitHub(returnPath?: string) {
    try {
        // Generate state for OAuth
        const crypto = globalThis.crypto || require('crypto').webcrypto;
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const state = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

        await setOAuthStateCookie(state);

        // Set callback URL with return path
        const callbackUrl = withAppUrl(
            `/auth/github/callback${returnPath ? `?returnPath=${encodeURIComponent(returnPath)}` : ''}`,
        );

        const response = await authAPI.oauth_connections.getConnectUrl(
            'github',
            callbackUrl,
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
