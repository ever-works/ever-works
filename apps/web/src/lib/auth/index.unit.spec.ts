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
