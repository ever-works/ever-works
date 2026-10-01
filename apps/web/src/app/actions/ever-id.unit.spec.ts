import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 T22 — the Ever ID server actions.
 *
 * Pinned across the file:
 *
 *  - `startEverIdSignIn` forwards only a same-site relative return path
 *    (ACC-12-12 web half) and never an absolute stored destination;
 *  - "Also sign out of Ever ID" asks the API for the end-session address before
 *    the session ends, signs out exactly as `logout()` does, remembers the
 *    `state` in `ew_everid_logout_state` and follows the address from the API —
 *    never one from the browser (ACC-12-26 web half);
 *  - `confirmEverIdSignUp` posts the terms claims as displayed;
 *  - no action ever returns an upstream message verbatim.
 */

const mocks = vi.hoisted(() => ({
    // Like Next's `redirect`, it throws, so nothing after it runs.
    redirect: vi.fn(),
    revalidatePath: vi.fn(),
    logout: vi.fn(),
    authorize: vi.fn(),
    confirmSignUp: vi.fn(),
    connectAuthorize: vi.fn(),
    connectConfirm: vi.fn(),
    disconnect: vi.fn(),
    logoutUrl: vi.fn(),
    adminTest: vi.fn(),
    adminEnable: vi.fn(),
    adminDisable: vi.fn(),
    adminSettings: vi.fn(),
    setAuthCookies: vi.fn(),
    removeAuthAccessCookies: vi.fn(),
    getRedirectCookie: vi.fn(),
    setEverIdTransaction: vi.fn(),
    readEverIdPending: vi.fn(),
    clearEverIdPending: vi.fn(),
    setEverIdLogoutState: vi.fn(),
    calls: [] as string[],
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next-intl/server', () => ({
    getTranslations:
        async (namespace: string) => (key: string, values?: Record<string, unknown>) =>
            values ? `${namespace}.${key}:${JSON.stringify(values)}` : `${namespace}.${key}`,
}));
vi.mock('@/lib/api', () => ({ authAPI: { logout: mocks.logout } }));
vi.mock('@/lib/api/ever-id', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api/ever-id')>();
    return {
        ...actual,
        everIdAPI: {
            authorize: mocks.authorize,
            confirmSignUp: mocks.confirmSignUp,
            connectAuthorize: mocks.connectAuthorize,
            connectConfirm: mocks.connectConfirm,
            disconnect: mocks.disconnect,
            logoutUrl: mocks.logoutUrl,
            adminTest: mocks.adminTest,
            adminEnable: mocks.adminEnable,
            adminDisable: mocks.adminDisable,
            adminSettings: mocks.adminSettings,
        },
    };
});
vi.mock('@/lib/auth', () => ({
    setAuthCookies: mocks.setAuthCookies,
    removeAuthAccessCookies: mocks.removeAuthAccessCookies,
    getRedirectCookie: mocks.getRedirectCookie,
}));
vi.mock('@/lib/auth/ever-id-cookies', async () => {
    const { toEverIdReturnTo } = await import('@/lib/auth/ever-id');
    return {
        setEverIdTransaction: mocks.setEverIdTransaction,
        readEverIdPending: mocks.readEverIdPending,
        clearEverIdPending: mocks.clearEverIdPending,
        setEverIdLogoutState: mocks.setEverIdLogoutState,
        resolveEverIdReturnTo: async (returnTo: string | null, fallback: string) =>
            toEverIdReturnTo(returnTo) ?? fallback,
    };
});

async function load() {
    return import('./ever-id');
}

/** Run an action that is expected to redirect; answers the address it redirected to. */
async function redirectOf(action: () => Promise<unknown>): Promise<string> {
    const error = await action().then(
        () => {
            throw new Error('expected a redirect');
        },
        (caught: unknown) => caught,
    );
    expect((error as Error).message).toMatch(/^NEXT_REDIRECT /);
    return (error as { url: string }).url;
}

async function refusal(status: number, code: string | null, retryAfter: number | null = null) {
    const { EverIdRequestError } = await import('@/lib/api/ever-id');
    return new EverIdRequestError(status, code, retryAfter, {
        status: 'error',
        code,
        message: 'UPSTREAM-DETAIL that must never reach a person',
    });
}

