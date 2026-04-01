import 'server-only';
import { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies } from 'next/headers';

export const AUTH_SESSION_COOKIE_NAME = 'better-auth.session_token';
export const AUTH_SESSION_DATA_COOKIE_NAME = 'better-auth.session_data';

const cookieOptions: Partial<ResponseCookie> = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
};

// =================
// Auth Session
// =================

export async function getAuthSessionCookie(): Promise<string | undefined> {
    const cookieStore = await cookies();
    return (
        cookieStore.get(AUTH_SESSION_COOKIE_NAME)?.value ||
        cookieStore.get(`__Secure-${AUTH_SESSION_COOKIE_NAME}`)?.value
    );
}

export async function hasAuthSessionCookie(): Promise<boolean> {
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    return allCookies.some(
        (cookie) =>
            cookie.name.startsWith('better-auth.') ||
            cookie.name.startsWith('__Secure-better-auth.'),
    );
}

export async function clearAuthSessionCookies(): Promise<void> {
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();

    for (const cookie of allCookies) {
        if (
            cookie.name.startsWith('better-auth.') ||
            cookie.name.startsWith('__Secure-better-auth.')
        ) {
            cookieStore.delete(cookie.name);
        }
    }
}

/**
 * Get all auth session cookie headers for forwarding to the API.
 * The provider may use multiple cookies (session token + cookie cache).
 */
export async function getAuthSessionCookieHeader(): Promise<string | undefined> {
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    const sessionCookies = allCookies.filter(
        (c) => c.name.startsWith('better-auth.') || c.name.startsWith('__Secure-better-auth.'),
    );
    if (sessionCookies.length === 0) return undefined;
    return sessionCookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// =================
// OAuth
// =================

export async function setOAuthStateCookie(state: string) {
    const cookieStore = await cookies();
    cookieStore.set('oauth_state', state, {
        ...cookieOptions,
        maxAge: 60 * 10, // 10 minute expiry
    });
}

export async function getOAuthStateCookie() {
    const cookieStore = await cookies();
    return cookieStore.get('oauth_state')?.value;
}

export async function removeOAuthStateCookie() {
    const cookieStore = await cookies();
    cookieStore.delete('oauth_state');
}

// =================
// Redirects
// =================

export async function setRedirectCookie(url: string) {
    const cookieStore = await cookies();
    cookieStore.set('redirect_url', url, {
        ...cookieOptions,
        maxAge: 60 * 10, // 10 minute expiry
    });
}

export async function getRedirectCookie() {
    const cookieStore = await cookies();
    return cookieStore.get('redirect_url')?.value;
}

export async function removeRedirectCookie() {
    const cookieStore = await cookies();
    cookieStore.delete('redirect_url');
}
