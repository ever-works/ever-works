import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Note: `crypto.ts` starts with `import 'server-only'`, which is a
// Next.js build-time guard. The Vitest config aliases that specifier
// to a no-op shim (`vitest.server-only.shim.ts`) so server-side
// modules can be imported under jsdom.

// The module reads the secret from `lib/constants.ts > AUTH_SECRET`,
// which is captured at module-evaluation time from
// `process.env.COOKIE_SECRET || process.env.AUTH_SECRET`. We
// reset/re-import per test so each test sees its own secret length.
const ORIGINAL_ENV = { ...process.env };

async function loadCrypto(secret: string | undefined): Promise<typeof import('./crypto')> {
    vi.resetModules();
    if (secret === undefined) {
        delete process.env.COOKIE_SECRET;
        delete process.env.AUTH_SECRET;
    } else {
        process.env.COOKIE_SECRET = secret;
    }
    return await import('./crypto');
}

describe('crypto — short-secret throw (H-14)', () => {
    beforeEach(() => {
        // Start each test from a clean env baseline.
        process.env = { ...ORIGINAL_ENV };
        delete process.env.COOKIE_SECRET;
        delete process.env.AUTH_SECRET;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('throws on a 31-char secret, with the 32-char minimum mentioned in the inner error', async () => {
        const secret = 'a'.repeat(31);
        expect(secret.length).toBe(31);

        // The public `encrypt` API wraps the inner length-check error in a
        // generic "Failed to encrypt cookie value" message, and logs the
        // original via `console.error`. We assert on both: the rejection
        // happens, and the inner error mentions the 32-char minimum so an
        // operator inspecting logs gets a useful message.
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { encrypt } = await loadCrypto(secret);
        await expect(encrypt('hello')).rejects.toThrow();

        const loggedInnerError = errSpy.mock.calls
            .flat()
            .map((arg) => (arg instanceof Error ? arg.message : String(arg)))
            .join(' ');
        expect(loggedInnerError).toMatch(/32 characters/i);

        errSpy.mockRestore();
    });

    it('does NOT throw on the minimum 32-char secret', async () => {
        const secret = 'a'.repeat(32);
        expect(secret.length).toBe(32);

        const { encrypt, decrypt } = await loadCrypto(secret);

        // Round-trip: should succeed without throwing on the length check.
        const sealed = await encrypt('hello world');
        expect(typeof sealed).toBe('string');
        expect(sealed.length).toBeGreaterThan(0);

        const unsealed = await decrypt(sealed);
        expect(unsealed).toBe('hello world');
    });

    it('does NOT throw on a longer (64-char) secret', async () => {
        const secret = 'b'.repeat(64);
        expect(secret.length).toBe(64);

        const { encrypt, decrypt } = await loadCrypto(secret);

        const sealed = await encrypt('payload');
        expect(typeof sealed).toBe('string');

        const unsealed = await decrypt(sealed);
        expect(unsealed).toBe('payload');
    });
});
