import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APW-12 T22 — the four Ever ID cookies (plan §6.1).
 *
 * Every one is HttpOnly, SameSite=Lax, Path `/`, 600 seconds, `secure` from the
 * public URL scheme; the transaction and intent are cleared on every read; the
 * pending value is encrypted, kind-bound and expires; an oversized value is
 * refused instead of being written into a cookie the browser would drop.
 */

const jar = vi.hoisted(() => {
    type Cookie = { value: string; options?: Record<string, unknown> };
    const values = new Map<string, Cookie>();
    const sets: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
    const deletes: Array<Record<string, unknown>> = [];
    return {
        values,
        sets,
        deletes,
        reset() {
            values.clear();
            sets.length = 0;
            deletes.length = 0;
        },
        store: {
            get: (name: string) => {
                const cookie = values.get(name);
                return cookie ? { name, value: cookie.value } : undefined;
            },
            set: (name: string, value: string, options?: Record<string, unknown>) => {
                sets.push({ name, value, options });
                values.set(name, { value, options });
            },
            delete: (arg: string | Record<string, unknown>) => {
                const options = typeof arg === 'string' ? { name: arg } : arg;
                deletes.push(options);
                values.delete(options.name as string);
            },
        },
    };
});

vi.mock('next/headers', () => ({ cookies: async () => jar.store }));

const SECRET = 'x'.repeat(48);
const ORIGINAL_ENV = { ...process.env };

async function load(webUrl = 'https://app.example') {
    vi.resetModules();
    process.env.COOKIE_SECRET = SECRET;
    process.env.WEB_URL = webUrl;
    return import('./ever-id-cookies');
}

const PENDING = {
    kind: 'signUp' as const,
    pending: 'sealed-pending-value-from-the-api',
    email: 'alice@example.com',
    name: 'Alice Martin',
    accountEmail: null,
};

