import { authAPI } from '../api';
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

export async function getAuthFromCookie(): Promise<AuthUser | null> {
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
            if (error instanceof Error && error.message.includes('Unauthorized')) {
                await removeAuthAccessCookies();
            }
            return null;
        }
    }

    try {
        return normalizeProfileUser(await authAPI.getProfile());
    } catch (error) {
        if (error instanceof Error && error.message.includes('Unauthorized')) {
            await removeAuthAccessCookies();
        }
        return null;
    }
}

export async function getAuthFromAPI(): Promise<AuthUser | null> {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated || auth.isExpired) {
        return null;
    }

    try {
        return normalizeProfileUser(await authAPI.getFreshProfile());
    } catch (error) {
        if (error instanceof Error && error.message.includes('Unauthorized')) {
            await removeAuthAccessCookies();
        }
        return null;
    }
}

export * from './middleware';
export * from './cookies';
