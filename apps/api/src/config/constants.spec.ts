import { authConstants, AuthProvider, config } from './constants';

describe('config/constants', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        // Reset all env vars touched by config getters to a known empty state.
        for (const key of Object.keys(process.env)) {
            if (
                key.startsWith('GH_') ||
                key.startsWith('GITHUB_APP_') ||
                key.startsWith('GOOGLE_') ||
                key.startsWith('FACEBOOK_') ||
                key.startsWith('LINKEDIN_') ||
                key.startsWith('SMTP_') ||
                key.startsWith('RESEND_') ||
                key.startsWith('EMAIL_') ||
                key.startsWith('FEATURE_') ||
                key.startsWith('NEXT_PUBLIC_') ||
                key.startsWith('PLATFORM_') ||
                key.startsWith('APP_') ||
                key.startsWith('COMPANY_') ||
                key === 'AUTH_SECRET' ||
                key === 'WEB_URL' ||
                key === 'HTTP_DEBUG' ||
                key === 'MAILER_PROVIDER' ||
                key === 'WORK_STALE_TIMEOUT_HOURS'
            ) {
                delete process.env[key];
            }
        }
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    describe('authConstants', () => {
        it('exposes the documented bcrypt + refresh-token tunables', () => {
            expect(authConstants).toEqual({
                bcryptSaltRounds: 10,
                refreshTokenLength: 32,
                refreshTokenCleanupDays: 30,
            });
        });
    });

    describe('AuthProvider enum', () => {
        it('lists exactly the supported providers as string values', () => {
            expect(AuthProvider.LOCAL).toBe('local');
            expect(AuthProvider.GITHUB).toBe('github');
            expect(AuthProvider.GOOGLE).toBe('google');
            expect(AuthProvider.FACEBOOK).toBe('facebook');
            expect(AuthProvider.LINKEDIN).toBe('linkedin');
            // No accidental new members.
            expect(Object.values(AuthProvider).sort()).toEqual([
                'facebook',
                'github',
                'google',
                'linkedin',
                'local',
            ]);
        });
    });

    describe('config.debug', () => {
        it('is false when HTTP_DEBUG is unset', () => {
            expect(config.debug()).toBe(false);
        });

        it('is true only when HTTP_DEBUG === "true"', () => {
            process.env.HTTP_DEBUG = 'true';
            expect(config.debug()).toBe(true);
            process.env.HTTP_DEBUG = 'TRUE';
            expect(config.debug()).toBe(false);
            process.env.HTTP_DEBUG = '1';
            expect(config.debug()).toBe(false);
        });
    });

    describe('config.webAppUrl', () => {
        it('defaults to localhost:3000', () => {
            expect(config.webAppUrl()).toBe('http://localhost:3000');
        });

        it('honors WEB_URL when set', () => {
            process.env.WEB_URL = 'https://my.app';
            expect(config.webAppUrl()).toBe('https://my.app');
        });
    });

    describe('config.auth.secret', () => {
        it('throws when AUTH_SECRET is missing', () => {
            expect(() => config.auth.secret()).toThrow(
                'AUTH_SECRET environment variable is required',
            );
        });

        it('returns the AUTH_SECRET value when set', () => {
            process.env.AUTH_SECRET = 's3cret';
            expect(config.auth.secret()).toBe('s3cret');
        });

        it('throws on empty string (falsy)', () => {
            process.env.AUTH_SECRET = '';
            expect(() => config.auth.secret()).toThrow();
        });
    });

    describe('config.branding', () => {
        it('falls back to defaults', () => {
            expect(config.branding.appName()).toBe('Ever Works');
            expect(config.branding.companyOwner()).toBe('Ever Co.');
            expect(config.branding.platformWebsite()).toBe('https://ever.works');
            expect(config.branding.appDescription()).toBe(
                'A SaaS platform for building and managing works',
            );
        });

        it('uses APP_NAME first, then NEXT_PUBLIC_APP_NAME, then default', () => {
            process.env.NEXT_PUBLIC_APP_NAME = 'Public';
            expect(config.branding.appName()).toBe('Public');
            process.env.APP_NAME = 'Primary';
            expect(config.branding.appName()).toBe('Primary');
        });

        it('uses COMPANY_OWNER first, then NEXT_PUBLIC_COMPANY_OWNER, then default', () => {
            process.env.NEXT_PUBLIC_COMPANY_OWNER = 'Public Co';
            expect(config.branding.companyOwner()).toBe('Public Co');
            process.env.COMPANY_OWNER = 'Primary Co';
            expect(config.branding.companyOwner()).toBe('Primary Co');
        });

        it('uses PLATFORM_WEBSITE first, then NEXT_PUBLIC_COMPANY_OWNER_WEBSITE, then default', () => {
            process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE = 'https://x.example';
            expect(config.branding.platformWebsite()).toBe('https://x.example');
            process.env.PLATFORM_WEBSITE = 'https://primary.example';
            expect(config.branding.platformWebsite()).toBe('https://primary.example');
        });

        it('uses APP_DESCRIPTION first, then NEXT_PUBLIC_SITE_DESCRIPTION, then default', () => {
            process.env.NEXT_PUBLIC_SITE_DESCRIPTION = 'Public desc';
            expect(config.branding.appDescription()).toBe('Public desc');
            process.env.APP_DESCRIPTION = 'Primary desc';
            expect(config.branding.appDescription()).toBe('Primary desc');
        });
    });

    describe('config.mail.provider', () => {
        it('returns "faker" when MAILER_PROVIDER is unset', () => {
            expect(config.mail.provider()).toBe('faker');
        });

        it('returns "faker" when MAILER_PROVIDER === "none"', () => {
            process.env.MAILER_PROVIDER = 'none';
            expect(config.mail.provider()).toBe('faker');
        });

        it('returns "resend" when MAILER_PROVIDER === "resend"', () => {
            process.env.MAILER_PROVIDER = 'resend';
            expect(config.mail.provider()).toBe('resend');
        });

        it('returns "smtp" for any other value (incl. legacy / typo names)', () => {
            process.env.MAILER_PROVIDER = 'smtp';
            expect(config.mail.provider()).toBe('smtp');
            process.env.MAILER_PROVIDER = 'something-else';
            expect(config.mail.provider()).toBe('smtp');
            process.env.MAILER_PROVIDER = '';
            // Empty string is falsy → faker per implementation
            expect(config.mail.provider()).toBe('faker');
        });
    });

    describe('config.mail.from', () => {
        it('uses EMAIL_FROM verbatim when set', () => {
            process.env.EMAIL_FROM = 'Custom <custom@example.com>';
            expect(config.mail.from()).toBe('Custom <custom@example.com>');
        });

        it('formats "<appName> <emailFromEmail>" when EMAIL_FROM is missing', () => {
            process.env.EMAIL_FROM_EMAIL = 'noreply@example.com';
            expect(config.mail.from()).toBe('Ever Works <noreply@example.com>');
        });

        it('falls back to the default email when neither is set', () => {
            expect(config.mail.from()).toBe('Ever Works <ever@ever.works>');
        });

        it('respects custom APP_NAME in the formatted form', () => {
            process.env.APP_NAME = 'Acme';
            expect(config.mail.from()).toBe('Acme <ever@ever.works>');
        });
    });

    describe('config.mail SMTP settings', () => {
        it('defaults host/port and reflects boolean SMTP_SECURE / SMTP_IGNORE_TLS', () => {
            expect(config.mail.smtpHost()).toBe('127.0.0.1');
            expect(config.mail.smtpPort()).toBe(587);
            expect(config.mail.smtpUser()).toBeUndefined();
            expect(config.mail.smtpPassword()).toBeUndefined();
            expect(config.mail.smtpSecure()).toBe(false);
            expect(config.mail.smtpIgnoreTLS()).toBe(false);
        });

        it('parses SMTP_PORT as base-10 int', () => {
            process.env.SMTP_PORT = '2525';
            expect(config.mail.smtpPort()).toBe(2525);
        });

        it('returns NaN when SMTP_PORT is non-numeric (parseInt without radix arg)', () => {
            process.env.SMTP_PORT = 'abc';
            expect(Number.isNaN(config.mail.smtpPort())).toBe(true);
        });

        it('flips SMTP_SECURE/IGNORE_TLS when env value is exactly "true"', () => {
            process.env.SMTP_SECURE = 'true';
            process.env.SMTP_IGNORE_TLS = 'true';
            expect(config.mail.smtpSecure()).toBe(true);
            expect(config.mail.smtpIgnoreTLS()).toBe(true);
            process.env.SMTP_SECURE = 'TRUE';
            expect(config.mail.smtpSecure()).toBe(false);
        });

        it('forwards SMTP_HOST / SMTP_USER / SMTP_PASSWORD verbatim', () => {
            process.env.SMTP_HOST = 'mail.example.com';
            process.env.SMTP_USER = 'user';
            process.env.SMTP_PASSWORD = 'pass';
            expect(config.mail.smtpHost()).toBe('mail.example.com');
            expect(config.mail.smtpUser()).toBe('user');
            expect(config.mail.smtpPassword()).toBe('pass');
        });
    });

    describe('config.mail.resend', () => {
        it('returns RESEND_APIKEY (or undefined)', () => {
            expect(config.mail.resend.apiKey()).toBeUndefined();
            process.env.RESEND_APIKEY = 're_test';
            expect(config.mail.resend.apiKey()).toBe('re_test');
        });

        it('emailFrom uses RESEND_EMAIL_FROM when set, otherwise falls back to mail.from()', () => {
            expect(config.mail.resend.emailFrom()).toBe('Ever Works <ever@ever.works>');
            process.env.RESEND_EMAIL_FROM = 'resend@example.com';
            expect(config.mail.resend.emailFrom()).toBe('resend@example.com');
        });
    });

    describe('OAuth providers — google/github/facebook/linkedin/githubApp', () => {
        it.each([
            ['google', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
            ['github', 'GH_CLIENT_ID', 'GH_CLIENT_SECRET'],
            ['facebook', 'FACEBOOK_CLIENT_ID', 'FACEBOOK_CLIENT_SECRET'],
            ['linkedin', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
        ] as const)('%s reads clientId/clientSecret from env', (provider, idKey, secretKey) => {
            process.env[idKey] = `${provider}-id`;
            process.env[secretKey] = `${provider}-secret`;
            const cfg = (config as any)[provider];
            expect(cfg.clientId()).toBe(`${provider}-id`);
            expect(cfg.clientSecret()).toBe(`${provider}-secret`);
        });

        it('google.callbackUrl: env wins, otherwise webAppUrl + path', () => {
            expect(config.google.callbackUrl()).toBe(
                'http://localhost:3000/api/oauth/google/callback',
            );
            process.env.WEB_URL = 'https://app.example';
            expect(config.google.callbackUrl()).toBe(
                'https://app.example/api/oauth/google/callback',
            );
            process.env.GOOGLE_CALLBACK_URL = 'https://override/cb';
            expect(config.google.callbackUrl()).toBe('https://override/cb');
        });

        it('google.connectCallbackUrl mirrors google.callbackUrl (same env var)', () => {
            process.env.GOOGLE_CALLBACK_URL = 'https://override/cb';
            expect(config.google.connectCallbackUrl()).toBe('https://override/cb');
        });

        it('github.callbackUrl uses GH_CALLBACK_URL or webAppUrl', () => {
            expect(config.github.callbackUrl()).toBe(
                'http://localhost:3000/api/oauth/github/callback',
            );
            process.env.GH_CALLBACK_URL = 'https://gh-cb';
            expect(config.github.callbackUrl()).toBe('https://gh-cb');
        });

        it('facebook.callbackUrl uses FACEBOOK_CALLBACK_URL or webAppUrl', () => {
            expect(config.facebook.callbackUrl()).toBe(
                'http://localhost:3000/api/oauth/facebook/callback',
            );
            process.env.FACEBOOK_CALLBACK_URL = 'https://fb-cb';
            expect(config.facebook.callbackUrl()).toBe('https://fb-cb');
        });

        it('linkedin.callbackUrl uses LINKEDIN_CALLBACK_URL or webAppUrl', () => {
            expect(config.linkedin.callbackUrl()).toBe(
                'http://localhost:3000/api/oauth/linkedin/callback',
            );
            process.env.LINKEDIN_CALLBACK_URL = 'https://li-cb';
            expect(config.linkedin.callbackUrl()).toBe('https://li-cb');
        });
    });

    describe('config.githubApp', () => {
        it('reads appId/clientId/clientSecret/webhookSecret', () => {
            process.env.GITHUB_APP_ID = '123';
            process.env.GITHUB_APP_CLIENT_ID = 'cid';
            process.env.GITHUB_APP_CLIENT_SECRET = 'csec';
            process.env.GITHUB_APP_WEBHOOK_SECRET = 'whsec';
            expect(config.githubApp.appId()).toBe('123');
            expect(config.githubApp.clientId()).toBe('cid');
            expect(config.githubApp.clientSecret()).toBe('csec');
            expect(config.githubApp.webhookSecret()).toBe('whsec');
        });

        it('privateKey: undefined when unset, escaped \\n replaced with real newlines when set', () => {
            expect(config.githubApp.privateKey()).toBeUndefined();
            process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN-----\\nline1\\nline2\\n-----END-----';
            expect(config.githubApp.privateKey()).toBe(
                '-----BEGIN-----\nline1\nline2\n-----END-----',
            );
        });

        it('slug defaults to "ever-works", overridable', () => {
            expect(config.githubApp.slug()).toBe('ever-works');
            process.env.GITHUB_APP_SLUG = 'my-app';
            expect(config.githubApp.slug()).toBe('my-app');
        });

        it('setupUrl falls back to webAppUrl + path, env override wins', () => {
            expect(config.githubApp.setupUrl()).toBe('http://localhost:3000/api/github-app/setup');
            process.env.GITHUB_APP_SETUP_URL = 'https://override/setup';
            expect(config.githubApp.setupUrl()).toBe('https://override/setup');
        });

        it('callbackUrl falls back to webAppUrl + path, env override wins', () => {
            expect(config.githubApp.callbackUrl()).toBe(
                'http://localhost:3000/api/github-app/callback',
            );
            process.env.GITHUB_APP_CALLBACK_URL = 'https://override/cb';
            expect(config.githubApp.callbackUrl()).toBe('https://override/cb');
        });
    });

    describe('config.work', () => {
        it('staleTimeoutHours defaults to 2 (parsed base-10)', () => {
            expect(config.work.staleTimeoutHours()).toBe(2);
        });

        it('respects WORK_STALE_TIMEOUT_HOURS env override', () => {
            process.env.WORK_STALE_TIMEOUT_HOURS = '24';
            expect(config.work.staleTimeoutHours()).toBe(24);
        });

        it('returns NaN for non-numeric value (documents current behavior)', () => {
            process.env.WORK_STALE_TIMEOUT_HOURS = 'abc';
            expect(Number.isNaN(config.work.staleTimeoutHours())).toBe(true);
        });
    });

    describe('config.features.zeroFrictionOnboarding', () => {
        it('defaults to true when env unset', () => {
            expect(config.features.zeroFrictionOnboarding()).toBe(true);
        });

        it('returns false only for case-insensitive "false"', () => {
            process.env.FEATURE_ZERO_FRICTION_ONBOARDING = 'false';
            expect(config.features.zeroFrictionOnboarding()).toBe(false);
            process.env.FEATURE_ZERO_FRICTION_ONBOARDING = 'FALSE';
            expect(config.features.zeroFrictionOnboarding()).toBe(false);
            process.env.FEATURE_ZERO_FRICTION_ONBOARDING = 'False';
            expect(config.features.zeroFrictionOnboarding()).toBe(false);
        });

        it('returns true for "true"/"yes"/"1"/random values', () => {
            for (const v of ['true', 'yes', '1', 'enabled', 'whatever']) {
                process.env.FEATURE_ZERO_FRICTION_ONBOARDING = v;
                expect(config.features.zeroFrictionOnboarding()).toBe(true);
            }
        });
    });
});
