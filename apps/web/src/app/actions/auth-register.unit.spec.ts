import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `register` — the server side of EW-073, EW-074 and EW-076.
 *
 * The signup form now states and checks these rules before submit, but the
 * action is where they are actually enforced, and a client-side check is only
 * ever a convenience. This file pins the enforcement itself:
 *
 *   - EW-076: `abcdefg_` must be ACCEPTED. The old `/(\d|\W)/` rejected it
 *     while the API's `[\d\W_]` accepts it, so the web layer refused a password
 *     the server would have taken.
 *   - EW-074: a too-short name must fail with a message that names the field
 *     the form displays, not `username`.
 *   - EW-073: the three rules the hint used to omit must still reject.
 *
 * `getTranslations` echoes its key, so each branch is identified by the key it
 * returns rather than by prose that may later be re-worded.
 */

const { registerMock, setAuthCookiesMock, redirectMock } = vi.hoisted(() => ({
    registerMock: vi.fn(),
    setAuthCookiesMock: vi.fn(),
    redirectMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    setAuthCookies: setAuthCookiesMock,
    setOAuthStateCookie: vi.fn(),
    removeAuthAccessCookies: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
    authAPI: {
        register: registerMock,
        login: vi.fn(),
        logout: vi.fn(),
        getOAuthAuthUrl: vi.fn(),
    },
}));

vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => 'en',
}));

vi.mock('@/i18n/navigation', () => ({ redirect: redirectMock }));

/** One valid claim — the terms plumbing is not what this file is testing. */
const TERMS = [
    {
        documentId: 'tos:default',
        version: '2026-01-01',
        sha256: 'a'.repeat(64),
        locale: 'en',
    },
];

async function callRegister(name: string, password: string) {
    const { register } = await import('./auth');
    return register(name, 'jane@example.com', password, TERMS);
}

beforeEach(() => {
    registerMock.mockReset();
    registerMock.mockResolvedValue({ access_token: 'token' });
    setAuthCookiesMock.mockReset();
    redirectMock.mockReset();
});

afterEach(() => {
    vi.resetModules();
});

describe('register — the client never rejects what the API accepts (EW-076)', () => {
    it('accepts a password whose only special character is an underscore', async () => {
        await callRegister('Jane Doe', 'abcdefg_');

        expect(registerMock).toHaveBeenCalledTimes(1);
        expect(registerMock.mock.calls[0][0].password).toBe('abcdefg_');
    });

    it('control: a password with genuinely nothing but letters is still refused', async () => {
        // Proves the rule was reconciled with the API, not deleted. Without
        // this, the test above would pass just as well against no check at all.
        const result = await callRegister('Jane Doe', 'abcdefghi');

        expect(result).toEqual({ success: false, error: 'password.numberOrSpecial' });
        expect(registerMock).not.toHaveBeenCalled();
    });
});

describe('register — the password rules the hint used to omit (EW-073)', () => {
    it('refuses a 10-character all-uppercase password for want of a lowercase letter', async () => {
        const result = await callRegister('Jane Doe', 'PASSWORD12');

        expect(result).toEqual({ success: false, error: 'password.lowercase' });
        expect(registerMock).not.toHaveBeenCalled();
    });

    it('refuses a password starting with a dot', async () => {
        const result = await callRegister('Jane Doe', '.lowercase1');

        expect(result).toEqual({ success: false, error: 'password.cannotStartWith' });
        expect(registerMock).not.toHaveBeenCalled();
    });

    it('refuses a password under 8 characters', async () => {
        const result = await callRegister('Jane Doe', 'short1');

        expect(result).toEqual({ success: false, error: 'password.minLength' });
        expect(registerMock).not.toHaveBeenCalled();
    });
});

describe('register — the rejection names the field the form shows (EW-074)', () => {
    it('reports a short name with the name key, not the username key', async () => {
        const result = await callRegister('山田', 'lowercase1');

        expect(result).toEqual({ success: false, error: 'name.minLength' });
        expect(result).not.toEqual({ success: false, error: 'username.minLength' });
        expect(registerMock).not.toHaveBeenCalled();
    });

    it('control: a long-enough name gets past the check entirely', async () => {
        await callRegister('山田家', 'lowercase1');

        expect(registerMock).toHaveBeenCalledTimes(1);
        expect(registerMock.mock.calls[0][0].username).toBe('山田家');
    });

    it('counts the trimmed length, matching the form, and posts the trimmed value', async () => {
        // The form checks `name.trim().length`. If this schema counted the raw
        // string the client would be the stricter of the two — the same defect
        // as EW-076, in a different field.
        const padded = await callRegister('  山田  ', 'lowercase1');
        expect(padded).toEqual({ success: false, error: 'name.minLength' });
        expect(registerMock).not.toHaveBeenCalled();

        await callRegister('  山田家  ', 'lowercase1');
        expect(registerMock).toHaveBeenCalledTimes(1);
        expect(registerMock.mock.calls[0][0].username).toBe('山田家');
    });
});
