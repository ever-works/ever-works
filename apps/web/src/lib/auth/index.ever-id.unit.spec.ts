import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 S6 — "You were signed out of Ever ID." on the next page load.
 *
 * A session ended by an Ever ID sign-out notice is answered by the API with
 * `401 { code: 'ever_id_signed_out' }` instead of the plain `401` an expired
 * session gets. The central 401 handling records that for the current request,
 * so the sign-in page — which validates the stale cookie before rendering — can
 * show the notice. An ordinary 401 records nothing, and the existing behaviour
 * (clear the cookie, report "not signed in") is unchanged in both cases.
 *
 * `cache()` scopes the record to one server request; outside React Server
 * Components it does not memoise, so it is replaced here with a per-module-load
 * memo — the same "one request" semantics a server render gets.
 *
 * Where the cookie can be removed (a Server Action or route handler) the sign-in
 * page that follows has no stale cookie left to validate, so the same answer
 * also leaves the short-lived marker (`./ever-id-signed-out.ts`) — after the
 * removal, and only for the Ever ID answer.
 */

const { getAuthFromRequestMock, getProfileMock, removeAuthAccessCookiesMock, rememberMock } =
    vi.hoisted(() => ({
        getAuthFromRequestMock: vi.fn(),
        getProfileMock: vi.fn(),
        removeAuthAccessCookiesMock: vi.fn(),
        rememberMock: vi.fn(),
    }));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        cache: <T extends (...args: never[]) => unknown>(fn: T) => {
            let done = false;
            let value: ReturnType<T>;
            return ((...args: Parameters<T>) => {
                if (!done) {
                    done = true;
                    value = fn(...args) as ReturnType<T>;
                }
                return value;
            }) as T;
        },
    };
});

vi.mock('../api', () => ({
    authAPI: { getProfile: getProfileMock, getFreshProfile: vi.fn() },
}));

vi.mock('../api/server-api', () => ({
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
            public readonly code?: string,
        ) {
            super(message);
            this.name = 'ApiResponseError';
        }
    },
}));

vi.mock('./middleware', () => ({ getAuthFromRequest: getAuthFromRequestMock }));
vi.mock('./cookies', () => ({ removeAuthAccessCookies: removeAuthAccessCookiesMock }));
vi.mock('./ever-id-signed-out', () => ({ rememberEverIdSignOut: rememberMock }));

async function importAuthModule() {
    vi.resetModules();
    return import('./index');
}

const STALE_SESSION = {
    isAuthenticated: true,
    isExpired: false,
    isOpaqueToken: true,
    token: 'opaque-session-token',
};

describe('wasSignedOutByEverId (S6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        getAuthFromRequestMock.mockResolvedValue(STALE_SESSION);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('records a session the API says Ever ID ended, and still reports "not signed in"', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getProfileMock.mockRejectedValue(
            new (ApiResponseError as unknown as new (m: string, s: number, c?: string) => Error)(
                'You were signed out of Ever ID.',
                401,
                'ever_id_signed_out',
            ),
        );
        const { getAuthFromCookie, wasSignedOutByEverId } = await importAuthModule();

        expect(wasSignedOutByEverId()).toBe(false);
        await expect(getAuthFromCookie()).resolves.toBeNull();
        expect(wasSignedOutByEverId()).toBe(true);
        expect(removeAuthAccessCookiesMock).toHaveBeenCalledTimes(1);
        // …and leaves the marker for a sign-in page that will find no cookie.
        expect(rememberMock).toHaveBeenCalledTimes(1);
        expect(rememberMock.mock.invocationCallOrder[0]).toBeGreaterThan(
            removeAuthAccessCookiesMock.mock.invocationCallOrder[0],
        );
    });

    it('still reports "not signed in" when the cookie cannot be removed (a Server Component render)', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getProfileMock.mockRejectedValue(
            new (ApiResponseError as unknown as new (m: string, s: number, c?: string) => Error)(
                'You were signed out of Ever ID.',
                401,
                'ever_id_signed_out',
            ),
        );
        removeAuthAccessCookiesMock.mockRejectedValueOnce(
            new Error('Cookies can only be modified in a Server Action or Route Handler.'),
        );
        const { getAuthFromCookie, wasSignedOutByEverId } = await importAuthModule();

        await expect(getAuthFromCookie()).resolves.toBeNull();
        // The stale cookie stays, so the sign-in page sees this answer itself.
        expect(wasSignedOutByEverId()).toBe(true);
        // The marker is attempted regardless; it is a quiet no-op in a render.
        expect(rememberMock).toHaveBeenCalledTimes(1);
    });

    it('records nothing for an ordinary 401 (an expired session)', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getProfileMock.mockRejectedValue(
            new (ApiResponseError as unknown as new (m: string, s: number) => Error)(
                'Unauthorized',
                401,
            ),
        );
        const { getAuthFromCookie, wasSignedOutByEverId } = await importAuthModule();

        await expect(getAuthFromCookie()).resolves.toBeNull();
        expect(wasSignedOutByEverId()).toBe(false);
        expect(removeAuthAccessCookiesMock).toHaveBeenCalledTimes(1);
        expect(rememberMock).not.toHaveBeenCalled();
    });

    it('records nothing when the session is valid', async () => {
        getProfileMock.mockResolvedValue({ id: 'u1', username: 'a', email: 'a@b.c' });
        const { getAuthFromCookie, wasSignedOutByEverId } = await importAuthModule();

        await expect(getAuthFromCookie()).resolves.toMatchObject({ id: 'u1' });
        expect(wasSignedOutByEverId()).toBe(false);
        expect(rememberMock).not.toHaveBeenCalled();
    });

    it('ignores the code on anything that is not a 401', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getProfileMock.mockRejectedValue(
            new (ApiResponseError as unknown as new (m: string, s: number, c?: string) => Error)(
                'x',
                403,
                'ever_id_signed_out',
            ),
        );
        const { getAuthFromCookie, wasSignedOutByEverId } = await importAuthModule();

        await expect(getAuthFromCookie()).rejects.toThrow('x');
        expect(wasSignedOutByEverId()).toBe(false);
        expect(rememberMock).not.toHaveBeenCalled();
    });
});
