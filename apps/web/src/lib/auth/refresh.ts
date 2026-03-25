import 'server-only';
import { cache } from 'react';
import { API_URL } from '../constants';
import { getRefreshCookie, setAuthCookies, removeAuthAccessCookies } from './cookies';

// React.cache() scopes this per-request in Next.js App Router, so concurrent
// server components within the same render share one refresh call without
// leaking state across different users' requests.
const getRefreshState = cache(() => ({ pending: null as Promise<boolean> | null }));

/**
 * Attempts to refresh the access token using the stored refresh token.
 * Calls the API refresh endpoint directly (bypasses serverFetch to avoid
 * circular dependency) and updates both auth cookies on success.
 *
 * Returns true if refresh succeeded, false otherwise.
 */
export async function refreshAccessToken(): Promise<boolean> {
    const state = getRefreshState();
    if (state.pending) {
        return state.pending;
    }

    state.pending = doRefresh();

    try {
        return await state.pending;
    } finally {
        state.pending = null;
    }
}

async function doRefresh(): Promise<boolean> {
    try {
        const refreshToken = await getRefreshCookie();
        if (!refreshToken) {
            await removeAuthAccessCookies();
            return false;
        }

        const response = await fetch(`${API_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
            cache: 'no-store',
        });

        if (!response.ok) {
            await removeAuthAccessCookies();
            return false;
        }

        const data = await response.json();

        if (!data.access_token || !data.refresh_token) {
            await removeAuthAccessCookies();
            return false;
        }

        await setAuthCookies(data.access_token, data.refresh_token);
        return true;
    } catch (error) {
        // Only log on transient/network errors — leave cookies intact so the
        // user is not forced to re-authenticate on a temporary failure.
        console.error('Token refresh failed unexpectedly:', error);
        return false;
    }
}
