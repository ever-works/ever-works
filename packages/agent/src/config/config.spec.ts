import { config } from './index';

/**
 * Tests for the central agent `config` object — every getter is just a tiny
 * `process.env` lookup, but together they encode every default the platform
 * relies on (database type, dispatch interval, plan code, schedule timeout,
 * Stripe / Sentry / PostHog / GitHub App env mapping, etc.). This suite pins
 * each branch — explicit value, default, and where applicable, alternate
 * env-var fallbacks like `NEXT_PUBLIC_*` for branding.
 */
describe('agent/config', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        // Start each test with an empty env so default branches are exercised.
        // Tests that need a value set it explicitly via process.env.<KEY> = ...
        process.env = {};
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('top-level getters', () => {
        describe('getEnvironment', () => {
            it('returns process.env.NODE_ENV verbatim', () => {
                process.env.NODE_ENV = 'production';
                expect(config.getEnvironment()).toBe('production');
            });

            it('returns undefined when NODE_ENV is unset', () => {
                expect(config.getEnvironment()).toBeUndefined();
            });
        });

        describe('getAppType', () => {
            it("defaults to 'api' when APP_TYPE is unset", () => {
                expect(config.getAppType()).toBe('api');
            });

            it("returns 'cli' when APP_TYPE='cli'", () => {
                process.env.APP_TYPE = 'cli';
                expect(config.getAppType()).toBe('cli');
            });

            it("returns 'api' when APP_TYPE='api'", () => {
                process.env.APP_TYPE = 'api';
                expect(config.getAppType()).toBe('api');
            });
        });

        describe('isCli', () => {
            it('returns true only when APP_TYPE=cli', () => {
                process.env.APP_TYPE = 'cli';
                expect(config.isCli()).toBe(true);
            });

            it('returns false for default (api)', () => {
                expect(config.isCli()).toBe(false);
            });

            it('returns false for explicit api', () => {
                process.env.APP_TYPE = 'api';
                expect(config.isCli()).toBe(false);
            });
        });
    });

    describe('config.trigger', () => {
        it("isEnabled returns true ONLY for the literal string 'true'", () => {
            process.env.TRIGGER_ENABLED = 'true';
            expect(config.trigger.isEnabled()).toBe(true);
        });

        it("isEnabled returns false for 'false', '1', 'yes', and unset", () => {
            for (const value of ['false', '1', 'yes', 'TRUE']) {
                process.env.TRIGGER_ENABLED = value;
                expect(config.trigger.isEnabled()).toBe(false);
            }
            delete process.env.TRIGGER_ENABLED;
            expect(config.trigger.isEnabled()).toBe(false);
        });

        it('getSecretKey passes through TRIGGER_SECRET_KEY', () => {
            process.env.TRIGGER_SECRET_KEY = 'tr_secret_xyz';
            expect(config.trigger.getSecretKey()).toBe('tr_secret_xyz');
        });

        it('getSecretKey returns undefined when unset', () => {
            expect(config.trigger.getSecretKey()).toBeUndefined();
        });

        it("getApiUrl defaults to 'https://api.trigger.dev' when unset", () => {
            expect(config.trigger.getApiUrl()).toBe('https://api.trigger.dev');
        });

        it('getApiUrl uses TRIGGER_API_URL when set', () => {
            process.env.TRIGGER_API_URL = 'https://custom.trigger.example.com';
            expect(config.trigger.getApiUrl()).toBe('https://custom.trigger.example.com');
        });

        it('getMachine returns undefined when unset (NOT empty string — the OR collapses falsy)', () => {
            expect(config.trigger.getMachine()).toBeUndefined();
        });

        it('getMachine returns undefined for explicit empty string (`|| undefined` branch)', () => {
            process.env.TRIGGER_MACHINE = '';
            expect(config.trigger.getMachine()).toBeUndefined();
        });

        it('getMachine returns the value when set', () => {
            process.env.TRIGGER_MACHINE = 'large-2x';
            expect(config.trigger.getMachine()).toBe('large-2x');
        });

        it('getInternalBaseUrl + getInternalSecret pass through their env vars', () => {
            process.env.TRIGGER_INTERNAL_API_URL = 'http://api:3100';
            process.env.TRIGGER_INTERNAL_SECRET = 'shared-secret';
            expect(config.trigger.getInternalBaseUrl()).toBe('http://api:3100');
            expect(config.trigger.getInternalSecret()).toBe('shared-secret');
        });

        describe('shouldUseTrigger', () => {
            it('returns true only when isEnabled() AND getInternalSecret() is set', () => {
                process.env.TRIGGER_ENABLED = 'true';
                process.env.TRIGGER_INTERNAL_SECRET = 'shared-secret';
                expect(config.trigger.shouldUseTrigger()).toBe(true);
            });

            it('returns false when enabled but no internal secret', () => {
                process.env.TRIGGER_ENABLED = 'true';
                expect(config.trigger.shouldUseTrigger()).toBe(false);
            });

            it('returns false when internal secret set but not enabled', () => {
                process.env.TRIGGER_INTERNAL_SECRET = 'shared-secret';
                expect(config.trigger.shouldUseTrigger()).toBe(false);
            });

            it('returns false when both unset', () => {
                expect(config.trigger.shouldUseTrigger()).toBe(false);
            });

            it('returns false when internal secret is empty string (Boolean coerces to false)', () => {
                process.env.TRIGGER_ENABLED = 'true';
                process.env.TRIGGER_INTERNAL_SECRET = '';
                expect(config.trigger.shouldUseTrigger()).toBe(false);
            });
        });
    });

    describe('config.database', () => {
        describe('getType', () => {
            it("defaults to 'better-sqlite3' when DATABASE_TYPE is unset", () => {
                expect(config.database.getType()).toBe('better-sqlite3');
            });

            it('returns DATABASE_TYPE verbatim when set', () => {
                process.env.DATABASE_TYPE = 'postgres';
                expect(config.database.getType()).toBe('postgres');
            });
        });

        describe('isSqlite', () => {
            it('returns true for default (better-sqlite3)', () => {
                expect(config.database.isSqlite()).toBe(true);
            });

            it('returns true for sqlite', () => {
                process.env.DATABASE_TYPE = 'sqlite';
                expect(config.database.isSqlite()).toBe(true);
            });

            it('returns true for any string containing "sqlite"', () => {
                process.env.DATABASE_TYPE = 'better-sqlite3';
                expect(config.database.isSqlite()).toBe(true);
            });

            it('returns false for postgres', () => {
                process.env.DATABASE_TYPE = 'postgres';
                expect(config.database.isSqlite()).toBe(false);
            });

            it('returns false for mysql', () => {
                process.env.DATABASE_TYPE = 'mysql';
                expect(config.database.isSqlite()).toBe(false);
            });
        });

        it.each([
            ['DATABASE_URL', 'getUrl', 'postgres://localhost/x'],
            ['DATABASE_HOST', 'getHost', 'localhost'],
            ['DATABASE_PORT', 'getPort', '5432'],
            ['DATABASE_PATH', 'getPath', '/var/lib/db.sqlite'],
            ['DATABASE_USERNAME', 'getUsername', 'admin'],
            ['DATABASE_PASSWORD', 'getPassword', 's3cret'],
            ['DATABASE_NAME', 'getDatabaseName', 'everworks'],
            ['DATABASE_CA_CERT', 'databaseCaCert', '-----BEGIN CERTIFICATE-----'],
        ])('%s passthrough via %s', (envVar, getter, value) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (process.env as any)[envVar] = value;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((config.database as any)[getter]()).toBe(value);
        });

        it.each([
            ['DATABASE_URL', 'getUrl'],
            ['DATABASE_HOST', 'getHost'],
            ['DATABASE_PORT', 'getPort'],
            ['DATABASE_PATH', 'getPath'],
            ['DATABASE_USERNAME', 'getUsername'],
            ['DATABASE_PASSWORD', 'getPassword'],
            ['DATABASE_NAME', 'getDatabaseName'],
            ['DATABASE_CA_CERT', 'databaseCaCert'],
        ])('%s returns undefined when unset (via %s)', (_envVar, getter) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((config.database as any)[getter]()).toBeUndefined();
        });

        // C-07 PR-B: the safer default is now OFF everywhere except the unit-test
        // env. Explicit "true" opts back in; anything else (including the empty
        // string) leaves the flag off. The k8s manifests already pin
        // DATABASE_AUTOMIGRATE=false (PR-A) — this is the belt+suspenders so a
        // forgotten env var doesn't run TypeORM `synchronize` against prod.
        describe('autoMigrate (default-off everywhere except NODE_ENV=test)', () => {
            it('returns false when DATABASE_AUTOMIGRATE is unset and NODE_ENV is unset', () => {
                expect(config.database.autoMigrate()).toBe(false);
            });

            it("returns true when DATABASE_AUTOMIGRATE='true' (explicit opt-in)", () => {
                process.env.DATABASE_AUTOMIGRATE = 'true';
                expect(config.database.autoMigrate()).toBe(true);
            });

            it("returns false when DATABASE_AUTOMIGRATE='false'", () => {
                process.env.DATABASE_AUTOMIGRATE = 'false';
                expect(config.database.autoMigrate()).toBe(false);
            });

            it("returns false for non-'true' values like '0', 'no', 'FALSE'", () => {
                for (const value of ['0', 'no', 'FALSE', 'False']) {
                    process.env.DATABASE_AUTOMIGRATE = value;
                    expect(config.database.autoMigrate()).toBe(false);
                }
            });

            it("returns true when NODE_ENV='test' and DATABASE_AUTOMIGRATE is unset", () => {
                process.env.NODE_ENV = 'test';
                expect(config.database.autoMigrate()).toBe(true);
            });

            it("returns false when NODE_ENV='test' but DATABASE_AUTOMIGRATE='false' (explicit override beats test env)", () => {
                process.env.NODE_ENV = 'test';
                process.env.DATABASE_AUTOMIGRATE = 'false';
                expect(config.database.autoMigrate()).toBe(false);
            });
        });

        describe('loggingEnabled / sslMode / getInMemory (strict "true" gates)', () => {
            it.each([
                ['DATABASE_LOGGING', 'loggingEnabled'],
                ['DATABASE_SSL_MODE', 'sslMode'],
                ['DATABASE_IN_MEMORY', 'getInMemory'],
            ])("%s returns true ONLY for literal 'true' (via %s)", (envVar, getter) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (process.env as any)[envVar] = 'true';
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                expect((config.database as any)[getter]()).toBe(true);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (process.env as any)[envVar] = 'TRUE';
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                expect((config.database as any)[getter]()).toBe(false);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (process.env as any)[envVar] = '1';
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                expect((config.database as any)[getter]()).toBe(false);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                delete (process.env as any)[envVar];
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                expect((config.database as any)[getter]()).toBe(false);
            });
        });
    });

    describe('config.github + githubApp + git', () => {
        it('github.getApiKey passes through GH_APIKEY', () => {
            process.env.GH_APIKEY = 'ghp_token';
            expect(config.github.getApiKey()).toBe('ghp_token');
        });

        it('github.getOwner passes through GH_OWNER', () => {
            process.env.GH_OWNER = 'ever-works';
            expect(config.github.getOwner()).toBe('ever-works');
        });

        it('github.* return undefined when unset', () => {
            expect(config.github.getApiKey()).toBeUndefined();
            expect(config.github.getOwner()).toBeUndefined();
        });

        it('githubApp.getAppId passes through GITHUB_APP_ID', () => {
            process.env.GITHUB_APP_ID = '123456';
            expect(config.githubApp.getAppId()).toBe('123456');
        });

        it('githubApp.getPrivateKey rewrites \\\\n into real newlines', () => {
            process.env.GITHUB_APP_PRIVATE_KEY =
                '-----BEGIN PRIVATE KEY-----\\nABC\\nDEF\\n-----END PRIVATE KEY-----';
            expect(config.githubApp.getPrivateKey()).toBe(
                '-----BEGIN PRIVATE KEY-----\nABC\nDEF\n-----END PRIVATE KEY-----',
            );
        });

        it('githubApp.getPrivateKey returns undefined when unset (no replace called)', () => {
            expect(config.githubApp.getPrivateKey()).toBeUndefined();
        });

        it('githubApp.getPrivateKey leaves a key without \\\\n untouched', () => {
            process.env.GITHUB_APP_PRIVATE_KEY = 'no-escapes-here';
            expect(config.githubApp.getPrivateKey()).toBe('no-escapes-here');
        });

        it('git.getName + git.getEmail pass through GIT_NAME and GIT_EMAIL', () => {
            process.env.GIT_NAME = 'Ever Works Bot';
            process.env.GIT_EMAIL = 'bot@ever.works';
            expect(config.git.getName()).toBe('Ever Works Bot');
            expect(config.git.getEmail()).toBe('bot@ever.works');
        });
    });

    describe('config.sentry + posthog', () => {
        it.each([
            ['SENTRY_DSN', 'sentry', 'getDsn', 'https://dsn@sentry.io/1'],
            ['SENTRY_PROJECT_ID', 'sentry', 'getProjectId', '12345'],
            ['POSTHOG_API_KEY', 'posthog', 'getApiKey', 'phc_xyz'],
            ['POSTHOG_HOST', 'posthog', 'getHost', 'https://eu.posthog.com'],
        ])('%s passthrough via %s.%s', (envVar, group, getter, value) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (process.env as any)[envVar] = value;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((config as any)[group][getter]()).toBe(value);
        });

        it('sentry + posthog getters all return undefined when env unset', () => {
            expect(config.sentry.getDsn()).toBeUndefined();
            expect(config.sentry.getProjectId()).toBeUndefined();
            expect(config.posthog.getApiKey()).toBeUndefined();
            expect(config.posthog.getHost()).toBeUndefined();
        });
    });

    describe('config.subscriptions', () => {
        it("isEnabled returns true ONLY for literal 'true'", () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'true';
            expect(config.subscriptions.isEnabled()).toBe(true);
        });

        it('isEnabled returns false when unset / non-"true"', () => {
            expect(config.subscriptions.isEnabled()).toBe(false);
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            expect(config.subscriptions.isEnabled()).toBe(false);
            process.env.SUBSCRIPTIONS_ENABLED = '1';
            expect(config.subscriptions.isEnabled()).toBe(false);
        });

        describe('scheduledUpdatesEnabled (default-on)', () => {
            it('defaults to true when unset', () => {
                expect(config.subscriptions.scheduledUpdatesEnabled()).toBe(true);
            });

            it("only flips to false on the literal string 'false'", () => {
                process.env.SCHEDULED_UPDATES_ENABLED = 'false';
                expect(config.subscriptions.scheduledUpdatesEnabled()).toBe(false);
            });

            it("returns true for any other value, including '0' and 'FALSE'", () => {
                process.env.SCHEDULED_UPDATES_ENABLED = '0';
                expect(config.subscriptions.scheduledUpdatesEnabled()).toBe(true);
                process.env.SCHEDULED_UPDATES_ENABLED = 'FALSE';
                expect(config.subscriptions.scheduledUpdatesEnabled()).toBe(true);
                process.env.SCHEDULED_UPDATES_ENABLED = 'true';
                expect(config.subscriptions.scheduledUpdatesEnabled()).toBe(true);
            });
        });

        describe('getDispatchIntervalMinutes', () => {
            it('defaults to 5 when env is unset', () => {
                expect(config.subscriptions.getDispatchIntervalMinutes()).toBe(5);
            });

            it('parses an integer string', () => {
                process.env.SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES = '15';
                expect(config.subscriptions.getDispatchIntervalMinutes()).toBe(15);
            });

            it('parseInt strips trailing non-numeric chars', () => {
                process.env.SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES = '10min';
                expect(config.subscriptions.getDispatchIntervalMinutes()).toBe(10);
            });
        });

        describe('getMaxBatch', () => {
            it('defaults to 25 when env is unset', () => {
                expect(config.subscriptions.getMaxBatch()).toBe(25);
            });

            it('parses an integer string', () => {
                process.env.SCHEDULED_UPDATES_MAX_BATCH = '100';
                expect(config.subscriptions.getMaxBatch()).toBe(100);
            });
        });

        describe('getDefaultPlanCode', () => {
            it("defaults to 'free' when env is unset", () => {
                expect(config.subscriptions.getDefaultPlanCode()).toBe('free');
            });

            it('returns the env value verbatim (no normalisation here)', () => {
                process.env.SUBSCRIPTIONS_DEFAULT_PLAN = 'STANDARD';
                expect(config.subscriptions.getDefaultPlanCode()).toBe('STANDARD');
            });
        });

        describe('getMaxFailureBeforePause', () => {
            it('defaults to 3 when env is unset', () => {
                expect(config.subscriptions.getMaxFailureBeforePause()).toBe(3);
            });

            it('parses an integer string', () => {
                process.env.SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE = '7';
                expect(config.subscriptions.getMaxFailureBeforePause()).toBe(7);
            });
        });

        describe('getScheduleStuckTimeoutMinutes', () => {
            it('defaults to 180 when env is unset', () => {
                expect(config.subscriptions.getScheduleStuckTimeoutMinutes()).toBe(180);
            });

            it('parses an integer string', () => {
                process.env.SCHEDULE_STUCK_TIMEOUT_MINUTES = '60';
                expect(config.subscriptions.getScheduleStuckTimeoutMinutes()).toBe(60);
            });
        });

        describe('getPayPerUsePriceCents', () => {
            it('defaults to 500 cents (= $5) when env is unset', () => {
                expect(config.subscriptions.getPayPerUsePriceCents()).toBe(500);
            });

            it('multiplies dollar string by 100 and rounds', () => {
                process.env.PAY_PER_USE_PRICE_USD = '0.99';
                expect(config.subscriptions.getPayPerUsePriceCents()).toBe(99);
            });

            it('rounds to nearest cent', () => {
                process.env.PAY_PER_USE_PRICE_USD = '0.005';
                // 0.005 * 100 = 0.5 → Math.round(0.5) = 1 in IEEE-754 (round-half-to-even may vary,
                // but Math.round in JS uses round-half-up so 0.5 → 1).
                expect(config.subscriptions.getPayPerUsePriceCents()).toBe(1);
            });

            it('clamps negative inputs to 0', () => {
                process.env.PAY_PER_USE_PRICE_USD = '-3';
                expect(config.subscriptions.getPayPerUsePriceCents()).toBe(0);
            });

            it('parseFloat-tolerant of trailing non-numeric chars', () => {
                process.env.PAY_PER_USE_PRICE_USD = '4.50abc';
                expect(config.subscriptions.getPayPerUsePriceCents()).toBe(450);
            });

            it('returns 0 when env value is non-numeric (parseFloat → NaN, NaN*100 → NaN, Math.max(0, NaN) → NaN — but Math.round(NaN) → NaN, then Math.max again returns NaN)', () => {
                // We intentionally pin the WHOLE arithmetic chain here so future
                // refactors don't silently regress the clamp. Math.max(0, NaN) is NaN
                // because NaN comparisons are always false. So if the env contains
                // garbage, the result is NaN, not 0. This documents current behavior.
                process.env.PAY_PER_USE_PRICE_USD = 'abc';
                expect(Number.isNaN(config.subscriptions.getPayPerUsePriceCents())).toBe(true);
            });

            it("treats explicit empty string as default (because '' || '5' === '5')", () => {
                process.env.PAY_PER_USE_PRICE_USD = '';
                expect(config.subscriptions.getPayPerUsePriceCents()).toBe(500);
            });
        });
    });

    describe('config.websiteTemplate', () => {
        describe('autoUpdateEnabled (default-on; only "false" flips)', () => {
            it('defaults to true when env is unset', () => {
                expect(config.websiteTemplate.autoUpdateEnabled()).toBe(true);
            });

            it("flips to false ONLY on literal 'false'", () => {
                process.env.WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED = 'false';
                expect(config.websiteTemplate.autoUpdateEnabled()).toBe(false);
            });

            it('returns true for non-"false" values', () => {
                process.env.WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED = '0';
                expect(config.websiteTemplate.autoUpdateEnabled()).toBe(true);
            });
        });

        it.each([
            ['getCatalogOrganization', 'WEBSITE_TEMPLATE_CATALOG_ORG', 'ever-works', 'my-org'],
            ['getDefaultTemplateId', 'WEBSITE_TEMPLATE_DEFAULT_ID', 'classic', 'minimal'],
            ['getBetaBranch', 'WEBSITE_TEMPLATE_BETA_BRANCH', 'stage', 'beta'],
            ['getMinimalOwner', 'WEBSITE_TEMPLATE_MINIMAL_OWNER', 'ever-works', 'other-org'],
            ['getMinimalBranch', 'WEBSITE_TEMPLATE_MINIMAL_BRANCH', 'main', 'develop'],
        ])(
            '%s defaults + override (%s default=%s override=%s)',
            (getter, envVar, defaultVal, overrideVal) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                expect((config.websiteTemplate as any)[getter]()).toBe(defaultVal);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (process.env as any)[envVar] = overrideVal;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                expect((config.websiteTemplate as any)[getter]()).toBe(overrideVal);
            },
        );

        describe('getMinimalRepo', () => {
            it('returns undefined when env is unset (no default — gates the Minimal seed)', () => {
                expect(config.websiteTemplate.getMinimalRepo()).toBeUndefined();
            });

            it('returns the env value verbatim', () => {
                process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = 'minimal-template';
                expect(config.websiteTemplate.getMinimalRepo()).toBe('minimal-template');
            });
        });

        describe('getMinimalBetaBranch (default null, NOT undefined)', () => {
            it('returns null when env is unset (literal `|| null`)', () => {
                expect(config.websiteTemplate.getMinimalBetaBranch()).toBeNull();
            });

            it('returns the env value when set', () => {
                process.env.WEBSITE_TEMPLATE_MINIMAL_BETA_BRANCH = 'beta-x';
                expect(config.websiteTemplate.getMinimalBetaBranch()).toBe('beta-x');
            });

            it('returns null for empty string (`"" || null` → null)', () => {
                process.env.WEBSITE_TEMPLATE_MINIMAL_BETA_BRANCH = '';
                expect(config.websiteTemplate.getMinimalBetaBranch()).toBeNull();
            });
        });
    });

    describe('config.billing', () => {
        it("getDefaultCurrency defaults to 'usd'", () => {
            expect(config.billing.getDefaultCurrency()).toBe('usd');
        });

        it('getDefaultCurrency uses BILLING_DEFAULT_CURRENCY when set', () => {
            process.env.BILLING_DEFAULT_CURRENCY = 'eur';
            expect(config.billing.getDefaultCurrency()).toBe('eur');
        });

        it('stripe.getSecretKey + getWebhookSecret pass through', () => {
            process.env.STRIPE_SECRET_KEY = 'sk_test_xyz';
            process.env.STRIPE_WEBHOOK_SECRET = 'whsec_xyz';
            expect(config.billing.stripe.getSecretKey()).toBe('sk_test_xyz');
            expect(config.billing.stripe.getWebhookSecret()).toBe('whsec_xyz');
        });

        it('stripe getters return undefined when unset', () => {
            expect(config.billing.stripe.getSecretKey()).toBeUndefined();
            expect(config.billing.stripe.getWebhookSecret()).toBeUndefined();
        });
    });

    describe('config.branding (three-level fallback chains)', () => {
        describe('getAppName', () => {
            it("falls back to 'Ever Works' when both APP_NAME and NEXT_PUBLIC_APP_NAME unset", () => {
                expect(config.branding.getAppName()).toBe('Ever Works');
            });

            it('prefers APP_NAME over NEXT_PUBLIC_APP_NAME', () => {
                process.env.APP_NAME = 'Server Name';
                process.env.NEXT_PUBLIC_APP_NAME = 'Public Name';
                expect(config.branding.getAppName()).toBe('Server Name');
            });

            it('uses NEXT_PUBLIC_APP_NAME when only it is set', () => {
                process.env.NEXT_PUBLIC_APP_NAME = 'Public Name';
                expect(config.branding.getAppName()).toBe('Public Name');
            });

            it('treats empty APP_NAME as falsy and falls through', () => {
                process.env.APP_NAME = '';
                process.env.NEXT_PUBLIC_APP_NAME = 'Public Name';
                expect(config.branding.getAppName()).toBe('Public Name');
            });
        });

        describe('getCompanyOwner', () => {
            it("defaults to 'Ever Co.' when both env vars unset", () => {
                expect(config.branding.getCompanyOwner()).toBe('Ever Co.');
            });

            it('prefers COMPANY_OWNER over NEXT_PUBLIC_COMPANY_OWNER', () => {
                process.env.COMPANY_OWNER = 'Ever Co. Pro';
                process.env.NEXT_PUBLIC_COMPANY_OWNER = 'Public Co.';
                expect(config.branding.getCompanyOwner()).toBe('Ever Co. Pro');
            });

            it('uses NEXT_PUBLIC_COMPANY_OWNER as fallback', () => {
                process.env.NEXT_PUBLIC_COMPANY_OWNER = 'Public Co.';
                expect(config.branding.getCompanyOwner()).toBe('Public Co.');
            });
        });

        describe('getPlatformWebsite', () => {
            it("defaults to 'https://ever.works' when all three env vars unset", () => {
                expect(config.branding.getPlatformWebsite()).toBe('https://ever.works');
            });

            it('prefers PLATFORM_WEBSITE over NEXT_PUBLIC_COMPANY_OWNER_WEBSITE', () => {
                process.env.PLATFORM_WEBSITE = 'https://primary.example';
                process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE = 'https://fallback.example';
                expect(config.branding.getPlatformWebsite()).toBe('https://primary.example');
            });

            it('uses NEXT_PUBLIC_COMPANY_OWNER_WEBSITE when only it is set', () => {
                process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE = 'https://fallback.example';
                expect(config.branding.getPlatformWebsite()).toBe('https://fallback.example');
            });
        });
    });

    describe('top-level shape (regression guard)', () => {
        it('exposes the full set of config groups', () => {
            const keys = Object.keys(config).sort();
            expect(keys).toEqual([
                'billing',
                'branding',
                'database',
                'everWorks',
                'getAppType',
                'getEnvironment',
                'git',
                'github',
                'githubApp',
                'isCli',
                'platformSync',
                'posthog',
                'sentry',
                'subscriptions',
                'trigger',
                'websiteTemplate',
            ]);
        });
    });
});
