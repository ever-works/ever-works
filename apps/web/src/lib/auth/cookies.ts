import { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';
import { cookies } from 'next/headers';

export const AUTH_COOKIE_NAME = 'everworks_auth_token';

export const REFRESH_COOKIE_NAME = 'everworks_refresh_token';

const cookieOptions: Partial<ResponseCookie> = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
};

export async function setAuthCookie(token: string) {
    const cookieStore = await cookies();
    cookieStore.set(AUTH_COOKIE_NAME, token, cookieOptions);
}

export async function setRefreshCookie(token: string) {
    const cookieStore = await cookies();
    cookieStore.set(REFRESH_COOKIE_NAME, token, cookieOptions);
}

export async function getAuthCookie() {
    const cookieStore = await cookies();
    return cookieStore.get(AUTH_COOKIE_NAME)?.value;
}

export async function getRefreshCookie() {
    const cookieStore = await cookies();
    return cookieStore.get(REFRESH_COOKIE_NAME)?.value;
}

export async function removeAuthCookie() {
    const cookieStore = await cookies();
    cookieStore.delete(AUTH_COOKIE_NAME);
}

export async function removeRefreshCookie() {
    const cookieStore = await cookies();
    cookieStore.delete(REFRESH_COOKIE_NAME);
}

export async function removeAuthCookies() {
    await Promise.all([removeAuthCookie(), removeRefreshCookie()]);
}
