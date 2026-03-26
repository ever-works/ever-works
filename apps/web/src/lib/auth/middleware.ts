import 'server-only';
import { jwtDecode } from 'jwt-decode';
import { getAuthAccessCookie, getBetterAuthSessionCookie } from './cookies';
import { API_URL } from '../constants';

export type AuthUser = {
	sub: string;
	email: string;
	provider: string;
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
	// Try BetterAuth session first
	const baSession = await getBetterAuthSessionFromAPI();
	if (baSession) {
		return {
			isAuthenticated: true,
			user: baSession,
			isExpired: false, // Sessions auto-refresh, never "expired" from client perspective
		};
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
	} catch (error) {
		return { isAuthenticated: false, isExpired: false };
	}
}

/**
 * Validate BetterAuth session by calling the API's session endpoint.
 * Returns the AuthUser if valid, null otherwise.
 */
async function getBetterAuthSessionFromAPI(): Promise<AuthUser | null> {
	const sessionToken = await getBetterAuthSessionCookie();
	if (!sessionToken) return null;

	try {
		const response = await fetch(`${API_URL}/auth/better-auth/get-session`, {
			method: 'GET',
			headers: {
				Cookie: `better-auth.session_token=${sessionToken}`,
			},
			cache: 'no-store',
		});

		if (!response.ok) return null;

		const data = await response.json();
		if (!data?.user) return null;

		// Map BetterAuth user to AuthUser shape
		return {
			sub: data.user.id,
			email: data.user.email,
			provider: 'betterauth', // Will be overridden by application user lookup
			username: data.user.name || data.user.email.split('@')[0],
			emailVerified: data.user.emailVerified || false,
			isActive: true,
			avatar: data.user.image || null,
		};
	} catch {
		return null;
	}
}
