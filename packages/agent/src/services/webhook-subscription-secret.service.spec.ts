import { WebhookSubscriptionSecretService } from './webhook-subscription-secret.service';

/**
 * Security regression test for the PLATFORM_ENCRYPTION_KEY-absent path.
 *
 * encrypt() (and therefore generateSecret(), which calls it) must HARD-FAIL
 * in production when no key is configured, instead of silently persisting the
 * webhook subscription signing secret in plaintext. In non-production it keeps
 * the documented warn+passthrough behavior so dev/test fixtures still work.
 */
describe('WebhookSubscriptionSecretService — PLATFORM_ENCRYPTION_KEY-absent guard', () => {
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
    const ORIGINAL_KEY = process.env.PLATFORM_ENCRYPTION_KEY;

    afterEach(() => {
        if (ORIGINAL_NODE_ENV === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = ORIGINAL_NODE_ENV;
        }
        if (ORIGINAL_KEY === undefined) {
            delete process.env.PLATFORM_ENCRYPTION_KEY;
        } else {
            process.env.PLATFORM_ENCRYPTION_KEY = ORIGINAL_KEY;
        }
        jest.restoreAllMocks();
    });

    it('encrypt() throws in production when the key is absent (no plaintext passthrough)', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.PLATFORM_ENCRYPTION_KEY;
        const service = new WebhookSubscriptionSecretService();

        expect(() => service.encrypt('super-secret')).toThrow(
            /PLATFORM_ENCRYPTION_KEY must be set in production/,
        );
    });

    it('generateSecret() throws in production when the key is absent (issuance covered)', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.PLATFORM_ENCRYPTION_KEY;
        const service = new WebhookSubscriptionSecretService();

        expect(() => service.generateSecret()).toThrow(
            /PLATFORM_ENCRYPTION_KEY must be set in production/,
        );
    });

    it('encrypt() warns and passes the value through in non-production when the key is absent', () => {
        process.env.NODE_ENV = 'test';
        delete process.env.PLATFORM_ENCRYPTION_KEY;
        const service = new WebhookSubscriptionSecretService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

        const out = service.encrypt('plain-value');

        expect(out).toBe('plain-value'); // passthrough, not enveloped
        expect(out.startsWith('enc::v1::')).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1); // one-time latch
    });

    it('encrypt() warn fires once across multiple calls in non-production (latch preserved)', () => {
        process.env.NODE_ENV = 'development';
        delete process.env.PLATFORM_ENCRYPTION_KEY;
        const service = new WebhookSubscriptionSecretService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

        expect(service.encrypt('a')).toBe('a');
        expect(service.encrypt('b')).toBe('b');

        expect(warnSpy).toHaveBeenCalledTimes(1);
    });
});
