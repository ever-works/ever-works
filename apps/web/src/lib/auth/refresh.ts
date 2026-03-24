import 'server-only';
import { API_URL } from '../constants';
import { getRefreshCookie, setAuthCookies, removeAuthAccessCookies } from './cookies';

// Deduplicate concurrent refresh attempts within the same request lifecycle.
// Multiple server actions or fetches hitting an expired token simultaneously
// will share a single in-flight refresh call instead of racing.
let pendingRefresh: Promise<boolean> | null = null;

/**
 * Attempts to refresh the access token using the stored refresh token.
 * Calls the API refresh endpoint directly (bypasses serverFetch to avoid
 * circular dependency) and updates both auth cookies on success.
 *
 * Returns true if refresh succeeded, false otherwise.
 */
export async function refreshAccessToken(): Promise<boolean> {
    if (pendingRefresh) {
        return pendingRefresh;
    }

    pendingRefresh = doRefresh();

    try {
        return await pendingRefresh;
    } finally {
        pendingRefresh = null;
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
    } catch {
        await removeAuthAccessCookies();
        return false;
    }
}
