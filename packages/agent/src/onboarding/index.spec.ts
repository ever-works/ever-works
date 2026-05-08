import * as onboarding from './index';

/**
 * The agent's `onboarding` barrel is intentionally minimal — it re-exports
 * a curated subset of the `services/`, `utils/`, and `database/repositories/`
 * surface so `apps/api/src/onboarding/` and `apps/mcp` can pull in only the
 * validators / DI symbols / minimal interfaces they need without pulling in
 * the entire facades + generators chain. This suite pins:
 *   1. The DI symbol identity (`Symbol.for(...)` registry-shared keys),
 *   2. Every documented named export is reachable via the barrel,
 *   3. No accidental extra exports (so a future addition lands as a deliberate
 *      change to BOTH the barrel and this test).
 *
 * Each underlying implementation already has its own focused spec; this is a
 * cross-package contract test.
 */
describe('agent/onboarding barrel', () => {
    describe('DI symbols (Symbol.for-based — registry-shared so DI containers in api/* find the same key)', () => {
        it('ONBOARDING_GIT_PROVIDER is Symbol.for("OnboardingGitProvider")', () => {
            expect(typeof onboarding.ONBOARDING_GIT_PROVIDER).toBe('symbol');
            expect(onboarding.ONBOARDING_GIT_PROVIDER.description).toBe('OnboardingGitProvider');
            expect(onboarding.ONBOARDING_GIT_PROVIDER).toBe(Symbol.for('OnboardingGitProvider'));
        });

        it('ONBOARDING_ACCOUNT_UPSERT is Symbol.for("OnboardingAccountUpsert")', () => {
            expect(typeof onboarding.ONBOARDING_ACCOUNT_UPSERT).toBe('symbol');
            expect(onboarding.ONBOARDING_ACCOUNT_UPSERT.description).toBe(
                'OnboardingAccountUpsert',
            );
            expect(onboarding.ONBOARDING_ACCOUNT_UPSERT).toBe(
                Symbol.for('OnboardingAccountUpsert'),
            );
        });

        it('ONBOARDING_WORK_CREATOR is Symbol.for("OnboardingWorkCreator")', () => {
            expect(typeof onboarding.ONBOARDING_WORK_CREATOR).toBe('symbol');
            expect(onboarding.ONBOARDING_WORK_CREATOR.description).toBe('OnboardingWorkCreator');
            expect(onboarding.ONBOARDING_WORK_CREATOR).toBe(Symbol.for('OnboardingWorkCreator'));
        });

        it('the three DI symbols are distinct', () => {
            const set = new Set<symbol>([
                onboarding.ONBOARDING_GIT_PROVIDER,
                onboarding.ONBOARDING_ACCOUNT_UPSERT,
                onboarding.ONBOARDING_WORK_CREATOR,
            ]);
            expect(set.size).toBe(3);
        });

        it('Symbol.for stability: re-evaluating Symbol.for(<key>) returns the same symbol', () => {
            // This is the WHOLE point of Symbol.for vs Symbol(): any caller
            // anywhere in the process can rebuild the symbol from its key. If
            // someone refactored these to bare `Symbol(...)` we would silently
            // break NestJS DI token equality across module boundaries.
            expect(Symbol.for('OnboardingGitProvider')).toBe(onboarding.ONBOARDING_GIT_PROVIDER);
            expect(Symbol.for('OnboardingAccountUpsert')).toBe(
                onboarding.ONBOARDING_ACCOUNT_UPSERT,
            );
            expect(Symbol.for('OnboardingWorkCreator')).toBe(onboarding.ONBOARDING_WORK_CREATOR);
        });
    });

    describe('runtime re-exports (services / utils)', () => {
        it.each<[keyof typeof onboarding]>([
            ['WorksManifestService'],
            ['WorksManifestV1Schema'],
            ['PRINTABLE_ASCII_PATTERN'],
            ['SUBDOMAIN_PATTERN'],
            ['isSafeWebhookUrl'],
            ['redactBody'],
            ['redactHeaders'],
            ['redactString'],
            ['REDACTED_BODY_FIELDS'],
            ['REDACTED_HEADERS'],
            ['WebhookDeliveryService'],
            ['FetchWebhookHttpClient'],
            ['WEBHOOK_HTTP_CLIENT'],
            ['WEBHOOK_SIGNATURE_HEADER'],
            ['StateMarkerService'],
            ['STATE_MARKER_DEFAULT_PATH'],
            ['OnboardingRequestRepository'],
            ['WebhookSubscriptionRepository'],
        ])('exposes %s', (name) => {
            expect(onboarding[name]).toBeDefined();
        });

        it('PRINTABLE_ASCII_PATTERN is a RegExp instance', () => {
            expect(onboarding.PRINTABLE_ASCII_PATTERN).toBeInstanceOf(RegExp);
        });

        it('SUBDOMAIN_PATTERN is a RegExp instance', () => {
            expect(onboarding.SUBDOMAIN_PATTERN).toBeInstanceOf(RegExp);
        });

        it('REDACTED_BODY_FIELDS is a non-empty array of strings', () => {
            expect(Array.isArray(onboarding.REDACTED_BODY_FIELDS)).toBe(true);
            expect(onboarding.REDACTED_BODY_FIELDS.length).toBeGreaterThan(0);
            for (const value of onboarding.REDACTED_BODY_FIELDS) {
                expect(typeof value).toBe('string');
            }
        });

        it('REDACTED_HEADERS is a non-empty array of strings', () => {
            expect(Array.isArray(onboarding.REDACTED_HEADERS)).toBe(true);
            expect(onboarding.REDACTED_HEADERS.length).toBeGreaterThan(0);
            for (const value of onboarding.REDACTED_HEADERS) {
                expect(typeof value).toBe('string');
            }
        });

        it('STATE_MARKER_DEFAULT_PATH is a non-empty string', () => {
            expect(typeof onboarding.STATE_MARKER_DEFAULT_PATH).toBe('string');
            expect(onboarding.STATE_MARKER_DEFAULT_PATH.length).toBeGreaterThan(0);
        });

        it('WEBHOOK_SIGNATURE_HEADER is a non-empty string', () => {
            expect(typeof onboarding.WEBHOOK_SIGNATURE_HEADER).toBe('string');
            expect(onboarding.WEBHOOK_SIGNATURE_HEADER.length).toBeGreaterThan(0);
        });

        it('isSafeWebhookUrl is a callable function', () => {
            expect(typeof onboarding.isSafeWebhookUrl).toBe('function');
        });

        it('redactBody / redactHeaders / redactString are callable functions', () => {
            expect(typeof onboarding.redactBody).toBe('function');
            expect(typeof onboarding.redactHeaders).toBe('function');
            expect(typeof onboarding.redactString).toBe('function');
        });

        it('the three Service / Repository classes are constructable functions', () => {
            for (const cls of [
                onboarding.WorksManifestService,
                onboarding.WebhookDeliveryService,
                onboarding.FetchWebhookHttpClient,
                onboarding.StateMarkerService,
                onboarding.OnboardingRequestRepository,
                onboarding.WebhookSubscriptionRepository,
            ]) {
                expect(typeof cls).toBe('function'); // ES classes are typeof 'function'
                expect(cls.name).toEqual(expect.any(String));
                expect(cls.name.length).toBeGreaterThan(0);
            }
        });
    });

    describe('barrel surface (regression guard for the curated subset)', () => {
        it('exposes exactly the documented names — no accidental additions', () => {
            const exported = Object.keys(onboarding).sort();
            expect(exported).toEqual(
                [
                    'FetchWebhookHttpClient',
                    'ONBOARDING_ACCOUNT_UPSERT',
                    'ONBOARDING_GIT_PROVIDER',
                    'ONBOARDING_WORK_CREATOR',
                    'OnboardingRequestRepository',
                    'PRINTABLE_ASCII_PATTERN',
                    'REDACTED_BODY_FIELDS',
                    'REDACTED_HEADERS',
                    'STATE_MARKER_DEFAULT_PATH',
                    'SUBDOMAIN_PATTERN',
                    'StateMarkerService',
                    'WEBHOOK_HTTP_CLIENT',
                    'WEBHOOK_SIGNATURE_HEADER',
                    'WebhookDeliveryService',
                    'WebhookSubscriptionRepository',
                    'WorksManifestService',
                    'WorksManifestV1Schema',
                    'isSafeWebhookUrl',
                    'redactBody',
                    'redactHeaders',
                    'redactString',
                ].sort(),
            );
        });
    });
});
