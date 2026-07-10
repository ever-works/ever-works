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

// Node.js fetch throws TypeError('fetch failed') for network-level failures
// (ECONNREFUSED, ENOTFOUND, ETIMEDOUT, etc.). These are distinct from HTTP
// error responses that arrive as ApiResponseError. When the API is unreachable
// we treat the session as unauthenticated rather than crashing the render.
function isNetworkError(error: unknown): boolean {
    return error instanceof TypeError && error.message === 'fetch failed';
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
            if (await clearAuthCookieOnUnauthorized(error)) return null;
            if (isNetworkError(error)) {
                console.warn('API unreachable; keeping session from JWT cookie data.');
                return normalizeJwtUser(auth.user);
            }
            throw error;
        }
    }

    // Opaque (non-JWT) token — no local user data to fall back on.
    try {
        return normalizeProfileUser(await authAPI.getProfile());
    } catch (error) {
        if (await clearAuthCookieOnUnauthorized(error)) return null;
        if (isNetworkError(error)) {
            console.warn(
                'API unreachable during auth validation (opaque token); treating session as unauthenticated.',
            );
            return null;
        }
        throw error;
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
        if (await clearAuthCookieOnUnauthorized(error)) return null;
        if (isNetworkError(error)) {
            console.warn('API unreachable; keeping session from JWT cookie data.');
            return auth.user ? normalizeJwtUser(auth.user) : null;
        }
        throw error;
    }
};

export const getAuthFromCookie = cache(getAuthFromCookieImpl);

export const getAuthFromAPI = cache(getAuthFromAPIImpl);

export * from './middleware';
export * from './cookies';
