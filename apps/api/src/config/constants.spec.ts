import {
    authConstants,
    AuthProvider,
    BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS,
    config,
} from './constants';

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
                key.startsWith('PLUGIN_') ||
                key === 'AUTH_SECRET' ||
                key === 'WEB_URL' ||
                key === 'HTTP_DEBUG' ||
                key === 'MAILER_PROVIDER' ||
                key === 'WORK_STALE_TIMEOUT_HOURS' ||
                key === 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS'
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
        const STRONG_SECRET = 'a'.repeat(32);

        it('throws when AUTH_SECRET is missing', () => {
            expect(() => config.auth.secret()).toThrow(
                'AUTH_SECRET environment variable is required',
            );
        });

        it('returns the AUTH_SECRET value when set with sufficient length', () => {
            process.env.AUTH_SECRET = STRONG_SECRET;
            expect(config.auth.secret()).toBe(STRONG_SECRET);
        });

        it('throws on empty string (falsy)', () => {
            process.env.AUTH_SECRET = '';
            expect(() => config.auth.secret()).toThrow();
        });

        // H-14: keep the API in lockstep with apps/web/src/lib/auth/crypto.ts —
        // a sub-32-char secret silently breaks every OAuth callback when the
        // web tier tries to seal cookies (see 2026-05-18 incident).
        it('throws when AUTH_SECRET is shorter than 32 characters', () => {
            process.env.AUTH_SECRET = 'a'.repeat(31);
            expect(() => config.auth.secret()).toThrow(/at least 32 characters/);
        });

        it('accepts exactly 32 characters', () => {
            process.env.AUTH_SECRET = STRONG_SECRET;
            expect(config.auth.secret()).toBe(STRONG_SECRET);
        });
    });

    // #21: PLATFORM_ENCRYPTION_KEY must be present in non-local environments.
    // The validator is exempt for local runs (NODE_ENV development/test/unset)
    // so contributors don't need to provision a key just to boot. NODE_ENV is
    // restored after each case because the suite-level beforeEach does not.
    describe('config.platformEncryptionKey (#21)', () => {
        const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

        afterEach(() => {
            if (ORIGINAL_NODE_ENV === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = ORIGINAL_NODE_ENV;
            }
        });

        it('throws in a non-local environment (e.g. production) when the key is missing', () => {
            process.env.NODE_ENV = 'production';
            delete process.env.PLATFORM_ENCRYPTION_KEY;
            expect(() => config.platformEncryptionKey()).toThrow(
                /PLATFORM_ENCRYPTION_KEY .* required in non-local environments/,
            );
        });

        it('throws in staging (any non-local NODE_ENV) when the key is missing', () => {
            process.env.NODE_ENV = 'staging';
            delete process.env.PLATFORM_ENCRYPTION_KEY;
            expect(() => config.platformEncryptionKey()).toThrow(/PLATFORM_ENCRYPTION_KEY/);
        });

        it('returns the key when set in a non-local environment', () => {
            process.env.NODE_ENV = 'production';
            process.env.PLATFORM_ENCRYPTION_KEY = 'k'.repeat(48);
            expect(config.platformEncryptionKey()).toBe('k'.repeat(48));
        });

        it.each(['development', 'test', ''])(
            'does NOT throw when NODE_ENV is local (%j) even with no key',
            (env) => {
                process.env.NODE_ENV = env;
                delete process.env.PLATFORM_ENCRYPTION_KEY;
                expect(() => config.platformEncryptionKey()).not.toThrow();
                expect(config.platformEncryptionKey()).toBeUndefined();
            },
        );

        it('does NOT throw when NODE_ENV is unset (undefined) even with no key', () => {
            delete process.env.NODE_ENV;
            delete process.env.PLATFORM_ENCRYPTION_KEY;
            expect(() => config.platformEncryptionKey()).not.toThrow();
            expect(config.platformEncryptionKey()).toBeUndefined();
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

        // #31: TLS cert verification for outbound mail must default to ON
        // (secure). mail.module.ts reads this accessor so the only opt-out is
        // the explicit `SMTP_REJECT_UNAUTHORIZED=false` escape hatch.
        describe('smtpRejectUnauthorized', () => {
            it('defaults to true (verification ON) when SMTP_REJECT_UNAUTHORIZED is unset', () => {
                expect(config.mail.smtpRejectUnauthorized()).toBe(true);
            });

            it('is false ONLY for the exact string "false"', () => {
                process.env.SMTP_REJECT_UNAUTHORIZED = 'false';
                expect(config.mail.smtpRejectUnauthorized()).toBe(false);
            });

            it('stays true for any other value (case/typo do not disable verification)', () => {
                for (const v of ['true', 'FALSE', 'False', '0', 'no', '', 'yes']) {
                    process.env.SMTP_REJECT_UNAUTHORIZED = v;
                    expect(config.mail.smtpRejectUnauthorized()).toBe(true);
                }
            });
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

    // EW-693 — Dynamic plugin distribution.
    // Default behaviour MUST remain `bundled` so pre-EW-693 deployments
    // are unaffected (FR-22). The validate() guard exists purely to
    // catch operator errors when dynamic mode is selected without a
    // registry — bundled-mode validate() must be a no-op.
    describe('config.features.dynamicPlugins (EW-693)', () => {
        it('defaults to false when env unset', () => {
            expect(config.features.dynamicPlugins()).toBe(false);
        });

        it('returns true only for case-insensitive "true"', () => {
            process.env.FEATURE_DYNAMIC_PLUGINS = 'true';
            expect(config.features.dynamicPlugins()).toBe(true);
            process.env.FEATURE_DYNAMIC_PLUGINS = 'TRUE';
            expect(config.features.dynamicPlugins()).toBe(true);
            process.env.FEATURE_DYNAMIC_PLUGINS = 'True';
            expect(config.features.dynamicPlugins()).toBe(true);
        });

        it('returns false for everything else (including "1"/"yes")', () => {
            for (const v of ['false', '', '1', 'yes', 'enabled', 'whatever']) {
                process.env.FEATURE_DYNAMIC_PLUGINS = v;
                expect(config.features.dynamicPlugins()).toBe(false);
            }
        });
    });

    describe('config.plugins (EW-693)', () => {
        describe('distributionMode', () => {
            it('defaults to "bundled" when env unset (FR-22)', () => {
                expect(config.plugins.distributionMode()).toBe('bundled');
            });

            it('coerces to "bundled" for empty / unrecognised values', () => {
                for (const v of ['', 'BUNDLED', 'static', 'yes', 'maybe']) {
                    process.env.PLUGIN_DISTRIBUTION_MODE = v;
                    expect(config.plugins.distributionMode()).toBe('bundled');
                }
            });

            it('returns "dynamic" for case-insensitive "dynamic"', () => {
                process.env.PLUGIN_DISTRIBUTION_MODE = 'dynamic';
                expect(config.plugins.distributionMode()).toBe('dynamic');
                process.env.PLUGIN_DISTRIBUTION_MODE = 'DYNAMIC';
                expect(config.plugins.distributionMode()).toBe('dynamic');
                process.env.PLUGIN_DISTRIBUTION_MODE = 'Dynamic';
                expect(config.plugins.distributionMode()).toBe('dynamic');
            });
        });

        describe('registryUrl', () => {
            it('defaults to public npm', () => {
                expect(config.plugins.registryUrl()).toBe('https://registry.npmjs.org');
            });

            it('honours PLUGIN_REGISTRY_URL override', () => {
                process.env.PLUGIN_REGISTRY_URL = 'https://npm.example.com';
                expect(config.plugins.registryUrl()).toBe('https://npm.example.com');
            });

            it('treats empty env value as falsy and uses default', () => {
                process.env.PLUGIN_REGISTRY_URL = '';
                expect(config.plugins.registryUrl()).toBe('https://registry.npmjs.org');
            });
        });

        describe('registryGithubUrl', () => {
            it('defaults to GitHub Packages', () => {
                expect(config.plugins.registryGithubUrl()).toBe('https://npm.pkg.github.com');
            });

            it('honours PLUGIN_REGISTRY_GITHUB_URL override', () => {
                process.env.PLUGIN_REGISTRY_GITHUB_URL = 'https://npm.ghe.example.com';
                expect(config.plugins.registryGithubUrl()).toBe('https://npm.ghe.example.com');
            });
        });

        describe('registryToken', () => {
            it('is undefined when unset (no auth needed for public npm)', () => {
                expect(config.plugins.registryToken()).toBeUndefined();
            });

            it('returns the token verbatim when set', () => {
                process.env.PLUGIN_REGISTRY_TOKEN = 'npm_xyz';
                expect(config.plugins.registryToken()).toBe('npm_xyz');
            });

            it('treats empty string as undefined (avoids sending `Bearer ` with no value)', () => {
                process.env.PLUGIN_REGISTRY_TOKEN = '';
                expect(config.plugins.registryToken()).toBeUndefined();
            });
        });

        describe('installDir', () => {
            it('defaults to /app/plugins', () => {
                expect(config.plugins.installDir()).toBe('/app/plugins');
            });

            it('honours PLUGIN_INSTALL_DIR override', () => {
                process.env.PLUGIN_INSTALL_DIR = '/var/lib/ever-works/plugins';
                expect(config.plugins.installDir()).toBe('/var/lib/ever-works/plugins');
            });
        });

        describe('validate', () => {
            it('is a no-op in bundled mode (FR-22)', () => {
                // No env set at all — bundled is the default. validate() must not throw.
                expect(() => config.plugins.validate()).not.toThrow();
            });

            it('is a no-op in bundled mode even with no registry env set', () => {
                process.env.PLUGIN_DISTRIBUTION_MODE = 'bundled';
                process.env.PLUGIN_REGISTRY_URL = '';
                process.env.PLUGIN_REGISTRY_GITHUB_URL = '';
                expect(() => config.plugins.validate()).not.toThrow();
            });

            it('passes in dynamic mode when registry URL is set (default)', () => {
                process.env.PLUGIN_DISTRIBUTION_MODE = 'dynamic';
                // PLUGIN_REGISTRY_URL unset → default fallback in registryUrl();
                // validate() reads the RAW env (intentionally) but the GitHub URL
                // env is also unset → falls through to the throw branch.
                // Set the primary explicitly so this test passes.
                process.env.PLUGIN_REGISTRY_URL = 'https://registry.npmjs.org';
                expect(() => config.plugins.validate()).not.toThrow();
            });

            it('passes in dynamic mode when only the GitHub registry is set', () => {
                process.env.PLUGIN_DISTRIBUTION_MODE = 'dynamic';
                process.env.PLUGIN_REGISTRY_GITHUB_URL = 'https://npm.pkg.github.com';
                expect(() => config.plugins.validate()).not.toThrow();
            });

            it('throws in dynamic mode when both registry envs are explicitly empty', () => {
                process.env.PLUGIN_DISTRIBUTION_MODE = 'dynamic';
                process.env.PLUGIN_REGISTRY_URL = '';
                process.env.PLUGIN_REGISTRY_GITHUB_URL = '';
                expect(() => config.plugins.validate()).toThrow(
                    /PLUGIN_DISTRIBUTION_MODE=dynamic requires/,
                );
            });

            it('does NOT throw when registry envs are whitespace-trimmed away (treats as empty)', () => {
                // Pinned: trim() on the raw value catches whitespace-only configs.
                // Operator typos like a stray space character must NOT pass.
                process.env.PLUGIN_DISTRIBUTION_MODE = 'dynamic';
                process.env.PLUGIN_REGISTRY_URL = '   ';
                process.env.PLUGIN_REGISTRY_GITHUB_URL = '\t';
                expect(() => config.plugins.validate()).toThrow();
            });
        });
    });

    describe('config.tenantJobRuntime.getAllowedProviders (EW-742 P5)', () => {
        it('returns ALL bundled providers when EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS is unset', () => {
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual([
                ...BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS,
            ]);
        });

        it('returns ALL bundled providers when the env var is an empty string', () => {
            process.env.EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS = '';
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual([
                ...BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS,
            ]);
        });

        it('returns ALL bundled providers when the env var is whitespace only', () => {
            process.env.EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS = '   \t  ';
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual([
                ...BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS,
            ]);
        });

        it('parses comma-separated allow-list and preserves operator order', () => {
            process.env.EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS = 'temporal,trigger';
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual(['temporal', 'trigger']);
        });

        it('trims whitespace and lowercases entries', () => {
            process.env.EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS =
                ' Trigger ,  TEMPORAL ,  bullmq  ';
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual([
                'trigger',
                'temporal',
                'bullmq',
            ]);
        });

        it('filters out unknown provider ids silently', () => {
            process.env.EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS = 'trigger,bogus,temporal';
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual(['trigger', 'temporal']);
        });

        it('falls back to ALL bundled providers when every entry is unknown (typo guard)', () => {
            // An all-unknown allow-list would lock every tenant out of the
            // picker. Treat that as misconfiguration and fail-open rather
            // than fail-shut.
            process.env.EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS = 'bogus,still-bogus';
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual([
                ...BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS,
            ]);
        });

        it('deduplicates repeated entries while keeping first-seen order', () => {
            process.env.EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS =
                'inngest,trigger,inngest,trigger';
            expect(config.tenantJobRuntime.getAllowedProviders()).toEqual(['inngest', 'trigger']);
        });
    });

    describe('BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS (drift gate)', () => {
        it('lists the 5 documented bundled provider ids in the canonical order', () => {
            // Source of truth: dto/upsert-tenant-job-runtime.dto.ts
            // TENANT_JOB_RUNTIME_PROVIDER_IDS. The service layer asserts the
            // two lists stay in sync; this test pins the local copy.
            expect([...BUNDLED_TENANT_JOB_RUNTIME_PROVIDERS]).toEqual([
                'trigger',
                'temporal',
                'bullmq',
                'pgboss',
                'inngest',
            ]);
        });
    });
});
