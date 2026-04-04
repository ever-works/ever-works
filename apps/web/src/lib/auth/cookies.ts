import 'server-only';
import { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies } from 'next/headers';
import { encrypt, decrypt } from './crypto';

export const AUTH_COOKIE_NAME = 'everworks_auth_token';

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
// All cookies
// =================

export async function setAuthCookies(access_token: string) {
    await setAuthAccessCookie(access_token);
}

export async function removeAuthAccessCookies() {
    await removeAuthAccessCookie();
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
