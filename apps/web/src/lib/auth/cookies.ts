import 'server-only';
import { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies } from 'next/headers';
import { encrypt, decrypt } from './crypto';

export const AUTH_COOKIE_NAME = 'everworks_auth_token';

export const REFRESH_COOKIE_NAME = 'everworks_refresh_token';

export const BETTER_AUTH_SESSION_COOKIE = 'better-auth.session_token';
export const BETTER_AUTH_SESSION_DATA_COOKIE = 'better-auth.session_data';

const cookieOptions: Partial<ResponseCookie> = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
};

export async function setAuthAccessCookie(token: string) {
    const cookieStore = await cookies();
    const encryptedToken = await encrypt(token);
    cookieStore.set(AUTH_COOKIE_NAME, encryptedToken, cookieOptions);
}

export async function getAuthAccessCookie() {
    const cookieStore = await cookies();
    const encryptedValue = cookieStore.get(AUTH_COOKIE_NAME)?.value;
    if (!encryptedValue) return undefined;

    try {
        return await decrypt(encryptedValue);
    } catch (error) {
        console.error('Failed to decrypt auth cookie:', error);
        return undefined;
    }
}

export async function removeAuthAccessCookie() {
    const cookieStore = await cookies();
    cookieStore.delete(AUTH_COOKIE_NAME);
}

// =================
// Refresh Token
// =================

export async function setRefreshCookie(token: string) {
    const cookieStore = await cookies();
    const encryptedToken = await encrypt(token);
    cookieStore.set(REFRESH_COOKIE_NAME, encryptedToken, cookieOptions);
}

export async function getRefreshCookie() {
    const cookieStore = await cookies();
    const encryptedValue = cookieStore.get(REFRESH_COOKIE_NAME)?.value;
    if (!encryptedValue) return undefined;

    try {
        return await decrypt(encryptedValue);
    } catch (error) {
        console.error('Failed to decrypt refresh cookie:', error);
        return undefined;
    }
}

export async function removeRefreshCookie() {
    const cookieStore = await cookies();
    cookieStore.delete(REFRESH_COOKIE_NAME);
}

// =================
// All cookies
// =================

export async function setAuthCookies(access_token: string, refresh_token: string) {
    return Promise.all([setAuthAccessCookie(access_token), setRefreshCookie(refresh_token)]);
}

export async function removeAuthAccessCookies() {
    await Promise.all([removeAuthAccessCookie(), removeRefreshCookie()]);
}

// =================
// BetterAuth Session
// =================

export async function getBetterAuthSessionCookie(): Promise<string | undefined> {
    const cookieStore = await cookies();
    return (
        cookieStore.get(BETTER_AUTH_SESSION_COOKIE)?.value ||
        cookieStore.get(`__Secure-${BETTER_AUTH_SESSION_COOKIE}`)?.value
    );
}

export async function hasBetterAuthCookie(): Promise<boolean> {
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    return allCookies.some(
        (cookie) =>
            cookie.name.startsWith('better-auth.') ||
            cookie.name.startsWith('__Secure-better-auth.'),
    );
}

export async function removeBetterAuthCookies(): Promise<void> {
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
 * Get all BetterAuth cookie headers for forwarding to the API.
 * BetterAuth may use multiple cookies (session token + cookie cache).
 */
export async function getBetterAuthCookieHeader(): Promise<string | undefined> {
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    const baCookies = allCookies.filter(
        (c) => c.name.startsWith('better-auth.') || c.name.startsWith('__Secure-better-auth.'),
    );
    if (baCookies.length === 0) return undefined;
    return baCookies.map((c) => `${c.name}=${c.value}`).join('; ');
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
