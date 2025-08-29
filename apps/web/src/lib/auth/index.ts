import { authAPI } from '../api';
import { getAuthFromRequest } from './middleware';

export async function getAuthFromCookie() {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated) {
        return null;
    }

    if (auth.isExpired) {
        console.error('Token expired, NEED TO REFRESH (TODO)');
        return null;
    }

    return auth.user || null;
}

export async function getAuthFromAPI() {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated) {
        return null;
    }

    if (auth.isExpired) {
        console.error('Token expired, NEED TO REFRESH (TODO)');
        return null;
    }

    try {
        return await authAPI.getFreshProfile();
    } catch (error) {
        return null;
    }
}

export * from './middleware';
export * from './cookies';
