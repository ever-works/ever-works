import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `register()` reads its config straight from `process.env`, so we reset the
// module registry and re-import per test to get a clean evaluation each time.
// We also pin the env we care about (NEXT_RUNTIME so the body actually runs,
// a valid 32+ char secret so it reaches the ALLOWED_REDIRECT_URLS guard, and
// NODE_ENV / ALLOWED_REDIRECT_URLS which are the inputs under test).
const ORIGINAL_ENV = { ...process.env };

async function loadRegister(): Promise<typeof import('./instrumentation').register> {
    vi.resetModules();
    const mod = await import('./instrumentation');
    return mod.register;
}

const VALID_SECRET = 'a'.repeat(32);

describe('instrumentation register() — ALLOWED_REDIRECT_URLS prod guard', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
        // Run the Node-runtime branch and pass the AUTH_SECRET checks so the
        // new ALLOWED_REDIRECT_URLS guard is reached.
        process.env.NEXT_RUNTIME = 'nodejs';
        process.env.COOKIE_SECRET = VALID_SECRET;
        delete process.env.AUTH_SECRET;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        vi.restoreAllMocks();
    });

    it('warns when NODE_ENV=production and ALLOWED_REDIRECT_URLS is unset', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        delete process.env.ALLOWED_REDIRECT_URLS;

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const warned = warnSpy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .join(' ');
        expect(warned).toMatch(/ALLOWED_REDIRECT_URLS is not set/i);
        expect(warned).toMatch(/\[security\]/i);
    });

    it('does NOT warn when ALLOWED_REDIRECT_URLS is set in production', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        process.env.ALLOWED_REDIRECT_URLS = 'app.ever.works,ever.works';

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const warned = warnSpy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .join(' ');
        expect(warned).not.toMatch(/ALLOWED_REDIRECT_URLS is not set/i);
    });

    it('does NOT warn outside production even when ALLOWED_REDIRECT_URLS is unset', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        delete process.env.ALLOWED_REDIRECT_URLS;

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const warned = warnSpy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .join(' ');
        expect(warned).not.toMatch(/ALLOWED_REDIRECT_URLS is not set/i);
    });
});
