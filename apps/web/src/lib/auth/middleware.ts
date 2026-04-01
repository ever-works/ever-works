import 'server-only';
import { getAuthSessionCookieHeader, hasAuthSessionCookie } from './cookies';
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

export async function getAuthFromRequest(): Promise<{
    isAuthenticated: boolean;
    user?: AuthUser;
    isExpired: false;
}> {
    // Check if any auth session cookie exists
    const hasSessionCookie = await hasAuthSessionCookie();

    if (hasSessionCookie) {
        // Validate session via API
        const authUser = await getSessionUserFromAPI();
        if (authUser) {
            return {
                isAuthenticated: true,
                user: authUser,
                isExpired: false,
            };
        }
    }

    return { isAuthenticated: false, isExpired: false };
}

/**
 * Validate the auth session by calling the API's session endpoint.
 * Returns the AuthUser if valid, null otherwise.
 */
async function getSessionUserFromAPI(): Promise<AuthUser | null> {
    try {
        const cookieHeader = await getAuthSessionCookieHeader();
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