const PROVIDER_URL = 'https://id.example/oauth/v2/authorize?client_id=c&state=s';

beforeEach(() => {
    for (const fn of Object.values(mocks)) {
        if (typeof fn === 'function' && 'mockReset' in fn)
            (fn as ReturnType<typeof vi.fn>).mockReset();
    }
    mocks.redirect.mockImplementation((url: string) => {
        throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { url });
    });
    mocks.calls.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('startEverIdSignIn', () => {
    it('forwards a relative return path, remembers the transaction, and goes to Ever ID', async () => {
        mocks.authorize.mockResolvedValue({ authorizationUrl: PROVIDER_URL, transaction: 'txn' });
        const { startEverIdSignIn } = await load();

        const url = await redirectOf(() => startEverIdSignIn('/works/42'));

        expect(mocks.authorize).toHaveBeenCalledWith({ returnTo: '/works/42' });
        expect(mocks.setEverIdTransaction).toHaveBeenCalledWith('txn', 'sign-in');
        expect(url).toBe(PROVIDER_URL);
    });

    it.each(['https://evil.example/phish', '//evil.example', 'javascript:alert(1)'])(
        'rejects the absolute return path %s (ACC-12-12)',
        async (returnTo) => {
            mocks.authorize.mockResolvedValue({ authorizationUrl: PROVIDER_URL, transaction: 't' });
            const { startEverIdSignIn } = await load();

            await redirectOf(() => startEverIdSignIn(returnTo));

            expect(mocks.authorize).toHaveBeenCalledWith({});
        },
    );

    it('falls back to a stored relative destination (an invitation), never an absolute one', async () => {
        mocks.authorize.mockResolvedValue({ authorizationUrl: PROVIDER_URL, transaction: 't' });
        const { startEverIdSignIn } = await load();

        mocks.getRedirectCookie.mockResolvedValue('/org-invite/tok');
        await redirectOf(() => startEverIdSignIn(null));
        expect(mocks.authorize).toHaveBeenLastCalledWith({ returnTo: '/org-invite/tok' });

        mocks.getRedirectCookie.mockResolvedValue('http://localhost:44663/callback');
        await redirectOf(() => startEverIdSignIn(null));
        expect(mocks.authorize).toHaveBeenLastCalledWith({});
    });

    it('reports Ever ID being turned off with translated copy, not the upstream text', async () => {
        mocks.authorize.mockRejectedValue(await refusal(404, 'ever_id_disabled'));
        const { startEverIdSignIn } = await load();

        const result = await startEverIdSignIn();

        expect(result).toEqual({
            success: false,
            error: 'auth.error.everId.everIdDisabled',
            code: 'ever_id_disabled',
        });
        expect(JSON.stringify(result)).not.toContain('UPSTREAM-DETAIL');
        expect(mocks.setEverIdTransaction).not.toHaveBeenCalled();
        expect(mocks.redirect).not.toHaveBeenCalled();
    });

    it('reports a rate limit with its wait', async () => {
        mocks.authorize.mockRejectedValue(await refusal(429, null, 12));
        const { startEverIdSignIn } = await load();

        const result = await startEverIdSignIn();

        expect(result).toMatchObject({
            success: false,
            code: 'rate_limited',
            error: 'auth.error.everId.rateLimited:{"seconds":12}',
        });
    });

    it('refuses an answer whose address is not http(s), and sets no cookie', async () => {
        mocks.authorize.mockResolvedValue({
            authorizationUrl: 'javascript:alert(1)',
            transaction: 't',
        });
        const { startEverIdSignIn } = await load();

        const result = await startEverIdSignIn();

        expect(result).toMatchObject({ success: false, code: 'provider_unavailable' });
        expect(mocks.setEverIdTransaction).not.toHaveBeenCalled();
    });
});

describe('confirmEverIdSignUp', () => {
    const TERMS = [
        { documentId: 'tos:default', version: '2026-01-01', sha256: 'a'.repeat(64), locale: 'en' },
        {
            documentId: 'privacy:default',
            version: '2026-01-01',
            sha256: 'b'.repeat(64),
            locale: 'en',
        },
    ];
    const PENDING = {
        kind: 'signUp',
        pending: 'sealed',
        email: 'alice@example.com',
        name: 'Alice',
        accountEmail: null,
    };

    it('posts the pending value and the terms claims as displayed, then signs in', async () => {
        mocks.readEverIdPending.mockResolvedValue(PENDING);
        mocks.confirmSignUp.mockResolvedValue({
            access_token: 'session',
            user: { id: 'u', email: 'alice@example.com', username: 'alice' },
            returnTo: null,
        });
        const { confirmEverIdSignUp } = await load();

        const url = await redirectOf(() => confirmEverIdSignUp(TERMS));

        expect(mocks.readEverIdPending).toHaveBeenCalledWith('signUp');
        expect(mocks.confirmSignUp).toHaveBeenCalledWith({ pending: 'sealed', terms: TERMS });
        expect(mocks.clearEverIdPending).toHaveBeenCalled();
        expect(mocks.setAuthCookies).toHaveBeenCalledWith('session');
        // A new account lands where `register` sends one.
        expect(url).toBe('/?newUser=true');
    });

    it('lands on the validated return path the API echoed back', async () => {
        mocks.readEverIdPending.mockResolvedValue(PENDING);
        mocks.confirmSignUp.mockResolvedValue({
            access_token: 'session',
            user: { id: 'u', email: null, username: 'a' },
            returnTo: '/org-invite/tok',
        });
        const { confirmEverIdSignUp } = await load();

        await expect(redirectOf(() => confirmEverIdSignUp(TERMS))).resolves.toBe('/org-invite/tok');
    });

    it('refuses without terms and never calls the API', async () => {
        mocks.readEverIdPending.mockResolvedValue(PENDING);
        const { confirmEverIdSignUp } = await load();

        const result = await confirmEverIdSignUp([]);

        expect(result).toEqual({
            success: false,
            error: 'auth.everId.consentRequired',
            code: 'terms_required',
        });
        expect(mocks.confirmSignUp).not.toHaveBeenCalled();
    });

    it('says "That took too long" when there is no pending value', async () => {
        mocks.readEverIdPending.mockResolvedValue(null);
        const { confirmEverIdSignUp } = await load();

        await expect(confirmEverIdSignUp(TERMS)).resolves.toEqual({
            success: false,
            error: 'auth.everId.pendingExpired',
            code: 'pending_expired',
        });
    });

    it('treats an expired or used pending value as gone, and forgets it', async () => {
        mocks.readEverIdPending.mockResolvedValue(PENDING);
        mocks.confirmSignUp.mockRejectedValue(await refusal(400, 'transaction_invalid'));
        const { confirmEverIdSignUp } = await load();

        await expect(confirmEverIdSignUp(TERMS)).resolves.toMatchObject({
            code: 'pending_expired',
        });
        expect(mocks.clearEverIdPending).toHaveBeenCalled();
        expect(mocks.setAuthCookies).not.toHaveBeenCalled();
    });

    it('keeps the pending value for a retryable refusal', async () => {
        mocks.readEverIdPending.mockResolvedValue(PENDING);
        mocks.confirmSignUp.mockRejectedValue(await refusal(429, null, 5));
        const { confirmEverIdSignUp } = await load();

        await expect(confirmEverIdSignUp(TERMS)).resolves.toMatchObject({ code: 'rate_limited' });
        expect(mocks.clearEverIdPending).not.toHaveBeenCalled();
    });

    it('keeps the pending value when the API asks for the current terms', async () => {
        mocks.readEverIdPending.mockResolvedValue(PENDING);
        mocks.confirmSignUp.mockRejectedValue(await refusal(400, 'terms_required'));
        const { confirmEverIdSignUp } = await load();

        await expect(confirmEverIdSignUp(TERMS)).resolves.toEqual({
            success: false,
            error: 'auth.everId.termsChanged',
            code: 'terms_required',
        });
        expect(mocks.clearEverIdPending).not.toHaveBeenCalled();
    });

    it('translates a terminal refusal, forgets the pending value, and leaks nothing upstream', async () => {
        mocks.readEverIdPending.mockResolvedValue(PENDING);
        mocks.confirmSignUp.mockRejectedValue(await refusal(403, 'sign_up_not_allowed'));
        const { confirmEverIdSignUp } = await load();

        const result = await confirmEverIdSignUp(TERMS);

        expect(result).toEqual({
            success: false,
            error: 'auth.error.everId.signUpNotAllowed',
            code: 'sign_up_not_allowed',
        });
        expect(JSON.stringify(result)).not.toContain('UPSTREAM-DETAIL');
        expect(mocks.clearEverIdPending).toHaveBeenCalled();
    });

    it('cancel forgets the pending value and goes back to sign-in (nothing is created)', async () => {
        const { cancelEverIdSignUp } = await load();

        const url = await redirectOf(() => cancelEverIdSignUp());

        expect(mocks.clearEverIdPending).toHaveBeenCalled();
        expect(mocks.confirmSignUp).not.toHaveBeenCalled();
        expect(url).toBe('/login');
    });
});

describe('connect and disconnect', () => {
    it('startEverIdConnect remembers a connect transaction and goes to Ever ID', async () => {
        mocks.connectAuthorize.mockResolvedValue({
            authorizationUrl: PROVIDER_URL,
            transaction: 'tx',
        });
        const { startEverIdConnect } = await load();

        const url = await redirectOf(() => startEverIdConnect());

        expect(mocks.setEverIdTransaction).toHaveBeenCalledWith('tx', 'connect');
        expect(url).toBe(PROVIDER_URL);
    });

    it('a session older than 12 hours is reported as reauth_required with the S15 copy', async () => {
        mocks.connectAuthorize.mockRejectedValue(await refusal(403, 'reauth_required'));
        const { startEverIdConnect } = await load();

        await expect(startEverIdConnect()).resolves.toEqual({
            success: false,
            error: 'auth.error.everId.reauthRequired',
            code: 'reauth_required',
        });
    });

    it('confirmEverIdConnect connects, forgets the pending value and returns with the toast', async () => {
        mocks.readEverIdPending.mockResolvedValue({ kind: 'connect', pending: 'sealed' });
        mocks.connectConfirm.mockResolvedValue({ id: 'i1' });
        const { confirmEverIdConnect } = await load();

        const url = await redirectOf(() => confirmEverIdConnect());

        expect(mocks.readEverIdPending).toHaveBeenCalledWith('connect');
        expect(mocks.connectConfirm).toHaveBeenCalledWith({ pending: 'sealed' });
        expect(mocks.clearEverIdPending).toHaveBeenCalled();
        expect(url).toBe('/settings/security?everId=connected');
    });

    it('a conflict is described without naming the other account (S12)', async () => {
        mocks.readEverIdPending.mockResolvedValue({ kind: 'connect', pending: 'sealed' });
        mocks.connectConfirm.mockRejectedValue(await refusal(409, 'subject_linked'));
        const { confirmEverIdConnect } = await load();

        const result = await confirmEverIdConnect();

        expect(result).toEqual({
            success: false,
            error: 'auth.error.everId.subjectLinked',
            code: 'subject_linked',
        });
        expect(mocks.clearEverIdPending).toHaveBeenCalled();
    });

    it('cancelEverIdConnect forgets the pending value and returns to Settings', async () => {
        const { cancelEverIdConnect } = await load();

        await expect(redirectOf(() => cancelEverIdConnect())).resolves.toBe('/settings/security');
        expect(mocks.clearEverIdPending).toHaveBeenCalled();
        expect(mocks.connectConfirm).not.toHaveBeenCalled();
    });

    it('disconnectEverId disconnects and refreshes the Security page', async () => {
        mocks.disconnect.mockResolvedValue(undefined);
        const { disconnectEverId } = await load();

        await expect(disconnectEverId('0d6b5f9e-1c2a-4f1e-9a51-1a2b3c4d5e6f')).resolves.toEqual({
            success: true,
        });
        expect(mocks.disconnect).toHaveBeenCalledWith('0d6b5f9e-1c2a-4f1e-9a51-1a2b3c4d5e6f');
        expect(mocks.revalidatePath).toHaveBeenCalledWith('/settings/security');
    });

    it('the S14 refusal carries the "add another way to sign in" copy', async () => {
        mocks.disconnect.mockRejectedValue(await refusal(409, 'last_sign_in_method'));
        const { disconnectEverId } = await load();

        await expect(disconnectEverId('id-1')).resolves.toMatchObject({
            success: false,
            error: 'auth.error.everId.lastSignInMethod',
        });
    });

    it('an unexplained refusal (already gone) asks for a reload', async () => {
        mocks.disconnect.mockRejectedValue(await refusal(404, null));
        const { disconnectEverId } = await load();

        await expect(disconnectEverId('id-1')).resolves.toMatchObject({
            success: false,
            error: 'dashboard.settings.security.connectedIdentities.disconnectFailed',
        });
    });

    it('an id that is not an identity id never reaches the API', async () => {
        const { disconnectEverId } = await load();

        await expect(disconnectEverId('../../users/me')).resolves.toMatchObject({ success: false });
        expect(mocks.disconnect).not.toHaveBeenCalled();
    });

    it('"Sign in again" ends the session and returns to Settings after signing in', async () => {
        const { signInAgainToConnectEverId } = await load();

        const url = await redirectOf(() => signInAgainToConnectEverId());

        expect(mocks.logout).toHaveBeenCalled();
        expect(mocks.removeAuthAccessCookies).toHaveBeenCalled();
        expect(url).toBe('/login?redirect_uri=%2Fsettings%2Fsecurity');
    });
});

describe('sign-out (S7)', () => {
    it('getEverIdLogoutUrl answers the provider address for a session opened with Ever ID', async () => {
        mocks.logoutUrl.mockResolvedValue({ url: 'https://id.example/end?state=x', state: 'x' });
        const { getEverIdLogoutUrl } = await load();

        await expect(getEverIdLogoutUrl()).resolves.toBe('https://id.example/end?state=x');
    });

    it.each([
        ['a 404 (not opened with Ever ID)', () => refusal(404, null)],
        ['a 401', () => refusal(401, null)],
        ['a transport failure', async () => new TypeError('fetch failed')],
    ])('getEverIdLogoutUrl answers null on %s', async (_label, makeError) => {
        mocks.logoutUrl.mockRejectedValue(await makeError());
        const { getEverIdLogoutUrl } = await load();

        await expect(getEverIdLogoutUrl()).resolves.toBeNull();
    });

    it('getEverIdLogoutUrl answers null for an address that is not http(s)', async () => {
        mocks.logoutUrl.mockResolvedValue({ url: 'javascript:alert(1)', state: 'x' });
        const { getEverIdLogoutUrl } = await load();

        await expect(getEverIdLogoutUrl()).resolves.toBeNull();
    });

    it('ticked: asks for the address first, signs out like logout(), remembers the state, follows the address (ACC-12-26)', async () => {
        mocks.logoutUrl.mockImplementation(async () => {
            mocks.calls.push('logoutUrl');
            return { url: 'https://id.example/end?state=st-1', state: 'st-1' };
        });
        mocks.logout.mockImplementation(async () => {
            mocks.calls.push('logout');
        });
        mocks.removeAuthAccessCookies.mockImplementation(async () => {
            mocks.calls.push('removeAuthAccessCookies');
        });
        mocks.setEverIdLogoutState.mockImplementation(async () => {
            mocks.calls.push('setEverIdLogoutState');
        });
        const { logoutWithEverId } = await load();

        const url = await redirectOf(() => logoutWithEverId());

        expect(mocks.calls).toEqual([
            'logoutUrl',
            'logout',
            'removeAuthAccessCookies',
            'setEverIdLogoutState',
        ]);
        expect(mocks.setEverIdLogoutState).toHaveBeenCalledWith('st-1');
        expect(url).toBe('https://id.example/end?state=st-1');
    });

    it('ticked, but the address is unavailable: still signs out of Ever Works and lands on sign-in', async () => {
        mocks.logoutUrl.mockRejectedValue(await refusal(404, null));
        const { logoutWithEverId } = await load();

        const url = await redirectOf(() => logoutWithEverId());

        expect(mocks.logout).toHaveBeenCalled();
        expect(mocks.removeAuthAccessCookies).toHaveBeenCalled();
        expect(mocks.setEverIdLogoutState).not.toHaveBeenCalled();
        expect(url).toBe('/login');
    });

    it('ticked: a sign-out failure upstream still clears the cookie (as logout() does)', async () => {
        mocks.logoutUrl.mockResolvedValue({ url: 'https://id.example/end', state: 's' });
        mocks.logout.mockRejectedValue(new Error('api down'));
        const { logoutWithEverId } = await load();

        await redirectOf(() => logoutWithEverId());

        expect(mocks.removeAuthAccessCookies).toHaveBeenCalled();
    });

    it('takes no argument: the provider address can never come from the browser', async () => {
        const { logoutWithEverId } = await load();
        expect(logoutWithEverId.length).toBe(0);
    });
});

describe('administrator surface (T51)', () => {
    it('testEverIdConnection returns one row per known check id', async () => {
        mocks.adminTest.mockResolvedValue([
            { id: 'discovery', ok: true },
            { id: 'pkceS256', ok: false, detail: 'secret-like detail' },
            { id: 'made-up', ok: true },
        ]);
        const { testEverIdConnection } = await load();

        await expect(testEverIdConnection()).resolves.toEqual({
            success: true,
            checks: [
                { id: 'discovery', ok: true },
                { id: 'pkceS256', ok: false },
            ],
        });
    });

    it('testEverIdConnection translates a failure to run', async () => {
        mocks.adminTest.mockRejectedValue(new TypeError('fetch failed'));
        const { testEverIdConnection } = await load();

        await expect(testEverIdConnection()).resolves.toEqual({
            success: false,
            error: 'dashboard.settings.admin.everId.testFailed',
        });
    });

    it('enableEverId reports a failed required check with its rows', async () => {
        const { EverIdRequestError } = await import('@/lib/api/ever-id');
        mocks.adminEnable.mockRejectedValue(
            new EverIdRequestError(409, 'connection_test_failed', null, {
                code: 'connection_test_failed',
                checks: [{ id: 'issuerMatch', ok: false }],
            }),
        );
        const { enableEverId } = await load();

        await expect(enableEverId()).resolves.toEqual({
            success: false,
            error: 'dashboard.settings.admin.everId.enableBlocked',
            checks: [{ id: 'issuerMatch', ok: false }],
        });
    });

    it('enableEverId / disableEverId answer the new status', async () => {
        const status = { enabled: true } as never;
        mocks.adminEnable.mockResolvedValue(status);
        mocks.adminDisable.mockResolvedValue({ enabled: false });
        const { enableEverId, disableEverId } = await load();

        await expect(enableEverId()).resolves.toEqual({ success: true, status });
        await expect(disableEverId()).resolves.toEqual({
            success: true,
            status: { enabled: false },
        });
    });

    it('disableEverId translates a failure', async () => {
        mocks.adminDisable.mockRejectedValue(await refusal(404, null));
        const { disableEverId } = await load();

        await expect(disableEverId()).resolves.toEqual({
            success: false,
            error: 'dashboard.settings.admin.everId.actionFailed',
        });
    });

    it('enable and disable refresh the administrator page', async () => {
        mocks.adminEnable.mockResolvedValue({ enabled: true });
        mocks.adminDisable.mockResolvedValue({ enabled: false });
        const { enableEverId, disableEverId } = await load();

        await enableEverId();
        await disableEverId();

        expect(mocks.revalidatePath).toHaveBeenNthCalledWith(1, '/settings/admin/ever-id');
        expect(mocks.revalidatePath).toHaveBeenNthCalledWith(2, '/settings/admin/ever-id');
    });
});

describe('saveEverIdSettings (administrator settings)', () => {
    const SETTINGS_ERRORS = 'dashboard.settings.admin.everId.settings';

    it('sends the trimmed values and answers the new status', async () => {
        const status = { enabled: true, displayName: 'Ever ID Staging' } as never;
        mocks.adminSettings.mockResolvedValue(status);
        const { saveEverIdSettings } = await load();

        await expect(
            saveEverIdSettings({
                displayName: '  Ever ID Staging ',
                accountManagementUrl: ' https://id.example/account ',
                localClients: [{ kind: 'node', clientId: ' ever-works-node ' }],
                delegatedClientNames: [{ clientId: 'reports', displayName: ' Reports ' }],
            }),
        ).resolves.toEqual({ success: true, status });

        expect(mocks.adminSettings).toHaveBeenCalledWith({
            displayName: 'Ever ID Staging',
            accountManagementUrl: 'https://id.example/account',
            localClients: [{ kind: 'node', clientId: 'ever-works-node' }],
            delegatedClientNames: [{ clientId: 'reports', displayName: 'Reports' }],
        });
        expect(mocks.revalidatePath).toHaveBeenCalledWith('/settings/admin/ever-id');
    });

    it('forwards a subset as it is, and null to clear the account address', async () => {
        mocks.adminSettings.mockResolvedValue({ enabled: true });
        const { saveEverIdSettings } = await load();

        await saveEverIdSettings({ accountManagementUrl: null });

        expect(mocks.adminSettings).toHaveBeenCalledWith({ accountManagementUrl: null });
    });

    it.each([
        ['an empty display name', { displayName: '   ' }],
        ['a display name over 40 characters', { displayName: 'x'.repeat(41) }],
        ['an http address', { accountManagementUrl: 'http://id.example/account' }],
        ['an address with a space', { accountManagementUrl: 'https://id.example/my account' }],
        [
            'an address over 2,048 characters',
            { accountManagementUrl: `https://id.example/${'a'.repeat(2048)}` },
        ],
        [
            'six terminal clients',
            {
                localClients: Array.from({ length: 6 }, (_, i) => ({
                    kind: 'cli',
                    clientId: `c${i}`,
                })),
            },
        ],
        ['an unknown client kind', { localClients: [{ kind: 'desktop', clientId: 'c' }] }],
        ['an empty client id', { localClients: [{ kind: 'cli', clientId: ' ' }] }],
        [
            'a client id over 255 characters',
            { localClients: [{ kind: 'cli', clientId: 'c'.repeat(256) }] },
        ],
        [
            'eleven app names',
            {
                delegatedClientNames: Array.from({ length: 11 }, (_, i) => ({
                    clientId: `a${i}`,
                    displayName: `A${i}`,
                })),
            },
        ],
        [
            'an app name over 60 characters',
            { delegatedClientNames: [{ clientId: 'a', displayName: 'n'.repeat(61) }] },
        ],
        ['an unknown field', { issuer: 'https://elsewhere.example' }],
        ['an unknown row field', { localClients: [{ kind: 'cli', clientId: 'c', secret: 'x' }] }],
    ])('refuses %s before it travels', async (_label, input) => {
        const { saveEverIdSettings } = await load();

        await expect(saveEverIdSettings(input as never)).resolves.toEqual({
            success: false,
            error: `${SETTINGS_ERRORS}.invalid`,
        });
        expect(mocks.adminSettings).not.toHaveBeenCalled();
    });

    it('a 400 from the API is the same plain line, never its own message', async () => {
        mocks.adminSettings.mockRejectedValue(await refusal(400, 'invalid_settings'));
        const { saveEverIdSettings } = await load();

        const result = await saveEverIdSettings({ displayName: 'Renamed' });

        expect(result).toEqual({ success: false, error: `${SETTINGS_ERRORS}.invalid` });
        expect(JSON.stringify(result)).not.toContain('UPSTREAM-DETAIL');
        expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it('a validation 400 without a code is the same plain line', async () => {
        const { EverIdRequestError } = await import('@/lib/api/ever-id');
        mocks.adminSettings.mockRejectedValue(
            new EverIdRequestError(400, null, null, { message: ['displayName must be shorter'] }),
        );
        const { saveEverIdSettings } = await load();

        await expect(saveEverIdSettings({ displayName: 'Renamed' })).resolves.toEqual({
            success: false,
            error: `${SETTINGS_ERRORS}.invalid`,
        });
    });

    it.each([
        ['a non-administrator (404)', 404],
        ['a rate limit (429)', 429],
        ['a server error (500)', 500],
    ])('anything else, such as %s, is "couldn\'t be saved"', async (_label, status) => {
        mocks.adminSettings.mockRejectedValue(await refusal(status, null));
        const { saveEverIdSettings } = await load();

        await expect(saveEverIdSettings({ displayName: 'Renamed' })).resolves.toEqual({
            success: false,
            error: `${SETTINGS_ERRORS}.failed`,
        });
    });
});
