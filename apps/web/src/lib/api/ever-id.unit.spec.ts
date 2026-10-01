import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_SCOPE_HEADER } from '../workspace-scope';

const { getAuthAccessCookieMock, headersMock, translationsMock } = vi.hoisted(() => ({
    getAuthAccessCookieMock: vi.fn(),
    headersMock: vi.fn(),
    translationsMock: vi.fn(async () => (key: string) => key),
}));

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('../auth/cookies', () => ({ getAuthAccessCookie: getAuthAccessCookieMock }));
vi.mock('next-intl/server', () => ({ getTranslations: translationsMock }));
vi.mock('../constants', () => ({
    ALLOWED_REDIRECT_URLS: ['app.example'],
    API_URL: 'https://api.example/api',
    ROUTES: {
        DASHBOARD: '/',
        AUTH_ERROR: '/auth/error',
        DASHBOARD_SETTINGS_SECURITY: '/settings/security',
    },
    WEB_URL: 'https://app.example',
}));

import { EverIdRequestError, everIdAPI, toEverIdFailure } from './ever-id';

/**
 * APW-12 T22 — the web's client for `/api/auth/ever-id/*`.
 *
 * Pinned: every call selects personal scope (the callback runs under `/api`,
 * where no workspace selector exists), carries the session as a bearer when
 * there is one, and a refusal keeps the wire code and the `Retry-After` wait but
 * never the API's English message.
 */

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    const fetchMock = vi.fn(
        async () =>
            new Response(body === undefined ? null : JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json', ...headers },
            }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('everIdAPI transport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthAccessCookieMock.mockResolvedValue(undefined);
        // A top-level navigation under /api: no proxy workspace selector.
        headersMock.mockResolvedValue(new Headers({ host: 'app.example' }));
    });

    it('posts the callback under personal scope, without a selector', async () => {
        const fetchMock = stubFetch(200, {
            outcome: 'signedIn',
            access_token: 'session',
            user: { id: 'u1', email: 'a@b.c', username: 'a' },
            returnTo: null,
        });

        const result = await everIdAPI.callback({
            code: 'code-1',
            state: 'state-1',
            transaction: 'txn-1',
        });

        expect(result.outcome).toBe('signedIn');
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.example/api/auth/ever-id/callback');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({
            code: 'code-1',
            state: 'state-1',
            transaction: 'txn-1',
        });
        expect(new Headers(init.headers).get(API_SCOPE_HEADER)).toBe('@personal');
        // Nothing secret in the address.
        expect(url).not.toContain('code-1');
        expect(url).not.toContain('state-1');
    });

    it('sends the session as a bearer when the browser has one (the connect intent needs it)', async () => {
        getAuthAccessCookieMock.mockResolvedValue('session-token');
        const fetchMock = stubFetch(200, {
            authorizationUrl: 'https://id.example/a',
            transaction: 't',
        });

        await everIdAPI.connectAuthorize();

        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-token');
    });

    it('patches the administrator settings and answers the new status', async () => {
        getAuthAccessCookieMock.mockResolvedValue('admin-session');
        const status = { enabled: true, settings: { displayName: 'Ever ID Staging' } };
        const fetchMock = stubFetch(200, status);

        await expect(
            everIdAPI.adminSettings({
                displayName: 'Ever ID Staging',
                localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
            }),
        ).resolves.toEqual(status);

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.example/api/auth/ever-id/admin/settings');
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(String(init.body))).toEqual({
            displayName: 'Ever ID Staging',
            localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
        });
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer admin-session');
    });

    it('keeps the code of a refused settings change', async () => {
        stubFetch(400, {
            status: 'error',
            code: 'invalid_settings',
            message: 'The settings were refused.',
        });

        const error = await everIdAPI.adminSettings({ displayName: 'x' }).catch((caught) => caught);

        expect(error).toBeInstanceOf(EverIdRequestError);
        expect(error).toMatchObject({ status: 400, code: 'invalid_settings' });
        expect((error as Error).message).not.toContain('refused');
    });

    it('encodes the identity id into the disconnect path', async () => {
        const fetchMock = stubFetch(204, undefined);

        await everIdAPI.disconnect('abc/../def');

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.example/api/auth/ever-id/identities/abc%2F..%2Fdef');
        expect(init.method).toBe('DELETE');
    });

    it('keeps the wire code of a refusal, and drops the upstream message', async () => {
        stubFetch(409, {
            status: 'error',
            code: 'subject_linked',
            message: 'internal detail that must not reach a person',
        });

        const error = await everIdAPI
            .connectConfirm({ pending: 'p' })
            .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(EverIdRequestError);
        const refusal = error as EverIdRequestError;
        expect(refusal.status).toBe(409);
        expect(refusal.code).toBe('subject_linked');
        expect(refusal.message).not.toContain('internal detail');
    });

    it('reads a code nested under `error` too', async () => {
        stubFetch(403, { error: { code: 'reauth_required', message: 'x' } });

        const error = (await everIdAPI
            .connectAuthorize()
            .catch((e: unknown) => e)) as EverIdRequestError;

        expect(error.code).toBe('reauth_required');
    });

    it('keeps the Retry-After wait of a 429', async () => {
        stubFetch(
            429,
            { statusCode: 429, message: 'ThrottlerException: Too Many Requests' },
            {
                'Retry-After': '17',
            },
        );

        const error = (await everIdAPI
            .authorize({})
            .catch((e: unknown) => e)) as EverIdRequestError;

        expect(error.status).toBe(429);
        expect(error.code).toBeNull();
        expect(error.retryAfterSeconds).toBe(17);
    });
});

describe('toEverIdFailure', () => {
    it.each([
        [new EverIdRequestError(404, 'ever_id_disabled'), { code: 'ever_id_disabled' }],
        [new EverIdRequestError(403, 'reauth_required'), { code: 'reauth_required' }],
        [new EverIdRequestError(422, 'email_not_verified'), { code: 'email_not_verified' }],
        [new EverIdRequestError(429, null, 30), { code: 'rate_limited', retryAfterSeconds: 30 }],
        [new EverIdRequestError(503, null), { code: 'provider_unavailable' }],
        [new EverIdRequestError(500, 'something_else'), { code: 'provider_unavailable' }],
        [new EverIdRequestError(400, null), { code: 'transaction_invalid' }],
        [new TypeError('fetch failed'), { code: 'provider_unavailable' }],
    ])('classifies %o', (error, expected) => {
        expect(toEverIdFailure(error)).toEqual(expected);
    });

    it('uses the caller’s fallback for an unexplained refusal', () => {
        expect(toEverIdFailure(new EverIdRequestError(404, null), 'provider_unavailable')).toEqual({
            code: 'provider_unavailable',
        });
    });

    it('gives a rate limit a wait even when the API sent none', () => {
        expect(toEverIdFailure(new EverIdRequestError(429, null, null))).toEqual({
            code: 'rate_limited',
            retryAfterSeconds: 60,
        });
    });
});
