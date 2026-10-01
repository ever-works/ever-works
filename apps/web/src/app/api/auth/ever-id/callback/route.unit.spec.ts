import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 T23 — the redirect URI registered at the provider (plan §6.3).
 *
 * Pinned, for every outcome and every error:
 *
 *  - the outcome table: session cookie + return path, or pending cookie + the
 *    matching confirmation screen, or the error destination for the intent;
 *  - the transaction and intent cookies are cleared on EVERY path (FR-9);
 *  - no address the route builds carries the code, the `state`, the session
 *    token, the API's sealed values or an e-mail address (FR-16, NFR-9);
 *  - the local-client hand-off (`/api/auth/authorize`, `addSessionTokenToUrl`)
 *    gains no caller here.
 *
 * The cookie module is the real one, over an in-memory jar, so "cleared" means
 * a delete was actually written.
 */

const jar = vi.hoisted(() => {
    const values = new Map<string, string>();
    const deletes: string[] = [];
    return {
        values,
        deletes,
        reset() {
            values.clear();
            deletes.length = 0;
        },
        store: {
            get: (name: string) =>
                values.has(name) ? { name, value: values.get(name)! } : undefined,
            set: (name: string, value: string) => {
                values.set(name, value);
            },
            delete: (arg: string | { name: string }) => {
                const name = typeof arg === 'string' ? arg : arg.name;
                deletes.push(name);
                values.delete(name);
            },
        },
    };
});

const { callbackMock, setAuthCookiesMock, redirectMock } = vi.hoisted(() => ({
    callbackMock: vi.fn(),
    setAuthCookiesMock: vi.fn(),
    redirectMock: vi.fn(),
}));

