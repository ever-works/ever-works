import 'server-only';
import { jwtDecode } from 'jwt-decode';
import { getAuthAccessCookie, getBetterAuthCookieHeader, hasBetterAuthCookie } from './cookies';
import { API_URL } from '../constants';

export type AuthUser = {
    sub: string;
    email: string;
    provider: string;
    connectedProviders?: string[];
    username: string;
    emailVerified: boolean;
    isActive: boolean;
    avatar: string | null;
};

export type JwtPayload = AuthUser & {
    iat: number;
    iss: string;
    aud: string;
    exp: number;
};

export async function getAuthFromRequest(): Promise<{
    isAuthenticated: boolean;
    user?: AuthUser;
    isExpired: boolean;
    token?: string;
}> {
    // Check if any BetterAuth auth cookie exists
    const hasBaCookie = await hasBetterAuthCookie();

    if (hasBaCookie) {
        // Validate BetterAuth session via API
        const baUser = await getBetterAuthSessionFromAPI();
        if (baUser) {
            return {
                isAuthenticated: true,
                user: baUser,
                isExpired: false, // Sessions auto-refresh
            };
        }
    }

    // Fall back to legacy JWT
    try {
        const token = await getAuthAccessCookie();

        if (!token) {
            return { isAuthenticated: false, isExpired: false };
        }

        const decoded = jwtDecode<JwtPayload>(token);
        const now = Date.now() / 1000;

        return {
            isAuthenticated: true,
            user: decoded,
            isExpired: decoded.exp < now,
            token,
        };
    } catch {
        return { isAuthenticated: false, isExpired: false };
    }
}

/**
 * Validate BetterAuth session by calling the API's session endpoint.
 * Returns the AuthUser if valid, null otherwise.
 */
async function getBetterAuthSessionFromAPI(): Promise<AuthUser | null> {
    try {
        const cookieHeader = await getBetterAuthCookieHeader();
        if (!cookieHeader) {
            return null;
        }

        const response = await fetch(`${API_URL}/auth/profile/fresh`, {
            method: 'GET',
            headers: {
                Cookie: cookieHeader,
            },
            cache: 'no-store',
        });

        if (!response.ok) return null;

        const data = await response.json();
        return {
            sub: data.id,
            email: data.email,
            provider: data.registrationProvider || 'local',
            connectedProviders: Array.isArray(data.oauthTokens)
                ? data.oauthTokens
                      .map((token: { provider?: string }) => token.provider)
                      .filter((provider: string | undefined): provider is string => !!provider)
                : [],
            username: data.username || data.email.split('@')[0],
            emailVerified: data.emailVerified || false,
            isActive: data.isActive ?? true,
            avatar: data.avatar || null,
        };
    } catch {
        return null;
    }
}
