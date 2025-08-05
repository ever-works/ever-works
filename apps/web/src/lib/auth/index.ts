import { authAPI } from '../api';
import { getAuthFromRequest } from './middleware';

export async function getAuthUser() {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated) {
        return null;
    }

    return auth.user;
}

export async function getAuthUserFromAPI() {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated) {
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
