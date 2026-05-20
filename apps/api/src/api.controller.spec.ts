// Stub the auth barrel so its transitive `@ever-works/agent/database`
// import is not pulled into this controller test.
jest.mock('./auth', () => ({
    Public: () => () => undefined,
}));
// Stub the monitoring package so the real PostHog client is not constructed.
jest.mock('@ever-works/monitoring', () => ({}));
// `config.branding.appName()` reads env on every call; stub it to a
// deterministic value so the /api/config spec doesn't depend on which
// env vars the test runner has set.
jest.mock('./config/constants', () => ({
    config: {
        branding: {
            appName: () => 'Ever Works',
        },
    },
}));

import { APIController } from './api.controller';
import type { AnalyticsService } from '@ever-works/monitoring';

describe('APIController', () => {
    let analytics: jest.Mocked<Pick<AnalyticsService, 'track'>>;
    let controller: APIController;

    beforeEach(() => {
        analytics = { track: jest.fn() } as any;
        controller = new APIController(analytics as unknown as AnalyticsService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('home', () => {
        it('returns the success envelope', () => {
            const result = controller.home();

            expect(result).toEqual({ status: 'success', message: 'API is up and running' });
        });

        it('emits an analytics track event with the anonymous distinct id and api_home_visit name', () => {
            controller.home();

            expect(analytics.track).toHaveBeenCalledTimes(1);
            const [distinctId, event, properties] = analytics.track.mock.calls[0]!;
            expect(distinctId).toBe('anonymous');
            expect(event).toBe('api_home_visit');
            expect(properties).toBeDefined();
            expect(properties!['endpoint']).toBe('/');
            expect(typeof properties!['timestamp']).toBe('string');
        });

        it('emits an ISO-8601 timestamp string', () => {
            jest.useFakeTimers().setSystemTime(new Date('2026-05-09T12:34:56.789Z'));

            controller.home();

            const [, , properties] = analytics.track.mock.calls[0]!;
            expect(properties!['timestamp']).toBe('2026-05-09T12:34:56.789Z');

            jest.useRealTimers();
        });

        it('still returns the envelope even when analytics.track throws (fire-and-forget)', () => {
            // Note: the current implementation does NOT wrap track() in a
            // try/catch, so analytics failures DO propagate. This test pins
            // the actual behaviour so any future "fire-and-forget" refactor
            // breaks loudly. Update the assertion alongside the refactor.
            analytics.track.mockImplementationOnce(() => {
                throw new Error('posthog down');
            });

            expect(() => controller.home()).toThrow('posthog down');
        });

        it('does not pass any user-identifying data in the analytics payload', () => {
            controller.home();

            const [distinctId, , properties] = analytics.track.mock.calls[0]!;
            expect(distinctId).toBe('anonymous');
            expect(properties).not.toHaveProperty('userId');
            expect(properties).not.toHaveProperty('email');
        });
    });

    describe('getConfig', () => {
        const SAVED_ENV: Record<string, string | undefined> = {};
        const ENV_KEYS = [
            'SUBSCRIPTIONS_ENABLED',
            'MAGIC_LINK_ENABLED',
            'ANONYMOUS_AUTH_ENABLED',
            'REQUIRE_EMAIL_VERIFICATION',
            'GH_CLIENT_ID',
            'GOOGLE_CLIENT_ID',
            'FB_CLIENT_ID',
            'BODY_LIMIT',
            'NEXT_PUBLIC_SITE_DESCRIPTION',
            'APP_DESCRIPTION',
        ];

        beforeEach(() => {
            for (const k of ENV_KEYS) {
                SAVED_ENV[k] = process.env[k];
                delete process.env[k];
            }
        });

        afterEach(() => {
            for (const k of ENV_KEYS) {
                if (SAVED_ENV[k] === undefined) delete process.env[k];
                else process.env[k] = SAVED_ENV[k];
            }
        });

        it('returns a stable shape with the expected top-level keys', () => {
            const r = controller.getConfig();
            expect(Object.keys(r).sort()).toEqual(['app', 'auth', 'features', 'limits']);
            expect(r.app.name).toBe('Ever Works');
        });

        it('honors NEXT_PUBLIC_SITE_DESCRIPTION before APP_DESCRIPTION', () => {
            process.env.APP_DESCRIPTION = 'fallback';
            process.env.NEXT_PUBLIC_SITE_DESCRIPTION = 'primary';
            expect(controller.getConfig().app.description).toBe('primary');
        });

        it.each([
            ['SUBSCRIPTIONS_ENABLED', 'subscriptionsEnabled'],
            ['MAGIC_LINK_ENABLED', 'magicLinkEnabled'],
            ['ANONYMOUS_AUTH_ENABLED', 'anonymousAuthEnabled'],
        ] as const)('reads %s as %s feature flag (truthy)', (envKey, flagKey) => {
            process.env[envKey] = 'true';
            const r = controller.getConfig();
            expect((r.features as Record<string, boolean>)[flagKey]).toBe(true);
        });

        it('treats REQUIRE_EMAIL_VERIFICATION as default-true (only "false" opts out)', () => {
            expect(controller.getConfig().features.emailVerificationRequired).toBe(true);
            process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
            expect(controller.getConfig().features.emailVerificationRequired).toBe(false);
        });

        it('signals OAuth provider presence as booleans only (never the client id)', () => {
            process.env.GH_CLIENT_ID = 'secret-github-id';
            process.env.GOOGLE_CLIENT_ID = 'secret-google-id';
            const r = controller.getConfig();
            expect(r.auth.providers).toEqual({ github: true, google: true, facebook: false });
            // The value MUST NOT appear anywhere in the payload.
            const flat = JSON.stringify(r);
            expect(flat).not.toContain('secret-github-id');
            expect(flat).not.toContain('secret-google-id');
        });

        it('refuses to leak server-side env shapes — sanity grep over the whole response', () => {
            // Set forbidden envs and confirm none make it into the payload.
            process.env.AUTH_SECRET = 'leaked-auth-secret';
            process.env.GH_CLIENT_SECRET = 'leaked-github-secret';
            process.env.GOOGLE_CLIENT_SECRET = 'leaked-google-secret';
            process.env.DATABASE_URL = 'postgres://leak:leak@host/db';
            process.env.STRIPE_SECRET_KEY = 'sk_test_leaked';
            const flat = JSON.stringify(controller.getConfig()).toLowerCase();
            for (const forbidden of [
                'leaked-auth-secret',
                'leaked-github-secret',
                'leaked-google-secret',
                'postgres://',
                'sk_test_leaked',
                'auth_secret',
                'database_url',
                'stripe_secret',
            ]) {
                expect(flat.includes(forbidden.toLowerCase())).toBe(false);
            }
        });
    });

    describe('healthCheck', () => {
        it('delegates to home() and returns the same envelope', () => {
            const homeSpy = jest.spyOn(controller, 'home');

            const result = controller.healthCheck();

            expect(homeSpy).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ status: 'success', message: 'API is up and running' });
        });

        it('emits an analytics track event (delegates through home())', () => {
            controller.healthCheck();

            // Health check still goes through the same code path, so analytics
            // fires. Sentry/PostHog noise filtering happens at the
            // monitoring-package level, not in this controller.
            expect(analytics.track).toHaveBeenCalledTimes(1);
            expect(analytics.track).toHaveBeenCalledWith(
                'anonymous',
                'api_home_visit',
                expect.objectContaining({ endpoint: '/' }),
            );
        });
    });
});