vi.mock('next/headers', () => ({
    cookies: async () => jar.store,
    headers: async () => new Headers(),
}));
vi.mock('next-intl/server', () => ({
    getLocale: async () => 'en',
    getTranslations: async () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/auth', () => ({ setAuthCookies: setAuthCookiesMock }));
vi.mock('@/lib/api/ever-id', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api/ever-id')>();
    return { ...actual, everIdAPI: { ...actual.everIdAPI, callback: callbackMock } };
});

const SECRETS = {
    code: 'auth-code-SECRET',
    state: 'state-SECRET',
    transaction: 'sealed-transaction-SECRET',
    accessToken: 'session-token-SECRET',
    pending: 'sealed-pending-SECRET',
    email: 'alice@example.com',
    accountEmail: 'bob@example.com',
};

function request(params: Record<string, string>) {
    const url = new URL('https://app.example/api/auth/ever-id/callback');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { nextUrl: url } as unknown as import('next/server').NextRequest;
}

const PROVIDER_ANSWER = { code: SECRETS.code, state: SECRETS.state };

function startedWith(intent: 'sign-in' | 'connect' | null) {
    jar.values.set('ew_everid_txn', SECRETS.transaction);
    if (intent) jar.values.set('ew_everid_intent', intent);
}

async function run(params: Record<string, string>) {
    const { GET } = await import('./route');
    await GET(request(params));
    expect(redirectMock).toHaveBeenCalledTimes(1);
    const href: string = redirectMock.mock.calls[0][0].href;
    return { href, url: new URL(href, 'https://app.example') };
}

/** The address carries none of the flow's secrets, nor an e-mail address. */
function expectNoSecrets(href: string) {
    const decoded = decodeURIComponent(href);
    for (const secret of Object.values(SECRETS)) {
        expect(decoded).not.toContain(secret);
    }
    expect(decoded).not.toMatch(/@/);
}

/** FR-9: both transaction cookies were cleared, whatever happened. */
function expectTransactionCleared() {
    expect(jar.deletes).toEqual(expect.arrayContaining(['ew_everid_txn', 'ew_everid_intent']));
    expect(jar.values.has('ew_everid_txn')).toBe(false);
    expect(jar.values.has('ew_everid_intent')).toBe(false);
}

const ORIGINAL_ENV = { ...process.env };

describe('GET /api/auth/ever-id/callback — outcomes (plan §6.3)', () => {
    beforeEach(() => {
        jar.reset();
        callbackMock.mockReset();
        setAuthCookiesMock.mockReset();
        redirectMock.mockReset();
        process.env = {
            ...ORIGINAL_ENV,
            COOKIE_SECRET: 'k'.repeat(48),
            WEB_URL: 'https://app.example',
        };
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    it('signedIn: sets the session cookie and lands on the validated return path', async () => {
        startedWith('sign-in');
        callbackMock.mockResolvedValue({
            outcome: 'signedIn',
            access_token: SECRETS.accessToken,
            user: { id: 'u1', email: SECRETS.email, username: 'alice' },
            returnTo: '/works/42',
        });

        const { href } = await run(PROVIDER_ANSWER);

        expect(callbackMock).toHaveBeenCalledWith({
            code: SECRETS.code,
            state: SECRETS.state,
            transaction: SECRETS.transaction,
        });
        expect(setAuthCookiesMock).toHaveBeenCalledWith(SECRETS.accessToken);
        expect(href).toBe('/works/42');
        expectTransactionCleared();
        expectNoSecrets(href);
    });

    it('signedIn: a return path to another site falls back to the dashboard (ACC-12-12)', async () => {
        startedWith('sign-in');
        callbackMock.mockResolvedValue({
            outcome: 'signedIn',
            access_token: SECRETS.accessToken,
            user: { id: 'u1', email: null, username: 'alice' },
            returnTo: 'https://evil.example/phish',
        });

        const { href } = await run(PROVIDER_ANSWER);

        expect(href).toBe('/');
    });

    it('signedIn: spends the stored relative destination it lands on', async () => {
        startedWith('sign-in');
        jar.values.set('redirect_url', '/org-invite/tok');
        callbackMock.mockResolvedValue({
            outcome: 'signedIn',
            access_token: SECRETS.accessToken,
            user: { id: 'u1', email: null, username: 'alice' },
            returnTo: '/org-invite/tok',
        });

        const { href } = await run(PROVIDER_ANSWER);

        expect(href).toBe('/org-invite/tok');
        expect(jar.values.has('redirect_url')).toBe(false);
    });

    it('forwards the provider’s `iss` when it sent one (FR-12)', async () => {
        startedWith('sign-in');
        callbackMock.mockResolvedValue({
            outcome: 'signedIn',
            access_token: SECRETS.accessToken,
            user: { id: 'u1', email: null, username: 'a' },
            returnTo: null,
        });

        await run({ ...PROVIDER_ANSWER, iss: 'https://id.example' });

        expect(callbackMock.mock.calls[0][0]).toMatchObject({ iss: 'https://id.example' });
    });

    it('confirmSignUp: stores the pending value and opens the create-account screen', async () => {
        startedWith('sign-in');
        callbackMock.mockResolvedValue({
            outcome: 'confirmSignUp',
            pending: SECRETS.pending,
            identity: { email: SECRETS.email, name: 'Alice Martin' },
            returnTo: null,
        });

        const { href } = await run(PROVIDER_ANSWER);

        expect(href).toBe('/auth/ever-id/create-account');
        expect(setAuthCookiesMock).not.toHaveBeenCalled();
        const { readEverIdPending } = await import('@/lib/auth/ever-id-cookies');
        await expect(readEverIdPending('signUp')).resolves.toEqual({
            kind: 'signUp',
            pending: SECRETS.pending,
            email: SECRETS.email,
            name: 'Alice Martin',
            accountEmail: null,
        });
        expectTransactionCleared();
        expectNoSecrets(href);
    });

    it('confirmConnect: stores both addresses and opens the connect confirmation', async () => {
        startedWith('connect');
        callbackMock.mockResolvedValue({
            outcome: 'confirmConnect',
            pending: SECRETS.pending,
            identity: { email: SECRETS.email },
            accountEmail: SECRETS.accountEmail,
        });

        const { href } = await run(PROVIDER_ANSWER);

        expect(href).toBe('/settings/security/connect-ever-id');
        const { readEverIdPending } = await import('@/lib/auth/ever-id-cookies');
        await expect(readEverIdPending('connect')).resolves.toMatchObject({
            email: SECRETS.email,
            accountEmail: SECRETS.accountEmail,
        });
        expectTransactionCleared();
        expectNoSecrets(href);
    });

    it('emailInUse: the address travels in the pending cookie, never in the address (S3)', async () => {
        startedWith('sign-in');
        callbackMock.mockResolvedValue({
            outcome: 'emailInUse',
            email: SECRETS.email,
            pending: SECRETS.pending,
        });

        const { href } = await run(PROVIDER_ANSWER);

        expect(href).toBe('/auth/ever-id/account-exists');
        const { readEverIdPending } = await import('@/lib/auth/ever-id-cookies');
        await expect(readEverIdPending('emailInUse')).resolves.toMatchObject({
            email: SECRETS.email,
        });
        expectTransactionCleared();
        expectNoSecrets(href);
    });

    it('an answer with an unknown outcome is treated as an invalid sign-in', async () => {
        startedWith('sign-in');
        callbackMock.mockResolvedValue({ outcome: 'somethingNew' });

        const { url } = await run(PROVIDER_ANSWER);

        expect(url.searchParams.get('error')).toBe('ever_id_transaction_invalid');
    });
});

describe('GET /api/auth/ever-id/callback — errors go where the intent says', () => {
    beforeEach(() => {
        jar.reset();
        callbackMock.mockReset();
        setAuthCookiesMock.mockReset();
        redirectMock.mockReset();
        process.env = {
            ...ORIGINAL_ENV,
            COOKIE_SECRET: 'k'.repeat(48),
            WEB_URL: 'https://app.example',
        };
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.resetModules();
        vi.restoreAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    async function refusal(
        status: number,
        code: string | null,
        headers: Record<string, string> = {},
    ) {
        const { EverIdRequestError } = await import('@/lib/api/ever-id');
        return new EverIdRequestError(
            status,
            code,
            headers['Retry-After'] ? Number(headers['Retry-After']) : null,
        );
    }

    it.each([
        ['transaction_invalid', 400],
        ['email_not_verified', 422],
        ['sign_up_not_allowed', 403],
        ['subject_linked', 409],
        ['account_disabled', 403],
        ['ever_id_disabled', 404],
        ['provider_unavailable', 503],
    ])('sign-in intent: %s → /auth/error?error=ever_id_%s', async (code, status) => {
        startedWith('sign-in');
        callbackMock.mockRejectedValue(await refusal(status, code));

        const { href, url } = await run(PROVIDER_ANSWER);

        expect(url.pathname).toBe('/auth/error');
        expect(url.searchParams.get('error')).toBe(`ever_id_${code}`);
        expect(setAuthCookiesMock).not.toHaveBeenCalled();
        expectTransactionCleared();
        expectNoSecrets(href);
    });

    it.each([
        ['reauth_required', 403],
        ['user_has_issuer', 409],
        ['subject_linked', 409],
        ['session_required', 403],
    ])('connect intent: %s → /settings/security?everId=%s', async (code, status) => {
        startedWith('connect');
        callbackMock.mockRejectedValue(await refusal(status, code));

        const { href, url } = await run(PROVIDER_ANSWER);

        expect(url.pathname).toBe('/settings/security');
        expect(url.searchParams.get('everId')).toBe(code);
        expectTransactionCleared();
        expectNoSecrets(href);
    });

    it('a rate limit carries the wait, and nothing else', async () => {
        startedWith('sign-in');
        callbackMock.mockRejectedValue(await refusal(429, null, { 'Retry-After': '25' }));

        const { url } = await run(PROVIDER_ANSWER);

        expect(url.searchParams.get('error')).toBe('ever_id_rate_limited');
        expect(url.searchParams.get('retryAfter')).toBe('25');
    });

    it('an unreachable API reads as the provider not responding (S16)', async () => {
        startedWith('sign-in');
        callbackMock.mockRejectedValue(new TypeError('fetch failed'));

        const { url } = await run(PROVIDER_ANSWER);

        expect(url.searchParams.get('error')).toBe('ever_id_provider_unavailable');
    });

    it('a person who declines at Ever ID goes back to sign-in quietly', async () => {
        startedWith('sign-in');

        const { href } = await run({ error: 'access_denied', state: SECRETS.state });

        expect(href).toBe('/login');
        expect(callbackMock).not.toHaveBeenCalled();
        expectTransactionCleared();
    });

    it('a person who declines while connecting goes back to Settings quietly', async () => {
        startedWith('connect');

        const { href } = await run({ error: 'access_denied' });

        expect(href).toBe('/settings/security');
        expect(callbackMock).not.toHaveBeenCalled();
    });

    it('any other provider error is an invalid sign-in, with nothing echoed back', async () => {
        startedWith('sign-in');

        const { href, url } = await run({
            error: 'server_error',
            error_description: 'alice@example.com could not',
        });

        expect(url.searchParams.get('error')).toBe('ever_id_transaction_invalid');
        expectNoSecrets(href);
        expect(callbackMock).not.toHaveBeenCalled();
    });

    it.each([
        ['no code', { state: SECRETS.state }],
        ['no state', { code: SECRETS.code }],
    ])('%s → an invalid sign-in, and the API is not called', async (_label, params) => {
        startedWith('sign-in');

        const { url } = await run(params);

        expect(url.searchParams.get('error')).toBe('ever_id_transaction_invalid');
        expect(callbackMock).not.toHaveBeenCalled();
        expectTransactionCleared();
    });

    it('no transaction cookie (replayed, expired or foreign callback) → S17, API not called', async () => {
        const { url } = await run(PROVIDER_ANSWER);

        expect(url.searchParams.get('error')).toBe('ever_id_transaction_invalid');
        expect(callbackMock).not.toHaveBeenCalled();
        expectTransactionCleared();
    });

    it('a missing intent cookie reports to the auth error page', async () => {
        startedWith(null);
        callbackMock.mockRejectedValue(await refusal(409, 'subject_linked'));

        const { url } = await run(PROVIDER_ANSWER);

        expect(url.pathname).toBe('/auth/error');
    });
});

describe('the local-client hand-off gains no caller (T23 done-when)', () => {
    it('the route never reaches the hand-off route or the token-stitching helpers', () => {
        const source = readFileSync(join(__dirname, 'route.ts'), 'utf8');
        expect(source).not.toMatch(/addSessionTokenToUrl/);
        expect(source).not.toMatch(/getRedirectUrl/);
        expect(source).not.toMatch(/api\/auth\/authorize/);
    });
});
