import { authAPI } from '../api';
import type { UserProfile } from '../api/auth';
import { getAuthFromRequest } from './middleware';
import type { AuthUser, JwtPayload } from './middleware';
import { refreshAccessToken } from './refresh';

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

export async function getAuthFromCookie(): Promise<AuthUser | null> {
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
            return normalizeJwtUser(freshAuth.user);
        }
    }

    if (auth.user) {
        return normalizeJwtUser(auth.user);
    }

    try {
        return normalizeProfileUser(await authAPI.getProfile());
    } catch (error) {
        return null;
    }
}

export async function getAuthFromAPI(): Promise<AuthUser | null> {
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
        return normalizeProfileUser(await authAPI.getFreshProfile());
    } catch (error) {
        return null;
    }
}

export * from './middleware';
export * from './cookies';
export { refreshAccessToken } from './refresh';
