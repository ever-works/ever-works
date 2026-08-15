import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthFromRequestMock, getProfileMock, getFreshProfileMock, removeAuthAccessCookiesMock } =
    vi.hoisted(() => ({
        getAuthFromRequestMock: vi.fn(),
        getProfileMock: vi.fn(),
        getFreshProfileMock: vi.fn(),
        removeAuthAccessCookiesMock: vi.fn(),
    }));

vi.mock('../api', () => ({
    authAPI: {
        getProfile: getProfileMock,
        getFreshProfile: getFreshProfileMock,
    },
}));

vi.mock('../api/server-api', () => ({
    ApiResponseError: class ApiResponseError extends Error {
        constructor(
            message: string,
            public readonly statusCode: number,
        ) {
            super(message);
            this.name = 'ApiResponseError';
        }
    },
}));

vi.mock('./middleware', () => ({
    getAuthFromRequest: getAuthFromRequestMock,
}));

vi.mock('./cookies', () => ({
    removeAuthAccessCookies: removeAuthAccessCookiesMock,
}));

async function importAuthModule() {
    vi.resetModules();
    return import('./index');
}

describe('getAuthFromCookie', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('clears the auth cookie when the API rejects the stored bearer with 401', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getAuthFromRequestMock.mockResolvedValue({
            isAuthenticated: true,
            isExpired: false,
            isOpaqueToken: true,
            token: 'opaque-session-token',
        });
        getProfileMock.mockRejectedValue(new ApiResponseError('translated unauthorized', 401));

        const { getAuthFromCookie } = await importAuthModule();

        await expect(getAuthFromCookie()).resolves.toBeNull();
        expect(removeAuthAccessCookiesMock).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-auth API failures without clearing the auth cookie', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getAuthFromRequestMock.mockResolvedValue({
            isAuthenticated: true,
            isExpired: false,
            isOpaqueToken: true,
            token: 'opaque-session-token',
        });
        getProfileMock.mockRejectedValue(new ApiResponseError('server error', 500));

        const { getAuthFromCookie } = await importAuthModule();

        await expect(getAuthFromCookie()).rejects.toThrow('server error');
        expect(removeAuthAccessCookiesMock).not.toHaveBeenCalled();
    });
});

describe('getAuthFromAPI', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('clears the auth cookie when fresh profile validation returns 401', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getAuthFromRequestMock.mockResolvedValue({
            isAuthenticated: true,
            isExpired: false,
            isOpaqueToken: true,
            token: 'opaque-session-token',
        });
        getFreshProfileMock.mockRejectedValue(new ApiResponseError('session invalid', 401));

        const { getAuthFromAPI } = await importAuthModule();

        await expect(getAuthFromAPI()).resolves.toBeNull();
        expect(removeAuthAccessCookiesMock).toHaveBeenCalledTimes(1);
    });
});

/**
 * Regression — the auth-401-during-render 500, found live on app.ever.works:
 * a session the API rejected turned EVERY authenticated page, and /login
 * itself, into a hard 500 with no way back in through the UI.
 *
 * These helpers are cache()d and run during Server Component RENDER, where
 * Next.js refuses cookie mutation and throws "Cookies can only be modified in
 * a Server Action or Route Handler." That throw came from INSIDE the 401 catch
 * handler, so it escaped and killed the render instead of degrading to
 * "not signed in".
 */
describe('401 while the cookie cannot be cleared (Server Component render)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const renderContextError = () =>
        new Error('Cookies can only be modified in a Server Action or Route Handler.');

    const rejectedSession = {
        isAuthenticated: true,
        isExpired: false,
        isOpaqueToken: true,
        token: 'opaque-session-token',
    };

    it('getAuthFromCookie reports no session instead of throwing', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getAuthFromRequestMock.mockResolvedValue(rejectedSession);
        getProfileMock.mockRejectedValue(new ApiResponseError('unauthorized', 401));
        removeAuthAccessCookiesMock.mockRejectedValue(renderContextError());

        const { getAuthFromCookie } = await importAuthModule();

        // Pre-fix this REJECTED with the render-context error, which is what
        // produced the 500 on every authenticated page.
        await expect(getAuthFromCookie()).resolves.toBeNull();
        expect(removeAuthAccessCookiesMock).toHaveBeenCalledTimes(1);
    });

    it('getAuthFromAPI reports no session instead of throwing', async () => {
        const { ApiResponseError } = await import('../api/server-api');
        getAuthFromRequestMock.mockResolvedValue(rejectedSession);
        getFreshProfileMock.mockRejectedValue(new ApiResponseError('unauthorized', 401));
        removeAuthAccessCookiesMock.mockRejectedValue(renderContextError());

        const { getAuthFromAPI } = await importAuthModule();

        await expect(getAuthFromAPI()).resolves.toBeNull();
    });

    it('control: a NON-401 failure still propagates — this must not swallow real errors', async () => {
        getAuthFromRequestMock.mockResolvedValue(rejectedSession);
        getProfileMock.mockRejectedValue(new Error('upstream exploded'));

        const { getAuthFromCookie } = await importAuthModule();

        await expect(getAuthFromCookie()).rejects.toThrow('upstream exploded');
        expect(removeAuthAccessCookiesMock).not.toHaveBeenCalled();
    });
});