describe('Ever ID cookies — attributes (T22)', () => {
    beforeEach(() => {
        jar.reset();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        vi.useRealTimers();
    });

    it('writes the transaction and intent HttpOnly, SameSite=Lax, Path /, 600 s, secure on HTTPS', async () => {
        const { setEverIdTransaction } = await load('https://app.example');

        await setEverIdTransaction('sealed-transaction', 'sign-in');

        expect(jar.sets.map((s) => s.name)).toEqual(['ew_everid_txn', 'ew_everid_intent']);
        for (const set of jar.sets) {
            expect(set.options).toMatchObject({
                httpOnly: true,
                sameSite: 'lax',
                path: '/',
                maxAge: 600,
                secure: true,
            });
        }
        expect(jar.values.get('ew_everid_txn')?.value).toBe('sealed-transaction');
        expect(jar.values.get('ew_everid_intent')?.value).toBe('sign-in');
    });

    it('takes `secure` from the public URL scheme, like the session cookie', async () => {
        const { setEverIdLogoutState } = await load('http://localhost:3000');

        await setEverIdLogoutState('state-1');

        expect(jar.sets[0].options).toMatchObject({ secure: false, httpOnly: true, path: '/' });
    });

    it('every Ever ID cookie uses the same attributes', async () => {
        const mod = await load();

        await mod.setEverIdTransaction('t', 'connect');
        await mod.setEverIdPending(PENDING);
        await mod.setEverIdLogoutState('s');

        const names = jar.sets.map((s) => s.name).sort();
        expect(names).toEqual(
            [
                mod.EVER_ID_INTENT_COOKIE,
                mod.EVER_ID_LOGOUT_STATE_COOKIE,
                mod.EVER_ID_PENDING_COOKIE,
                mod.EVER_ID_TXN_COOKIE,
            ].sort(),
        );
        for (const set of jar.sets) {
            expect(set.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
        }
    });
});

describe('Ever ID cookies — transaction (cleared on every read)', () => {
    beforeEach(() => {
        jar.reset();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('returns the transaction and intent, and clears both at Path /', async () => {
        const { setEverIdTransaction, takeEverIdTransaction } = await load();
        await setEverIdTransaction('sealed-transaction', 'connect');

        await expect(takeEverIdTransaction()).resolves.toEqual({
            transaction: 'sealed-transaction',
            intent: 'connect',
        });

        const cleared = jar.deletes.map((d) => d.name);
        expect(cleared).toEqual(['ew_everid_txn', 'ew_everid_intent']);
        for (const deleted of jar.deletes) expect(deleted).toMatchObject({ path: '/' });
        expect(jar.values.has('ew_everid_txn')).toBe(false);
        expect(jar.values.has('ew_everid_intent')).toBe(false);
    });

    it('clears both even when there is nothing to read', async () => {
        const { takeEverIdTransaction } = await load();

        await expect(takeEverIdTransaction()).resolves.toEqual({ transaction: null, intent: null });
        expect(jar.deletes.map((d) => d.name)).toEqual(['ew_everid_txn', 'ew_everid_intent']);
    });

    it('ignores an intent that is not one of the two the flow writes', async () => {
        const { takeEverIdTransaction } = await load();
        jar.values.set('ew_everid_txn', { value: 't' });
        jar.values.set('ew_everid_intent', { value: 'admin' });

        await expect(takeEverIdTransaction()).resolves.toEqual({ transaction: 't', intent: null });
    });
});

describe('Ever ID cookies — pending confirmation', () => {
    beforeEach(() => {
        jar.reset();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        vi.useRealTimers();
    });

    it('encrypts the value: neither the address nor the API value is readable in the cookie', async () => {
        const { setEverIdPending } = await load();

        await setEverIdPending(PENDING);

        const raw = jar.values.get('ew_everid_pending')?.value ?? '';
        expect(raw.length).toBeGreaterThan(0);
        expect(raw).not.toContain('alice');
        expect(raw).not.toContain('example.com');
        expect(raw).not.toContain(PENDING.pending);
    });

    it('reads back what was stored, for the screen it belongs to', async () => {
        const { setEverIdPending, readEverIdPending } = await load();
        await setEverIdPending(PENDING);

        await expect(readEverIdPending('signUp')).resolves.toEqual(PENDING);
    });

    it('answers null for another screen’s pending value', async () => {
        const { setEverIdPending, readEverIdPending } = await load();
        await setEverIdPending(PENDING);

        await expect(readEverIdPending('connect')).resolves.toBeNull();
        await expect(readEverIdPending('emailInUse')).resolves.toBeNull();
    });

    it('answers null once 600 seconds have passed, whatever the browser kept', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
        const { setEverIdPending, readEverIdPending } = await load();
        await setEverIdPending(PENDING);

        vi.setSystemTime(new Date('2026-10-01T12:09:59Z'));
        await expect(readEverIdPending('signUp')).resolves.not.toBeNull();
        vi.setSystemTime(new Date('2026-10-01T12:10:01Z'));
        await expect(readEverIdPending('signUp')).resolves.toBeNull();
    });

    it('answers null for a tampered or foreign value', async () => {
        const { readEverIdPending } = await load();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        jar.values.set('ew_everid_pending', { value: 'not-a-sealed-value' });

        await expect(readEverIdPending('signUp')).resolves.toBeNull();
    });

    it('trims a long display name before storing it', async () => {
        const { setEverIdPending, readEverIdPending } = await load();
        await setEverIdPending({ ...PENDING, name: 'N'.repeat(500) });

        const stored = await readEverIdPending('signUp');
        expect(stored?.name).toHaveLength(128);
    });

    it('refuses a value that would not fit in a cookie, and writes nothing', async () => {
        const { setEverIdPending, EverIdCookieTooLargeError } = await load();

        await expect(
            setEverIdPending({ ...PENDING, pending: 'p'.repeat(4_000) }),
        ).rejects.toBeInstanceOf(EverIdCookieTooLargeError);
        expect(jar.values.has('ew_everid_pending')).toBe(false);
    });

    it('a realistic pending value stays well inside the 4 KB cookie limit', async () => {
        const { setEverIdPending } = await load();
        // An API sealed value at a realistic size, plus the longest display data.
        await setEverIdPending({
            kind: 'connect',
            pending: 'p'.repeat(1_400),
            email: `${'a'.repeat(64)}@${'b'.repeat(180)}.example`,
            name: null,
            accountEmail: `${'c'.repeat(64)}@${'d'.repeat(180)}.example`,
        });

        const raw = jar.values.get('ew_everid_pending')?.value ?? '';
        expect(raw.length).toBeLessThan(4_000);
    });

    it('clearEverIdPending removes the cookie at Path /', async () => {
        const { setEverIdPending, clearEverIdPending } = await load();
        await setEverIdPending(PENDING);

        await clearEverIdPending();

        expect(jar.values.has('ew_everid_pending')).toBe(false);
        expect(jar.deletes).toEqual([
            expect.objectContaining({ name: 'ew_everid_pending', path: '/' }),
        ]);
    });
});

describe('Ever ID cookies — sign-out state', () => {
    beforeEach(() => {
        jar.reset();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('returns the remembered state once and clears it', async () => {
        const { setEverIdLogoutState, takeEverIdLogoutState } = await load();
        await setEverIdLogoutState('state-abc');

        await expect(takeEverIdLogoutState()).resolves.toBe('state-abc');
        await expect(takeEverIdLogoutState()).resolves.toBeNull();
        expect(jar.deletes.every((d) => d.name === 'ew_everid_logout_state')).toBe(true);
    });

    it('ignores an implausibly long state', async () => {
        const { takeEverIdLogoutState } = await load();
        jar.values.set('ew_everid_logout_state', { value: 's'.repeat(513) });

        await expect(takeEverIdLogoutState()).resolves.toBeNull();
    });
});

describe('resolveEverIdReturnTo — where a completed sign-in lands', () => {
    beforeEach(() => {
        jar.reset();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('keeps a relative return path and falls back for anything else', async () => {
        const { resolveEverIdReturnTo } = await load();

        await expect(resolveEverIdReturnTo('/works/42', '/')).resolves.toBe('/works/42');
        await expect(resolveEverIdReturnTo('https://evil.example', '/')).resolves.toBe('/');
        await expect(resolveEverIdReturnTo('//evil.example', '/')).resolves.toBe('/');
        await expect(resolveEverIdReturnTo(null, '/?newUser=true')).resolves.toBe('/?newUser=true');
    });

    it('spends the stored relative destination it lands on, and only that one', async () => {
        const { resolveEverIdReturnTo } = await load();
        jar.values.set('redirect_url', { value: '/org-invite/tok' });

        await expect(resolveEverIdReturnTo('/works', '/')).resolves.toBe('/works');
        expect(jar.values.has('redirect_url')).toBe(true);

        await expect(resolveEverIdReturnTo('/org-invite/tok', '/')).resolves.toBe(
            '/org-invite/tok',
        );
        expect(jar.values.has('redirect_url')).toBe(false);
    });

    it('never touches an absolute stored destination', async () => {
        const { resolveEverIdReturnTo } = await load();
        jar.values.set('redirect_url', { value: 'http://localhost:44663/callback' });

        await expect(resolveEverIdReturnTo(null, '/')).resolves.toBe('/');
        expect(jar.values.get('redirect_url')?.value).toBe('http://localhost:44663/callback');
    });
});
