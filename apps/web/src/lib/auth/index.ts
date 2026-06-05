import { cache } from 'react';
import { authAPI } from '../api';
import { ApiResponseError } from '../api/server-api';
import type { UserProfile } from '../api/auth';
import { getAuthFromRequest } from './middleware';
import type { AuthUser, JwtPayload } from './middleware';
import { removeAuthAccessCookies } from './cookies';

function normalizeJwtUser(user: JwtPayload): AuthUser {
    return {
        id: user.sub,
        email: user.email,
        username: user.username,
        emailVerified: user.emailVerified,
        avatar: user.avatar,
        provider: user.provider,
        isActive: user.isActive,
    };
}

function normalizeProfileUser(user: UserProfile): AuthUser {
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        emailVerified: user.emailVerified ?? false,
        avatar: user.avatar ?? null,
    };
}

async function clearAuthCookieOnUnauthorized(error: unknown): Promise<boolean> {
    if (error instanceof ApiResponseError && error.statusCode === 401) {
        console.warn(
            'Auth session rejected by API; clearing auth cookie. Verify web/API AUTH_SECRET values and session storage if this happens after login.',
        );
        await removeAuthAccessCookies();
        return true;
    }
    return false;
}

const getAuthFromCookieImpl = async (): Promise<AuthUser | null> => {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated || auth.isExpired) {
        return null;
    }

    if (auth.user) {
        try {
            const profile = await authAPI.getProfile();
            return {
                ...normalizeProfileUser(profile),
                provider: auth.user.provider,
                isActive: auth.user.isActive,
            };
        } catch (error) {
            if (!(await clearAuthCookieOnUnauthorized(error))) {
                throw error;
            }
            return null;
        }
    }

    try {
        return normalizeProfileUser(await authAPI.getProfile());
    } catch (error) {
        if (!(await clearAuthCookieOnUnauthorized(error))) {
            throw error;
        }
        return null;
    }
};

const getAuthFromAPIImpl = async (): Promise<AuthUser | null> => {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated || auth.isExpired) {
        return null;
    }

    try {
        return normalizeProfileUser(await authAPI.getFreshProfile());
    } catch (error) {
        if (!(await clearAuthCookieOnUnauthorized(error))) {
            throw error;
        }
        return null;
    }
};

export const getAuthFromCookie = cache(getAuthFromCookieImpl);

export const getAuthFromAPI = cache(getAuthFromAPIImpl);

export * from './middleware';
export * from './cookies';
