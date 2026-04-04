import { authAPI } from '../api';
import { getAuthFromRequest } from './middleware';
import { refreshAccessToken } from './refresh';

export async function getAuthFromCookie() {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated) {
        return null;
    }

    if (auth.isExpired) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
            return null;
        }
        const freshAuth = await getAuthFromRequest();
        if (!freshAuth.isAuthenticated) {
            return null;
        }

        if (freshAuth.user) {
            return freshAuth.user;
        }
    }

    if (auth.user) {
        return auth.user;
    }

    try {
        return await authAPI.getProfile();
    } catch (error) {
        return null;
    }
}

export async function getAuthFromAPI() {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated) {
        return null;
    }

    if (auth.isExpired) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
            return null;
        }
        // Re-verify the refreshed token is valid before making the API call
        const freshAuth = await getAuthFromRequest();
        if (!freshAuth.isAuthenticated || freshAuth.isExpired) {
            return null;
        }
    }

    try {
        return await authAPI.getFreshProfile();
    } catch (error) {
        return null;
    }
}

export * from './middleware';
export * from './cookies';
export { refreshAccessToken } from './refresh';
