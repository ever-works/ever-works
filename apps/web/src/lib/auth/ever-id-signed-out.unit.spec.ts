import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 S6 — the marker that carries "you were signed out of Ever ID" to the
 * sign-in page when a Server Action or route handler has already removed the
 * session cookie. It holds a constant, never a token, a code or an address; it
 * is HttpOnly, SameSite=Lax, site-wide, short-lived and `Secure` by the same
 * public-URL rule as the session cookie; and writing it is best-effort, because
 * a Server Component render refuses cookie writes.
 */

const mocks = vi.hoisted(() => ({
    cookies: vi.fn(),
    isPublicUrlHttps: vi.fn(() => true),
}));

vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('./cookies', () => ({ isPublicUrlHttps: mocks.isPublicUrlHttps }));

import {
    EVER_ID_SIGNED_OUT_COOKIE,
    EVER_ID_SIGNED_OUT_MAX_AGE_SECONDS,
    hasEverIdSignOutMarker,
    rememberEverIdSignOut,
} from './ever-id-signed-out';

function fakeStore(values: Record<string, string> = {}) {
    return {
        get: vi.fn((name: string) => (name in values ? { name, value: values[name] } : undefined)),
        set: vi.fn(),
        delete: vi.fn(),
    };
}

describe('rememberEverIdSignOut', () => {
    beforeEach(() => {
        mocks.cookies.mockReset();
        mocks.isPublicUrlHttps.mockReset().mockReturnValue(true);
    });

    it('leaves a constant marker with the session-cookie attributes and a short life', async () => {
        const store = fakeStore();
        mocks.cookies.mockResolvedValue(store);

        await rememberEverIdSignOut();

        expect(store.set).toHaveBeenCalledTimes(1);
        expect(store.set).toHaveBeenCalledWith(EVER_ID_SIGNED_OUT_COOKIE, '1', {
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
            path: '/',
            maxAge: EVER_ID_SIGNED_OUT_MAX_AGE_SECONDS,
        });
        expect(EVER_ID_SIGNED_OUT_COOKIE).toBe('ew_everid_signed_out');
        expect(EVER_ID_SIGNED_OUT_MAX_AGE_SECONDS).toBeLessThanOrEqual(600);
    });

    it('drops Secure on a plain-http deployment, exactly like the session cookie', async () => {
        const store = fakeStore();
        mocks.cookies.mockResolvedValue(store);
        mocks.isPublicUrlHttps.mockReturnValue(false);

        await rememberEverIdSignOut();

        expect(store.set.mock.calls[0][2]).toMatchObject({ secure: false });
    });

    it('is a quiet no-op where cookies cannot be written (a Server Component render)', async () => {
        const store = fakeStore();
        store.set.mockImplementation(() => {
            throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
        });
        mocks.cookies.mockResolvedValue(store);

        await expect(rememberEverIdSignOut()).resolves.toBeUndefined();
    });

    it('is a quiet no-op outside a request', async () => {
        mocks.cookies.mockRejectedValue(new Error('outside a request scope'));

        await expect(rememberEverIdSignOut()).resolves.toBeUndefined();
    });
});

describe('hasEverIdSignOutMarker', () => {
    beforeEach(() => {
        mocks.cookies.mockReset();
    });

    it('reads the marker', async () => {
        mocks.cookies.mockResolvedValue(fakeStore({ [EVER_ID_SIGNED_OUT_COOKIE]: '1' }));

        await expect(hasEverIdSignOutMarker()).resolves.toBe(true);
    });

    it.each([
        ['no marker', {}],
        ['an unexpected value', { [EVER_ID_SIGNED_OUT_COOKIE]: 'true' }],
        ['an empty value', { [EVER_ID_SIGNED_OUT_COOKIE]: '' }],
    ])('is false for %s', async (_label, values) => {
        mocks.cookies.mockResolvedValue(fakeStore(values));

        await expect(hasEverIdSignOutMarker()).resolves.toBe(false);
    });

    it('is false when the cookies cannot be read', async () => {
        mocks.cookies.mockRejectedValue(new Error('outside a request scope'));

        await expect(hasEverIdSignOutMarker()).resolves.toBe(false);
    });
});
