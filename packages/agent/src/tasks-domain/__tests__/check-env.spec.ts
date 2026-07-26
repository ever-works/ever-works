import {
    buildCheckEnv,
    normalizePassthrough,
    CHECK_ENV_ALLOWLIST,
    MAX_ENV_PASSTHROUGH,
} from '../check-env';

/**
 * Quality gates — the scrubbed environment an acceptance-check subprocess
 * runs with. A check command is user-authored, so the ONE property that
 * matters here is that the platform's own secrets never reach it.
 */

const PLATFORM_ENV: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/worker',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    TMPDIR: '/tmp',
    NODE_ENV: 'production',
    // …and the platform's crown jewels, all inherited before this fix.
    DATABASE_URL: 'postgres://user:pw@db/ever',
    DATABASE_PASSWORD: 'hunter2',
    PLATFORM_ENCRYPTION_KEY: 'deadbeef',
    BETTER_AUTH_SECRET: 'auth-secret',
    AUTH_SECRET: 'auth-secret',
    TRIGGER_SECRET_KEY: 'tr_secret',
    TRIGGER_INTERNAL_SECRET: 'internal',
    PLUGIN_OPENROUTER_API_KEY: 'sk-or-1',
    STRIPE_SECRET_KEY: 'sk_live_1',
    SMTP_PASSWORD: 'mail-pw',
    GH_CLIENT_SECRET: 'gh-secret',
    SENTRY_DSN: 'https://abc@sentry.io/1',
};

describe('buildCheckEnv — platform secrets never reach a user-authored check', () => {
    it('drops every platform secret in the parent environment', () => {
        const env = buildCheckEnv({ parentEnv: PLATFORM_ENV });
        for (const leaked of [
            'DATABASE_URL',
            'DATABASE_PASSWORD',
            'PLATFORM_ENCRYPTION_KEY',
            'BETTER_AUTH_SECRET',
            'AUTH_SECRET',
            'TRIGGER_SECRET_KEY',
            'TRIGGER_INTERNAL_SECRET',
            'PLUGIN_OPENROUTER_API_KEY',
            'STRIPE_SECRET_KEY',
            'SMTP_PASSWORD',
            'GH_CLIENT_SECRET',
            'SENTRY_DSN',
        ]) {
            expect(env[leaked]).toBeUndefined();
        }
        // Not one secret VALUE either, under any name.
        expect(Object.values(env)).not.toContain('hunter2');
        expect(Object.values(env)).not.toContain('deadbeef');
    });

    it('never returns the parent environment, a copy of it, or a spread of it', () => {
        const env = buildCheckEnv({ parentEnv: PLATFORM_ENV });
        expect(env).not.toBe(PLATFORM_ENV);
        expect(Object.keys(env).length).toBeLessThan(Object.keys(PLATFORM_ENV).length);
    });

    it('keeps what a build/test command legitimately needs (PATH, HOME, locale, TZ, temp)', () => {
        const env = buildCheckEnv({ parentEnv: PLATFORM_ENV });
        expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
        expect(env.HOME).toBe('/home/worker');
        expect(env.LANG).toBe('en_US.UTF-8');
        expect(env.LC_ALL).toBe('en_US.UTF-8');
        expect(env.TZ).toBe('UTC');
        expect(env.TMPDIR).toBe('/tmp');
        expect(env.NODE_ENV).toBe('production');
    });

    it('marks the run non-interactive with CI=1 when the parent does not', () => {
        expect(buildCheckEnv({ parentEnv: PLATFORM_ENV }).CI).toBe('1');
        expect(buildCheckEnv({ parentEnv: { ...PLATFORM_ENV, CI: 'true' } }).CI).toBe('true');
    });

    it('falls back to a usable PATH/HOME/TMPDIR when the parent has none', () => {
        const env = buildCheckEnv({ parentEnv: {} });
        if (process.platform !== 'win32') {
            expect(env.PATH).toBeTruthy();
        }
        expect(env.HOME || env.USERPROFILE).toBeTruthy();
        expect(env.TMPDIR || env.TEMP || env.TMP).toBeTruthy();
    });

    it('an explicit envPassthrough name is granted (values read at spawn time)', () => {
        const env = buildCheckEnv({
            parentEnv: { ...PLATFORM_ENV, BUILD_FLAVOR: 'nightly' },
            passthrough: ['BUILD_FLAVOR'],
        });
        expect(env.BUILD_FLAVOR).toBe('nightly');
    });

    it('a granted name that is unset in the parent is simply absent (no empty string)', () => {
        const env = buildCheckEnv({ parentEnv: PLATFORM_ENV, passthrough: ['NOT_SET_ANYWHERE'] });
        expect('NOT_SET_ANYWHERE' in env).toBe(false);
    });

    it('an explicit grant beats the secret-name sweep — that IS the opt-in', () => {
        const env = buildCheckEnv({
            parentEnv: { ...PLATFORM_ENV, MY_BUILD_TOKEN: 'grant-me' },
            passthrough: ['MY_BUILD_TOKEN'],
        });
        expect(env.MY_BUILD_TOKEN).toBe('grant-me');
    });

    it('platform-owned configuration is NOT grantable, even when explicitly listed', () => {
        const env = buildCheckEnv({
            parentEnv: PLATFORM_ENV,
            passthrough: [
                'PLATFORM_ENCRYPTION_KEY',
                'DATABASE_URL',
                'TRIGGER_SECRET_KEY',
                'PLUGIN_OPENROUTER_API_KEY',
                'AUTH_SECRET',
            ],
        });
        expect(env.PLATFORM_ENCRYPTION_KEY).toBeUndefined();
        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.TRIGGER_SECRET_KEY).toBeUndefined();
        expect(env.PLUGIN_OPENROUTER_API_KEY).toBeUndefined();
        expect(env.AUTH_SECRET).toBeUndefined();
    });

    it('a secret-shaped name is blocked even when the ALLOWLIST carries it (belt and braces)', () => {
        const env = buildCheckEnv({
            parentEnv: { ...PLATFORM_ENV, ACME_API_KEY: 'leak', ACME_REGION: 'eu' },
            // A future/mistaken allowlist widening must not reopen the hole.
            allowlist: [...CHECK_ENV_ALLOWLIST, 'ACME_API_KEY', 'ACME_REGION'],
        });
        expect(env.ACME_API_KEY).toBeUndefined();
        expect(env.ACME_REGION).toBe('eu');
    });

    it('strips a credential-bearing URL value from an allowlisted variable', () => {
        const env = buildCheckEnv({
            parentEnv: {
                ...PLATFORM_ENV,
                HTTPS_PROXY: 'http://bob:s3cr3t@proxy.corp:8080',
                HTTP_PROXY: 'http://proxy.corp:8080',
            },
        });
        expect(env.HTTPS_PROXY).toBeUndefined();
        expect(env.HTTP_PROXY).toBe('http://proxy.corp:8080');
    });

    it('matches parent variables case-insensitively (Windows spells them Path/TEMP)', () => {
        const env = buildCheckEnv({
            parentEnv: {
                Path: 'C:\\Windows\\system32',
                SystemRoot: 'C:\\Windows',
                ComSpec: 'C:\\Windows\\system32\\cmd.exe',
                TEMP: 'C:\\Temp',
                PATHEXT: '.COM;.EXE;.BAT',
            },
        });
        expect(env.Path).toBe('C:\\Windows\\system32');
        expect(env.SystemRoot).toBe('C:\\Windows');
        expect(env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe');
        expect(env.TEMP).toBe('C:\\Temp');
        expect(env.PATHEXT).toBe('.COM;.EXE;.BAT');
    });

    it('on win32 the real environment yields the vars cmd.exe needs to start', () => {
        if (process.platform !== 'win32') {
            expect(true).toBe(true);
            return;
        }
        const env = buildCheckEnv();
        const upper = new Set(Object.keys(env).map((key) => key.toUpperCase()));
        expect(upper.has('PATH')).toBe(true);
        expect(upper.has('SYSTEMROOT')).toBe(true);
        expect(upper.has('COMSPEC')).toBe(true);
        expect(upper.has('PATHEXT')).toBe(true);
    });

    it('defaults to process.env without exposing its secrets to the child', () => {
        const restore = { ...process.env };
        process.env.PLATFORM_ENCRYPTION_KEY = 'live-key';
        process.env.SOME_RANDOM_SECRET = 'live-secret';
        try {
            const env = buildCheckEnv();
            expect(env.PLATFORM_ENCRYPTION_KEY).toBeUndefined();
            expect(env.SOME_RANDOM_SECRET).toBeUndefined();
            expect(Object.values(env)).not.toContain('live-key');
        } finally {
            process.env = restore;
        }
    });
});

describe('normalizePassthrough', () => {
    it('ignores malformed names instead of failing the check', () => {
        expect(
            normalizePassthrough(['GOOD_NAME', 'has space', 'X=1', '', '9LEADING', null as never]),
        ).toEqual(['GOOD_NAME']);
    });

    it('de-duplicates case-insensitively and caps the list', () => {
        expect(normalizePassthrough(['A_VAR', 'a_var'])).toEqual(['A_VAR']);
        const many = Array.from({ length: MAX_ENV_PASSTHROUGH + 10 }, (_, i) => `VAR_${i}`);
        expect(normalizePassthrough(many)).toHaveLength(MAX_ENV_PASSTHROUGH);
    });

    it('drops platform-owned names before they can ever be looked up', () => {
        expect(normalizePassthrough(['DATABASE_URL', 'PLUGIN_X', 'MY_VAR'])).toEqual(['MY_VAR']);
    });

    it('treats a non-array (hand-edited simple-json column) as no grant', () => {
        expect(normalizePassthrough(undefined)).toEqual([]);
        expect(normalizePassthrough('DATABASE_URL' as never)).toEqual([]);
    });
});
