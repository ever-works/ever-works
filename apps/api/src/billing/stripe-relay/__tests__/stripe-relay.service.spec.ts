import { createHash, createHmac } from 'crypto';
import {
    StripeRelayNotConfiguredError,
    StripeRelayService,
    StripeRelaySignatureError,
    extractWorkId,
} from '../stripe-relay.service';

/**
 * The relay's job is ROUTING and RETRY CLASSIFICATION — getting either wrong
 * loses a customer's payment or replays it forever. These tests therefore assert
 * the decision for each real failure shape, and lead with the cases that must be
 * REFUSED rather than the happy path.
 *
 * Stripe verification itself is delegated to the official SDK and is exercised
 * here only through the two boundaries the relay owns: fail-closed when
 * unconfigured, and one undifferentiated error when verification fails.
 */

// The workspace barrels must be mocked BEFORE the service is imported.
// `@ever-works/agent/services` re-exports the data generator, which imports the
// ESM-only `p-map` — pulling it in makes the suite fail to LOAD (0 tests run,
// which reads as 'no failures'). Same pattern as the sibling
// `directory-website-client.service.spec.ts`.
jest.mock('@ever-works/agent/services', () => ({
    PlatformSyncSecretService: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class {},
}));
jest.mock('@ever-works/agent/subscriptions', () => ({
    constructStripeEvent: jest.fn(),
}));
jest.mock('@ever-works/agent/utils', () => ({
    isSafeWebhookUrl: jest.fn(() => true),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { constructStripeEvent } = require('@ever-works/agent/subscriptions');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isSafeWebhookUrl } = require('@ever-works/agent/utils');

const WORK_ID = 'work-123';
const SECRET = 'per-work-secret';
const SITE = 'https://directory.example.com';

function makeService(overrides?: {
    work?: unknown;
    secret?: string | null;
    decryptThrows?: boolean;
}) {
    const workRepository = {
        findById: jest
            .fn()
            .mockResolvedValue(
                overrides && 'work' in overrides
                    ? overrides.work
                    : { id: WORK_ID, website: SITE, platformSyncSecretEncrypted: 'enc' },
            ),
    };
    const secretService = {
        decryptForWork: jest.fn(() => {
            if (overrides?.decryptThrows) throw new Error('bad key');
            return overrides && 'secret' in overrides ? overrides.secret : SECRET;
        }),
    };
    const service = new StripeRelayService(workRepository as never, secretService as never);
    return { service, workRepository, secretService };
}

const event = (id: string, object: Record<string, unknown>) => ({
    id,
    type: 'customer.subscription.created',
    data: { object },
});

describe('StripeRelayService', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...OLD_ENV, STRIPE_RELAY_WEBHOOK_SECRET: 'whsec_test' };
        (isSafeWebhookUrl as jest.Mock).mockReturnValue(true);
        global.fetch = jest.fn();
    });
    afterAll(() => {
        process.env = OLD_ENV;
    });

    describe('refusals', () => {
        it('FAILS CLOSED when no relay signing secret is configured', async () => {
            delete process.env.STRIPE_RELAY_WEBHOOK_SECRET;
            const { service } = makeService();
            await expect(service.handle('{}', 'sig')).rejects.toBeInstanceOf(
                StripeRelayNotConfiguredError,
            );
            // Never touched the payload or the network.
            expect(constructStripeEvent).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('rejects a delivery with no signature header', async () => {
            const { service } = makeService();
            await expect(service.handle('{}', undefined)).rejects.toBeInstanceOf(
                StripeRelaySignatureError,
            );
            expect(constructStripeEvent).not.toHaveBeenCalled();
        });

        it('rejects a bad signature without echoing the SDK message', async () => {
            (constructStripeEvent as jest.Mock).mockImplementation(() => {
                throw new Error('No signatures found matching the expected signature for payload');
            });
            const { service } = makeService();
            await expect(service.handle('{}', 'sig')).rejects.toThrow(
                'Webhook signature verification failed',
            );
        });

        it('refuses to sign for an SSRF-unsafe website, so the secret never leaves', async () => {
            process.env.NODE_ENV = 'production';
            (isSafeWebhookUrl as jest.Mock).mockReturnValue(false);
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_1', { metadata: { work_id: WORK_ID } }),
            );
            const { service } = makeService();
            const outcome = await service.handle('{}', 'sig');
            expect(outcome).toMatchObject({ status: 'unroutable', reason: 'ssrf_blocked' });
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('fails closed when NODE_ENV is missing rather than treating it as local', async () => {
            delete process.env.NODE_ENV;
            (isSafeWebhookUrl as jest.Mock).mockReturnValue(false);
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_missing_env', { metadata: { work_id: WORK_ID } }),
            );
            const { service } = makeService();

            expect(await service.handle('{}', 'sig')).toMatchObject({
                status: 'unroutable',
                reason: 'ssrf_blocked',
            });
            expect(global.fetch).not.toHaveBeenCalled();
        });
    });

    describe('routing', () => {
        it('forwards to the owning directory with a signature over the RAW body', async () => {
            const raw = JSON.stringify(event('evt_2', { metadata: { work_id: WORK_ID } }));
            (constructStripeEvent as jest.Mock).mockReturnValue(JSON.parse(raw));
            (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });
            const { service } = makeService();

            const outcome = await service.handle(raw, 'sig');
            expect(outcome).toMatchObject({ status: 'forwarded', workId: WORK_ID });

            const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
            expect(url).toBe(`${SITE}/api/stripe/platform-webhook`);
            // Byte-for-byte: re-serialising would change the digest and 401.
            expect(init.body).toBe(raw);
            expect(init.redirect).toBe('manual');

            // The signature must be reproducible by the directory: it is an HMAC
            // over `${ts}:${sha256(body)}:${workId}` with the per-Work secret.
            const ts = init.headers['x-platform-ts'];
            const expected = createHmac('sha256', SECRET)
                .update(
                    `${ts}:${createHash('sha256').update(raw, 'utf8').digest('hex')}:${WORK_ID}`,
                )
                .digest('hex');
            expect(init.headers.Authorization).toBe(`Bearer ${expected}`);
        });

        it('routes a legacy managed k8s Work through its canonical slug host when website is null', async () => {
            delete process.env.EVER_WORKS_DOMAIN;
            const raw = JSON.stringify(event('evt_legacy', { metadata: { work_id: WORK_ID } }));
            (constructStripeEvent as jest.Mock).mockReturnValue(JSON.parse(raw));
            (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });
            const { service } = makeService({
                work: {
                    id: WORK_ID,
                    slug: 'awesome-rust-ai-libraries',
                    deployProvider: 'k8s',
                    website: null,
                    managedSubdomain: null,
                    platformSyncSecretEncrypted: 'enc',
                },
            });

            expect(await service.handle(raw, 'sig')).toMatchObject({ status: 'forwarded' });
            expect(global.fetch).toHaveBeenCalledWith(
                'https://awesome-rust-ai-libraries.ever.works/api/stripe/platform-webhook',
                expect.objectContaining({ body: raw }),
            );
        });

        it('prefers an allocated managed subdomain and respects the configured root domain', async () => {
            process.env.EVER_WORKS_DOMAIN = 'preview.ever.works';
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_managed', { metadata: { work_id: WORK_ID } }),
            );
            (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });
            const { service } = makeService({
                work: {
                    id: WORK_ID,
                    slug: 'legacy-slug',
                    deployProvider: 'k8s',
                    website: null,
                    managedSubdomain: 'Allocated-Name',
                    platformSyncSecretEncrypted: 'enc',
                },
            });

            expect(await service.handle('{}', 'sig')).toMatchObject({ status: 'forwarded' });
            expect(global.fetch).toHaveBeenCalledWith(
                'https://allocated-name.preview.ever.works/api/stripe/platform-webhook',
                expect.any(Object),
            );
        });

        it('binds the signature to the work id, so it cannot be replayed elsewhere', async () => {
            const raw = JSON.stringify(event('evt_3', { metadata: { work_id: WORK_ID } }));
            (constructStripeEvent as jest.Mock).mockReturnValue(JSON.parse(raw));
            (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });
            const { service } = makeService();
            await service.handle(raw, 'sig');

            const [, init] = (global.fetch as jest.Mock).mock.calls[0];
            const ts = init.headers['x-platform-ts'];
            const forAnotherWork = createHmac('sha256', SECRET)
                .update(
                    `${ts}:${createHash('sha256').update(raw, 'utf8').digest('hex')}:another-work`,
                )
                .digest('hex');
            expect(init.headers.Authorization).not.toBe(`Bearer ${forAnotherWork}`);
        });

        it.each([
            ['no work_id at all', {}, 'no_work_id'],
            ['a work that does not exist', { metadata: { work_id: 'ghost' } }, 'unknown_work'],
        ])('is unroutable (not retried) for %s', async (_label, object, reason) => {
            (constructStripeEvent as jest.Mock).mockReturnValue(event('evt_4', object));
            const { service } = makeService(reason === 'unknown_work' ? { work: null } : undefined);
            const outcome = await service.handle('{}', 'sig');
            expect(outcome).toMatchObject({ status: 'unroutable', reason });
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('is unroutable when the Work has no deployed website', async () => {
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_5', { metadata: { work_id: WORK_ID } }),
            );
            const { service } = makeService({ work: { id: WORK_ID, website: null } });
            expect(await service.handle('{}', 'sig')).toMatchObject({
                status: 'unroutable',
                reason: 'not_deployed',
            });
        });

        it('is unroutable when the per-Work secret is missing or undecryptable', async () => {
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_6', { metadata: { work_id: WORK_ID } }),
            );
            expect(await makeService({ secret: null }).service.handle('{}', 'sig')).toMatchObject({
                reason: 'not_provisioned',
            });
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_7', { metadata: { work_id: WORK_ID } }),
            );
            expect(
                await makeService({ decryptThrows: true }).service.handle('{}', 'sig'),
            ).toMatchObject({ reason: 'secret_undecryptable' });
        });
    });

    describe('retry classification — what Stripe is told to do', () => {
        beforeEach(() => {
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_8', { metadata: { work_id: WORK_ID } }),
            );
        });

        it.each([
            [500, 'retry'],
            [502, 'retry'],
            [401, 'retry'], // stale secret — a re-sync may fix it inside the window
            [409, 'unroutable'], // our routing bug; retrying repeats it
            [503, 'retry'], // can come from ingress/site outage; status alone is not a trusted permanent signal
            [400, 'unroutable'], // malformed body is not fixable by retrying
            [200, 'forwarded'],
        ])('site answers %i -> %s', async (siteStatus, expected) => {
            (global.fetch as jest.Mock).mockResolvedValue({ status: siteStatus });
            const { service } = makeService();
            expect((await service.handle('{}', 'sig')).status).toBe(expected);
        });

        it('retries a network failure rather than dropping a paid event', async () => {
            (global.fetch as jest.Mock).mockRejectedValue(
                new Error('connect ECONNREFUSED 10.0.0.1'),
            );
            const { service } = makeService();
            expect(await service.handle('{}', 'sig')).toMatchObject({
                status: 'retry',
                reason: 'network',
            });
        });
    });

    describe('isEnabled', () => {
        it('is OFF unless explicitly switched on', () => {
            const { service } = makeService();
            delete process.env.STRIPE_RELAY_ENABLED;
            expect(service.isEnabled()).toBe(false);
            process.env.STRIPE_RELAY_ENABLED = 'false';
            expect(service.isEnabled()).toBe(false);
            process.env.STRIPE_RELAY_ENABLED = 'true';
            expect(service.isEnabled()).toBe(true);
        });
    });
});

describe('extractWorkId', () => {
    it('reads the object metadata first', () => {
        expect(extractWorkId({ data: { object: { metadata: { work_id: 'w1' } } } })).toBe('w1');
    });

    it('falls back to invoice subscription_details, which is where invoice.* carries it', () => {
        expect(
            extractWorkId({
                data: { object: { subscription_details: { metadata: { work_id: 'w2' } } } },
            }),
        ).toBe('w2');
    });

    it('reads Stripe v18 invoice parent.subscription_details metadata', () => {
        expect(
            extractWorkId({
                data: {
                    object: {
                        parent: { subscription_details: { metadata: { work_id: 'w-v18' } } },
                    },
                },
            }),
        ).toBe('w-v18');
    });

    it('falls back to a line item', () => {
        expect(
            extractWorkId({
                data: { object: { lines: { data: [{}, { metadata: { work_id: 'w3' } }] } } },
            }),
        ).toBe('w3');
    });

    it('returns null rather than guessing when nothing carries a key', () => {
        expect(extractWorkId({ data: { object: { metadata: {} } } })).toBeNull();
        expect(extractWorkId({})).toBeNull();
    });

    it('ignores blank and non-string values instead of routing to ""', () => {
        expect(extractWorkId({ data: { object: { metadata: { work_id: '   ' } } } })).toBeNull();
        expect(extractWorkId({ data: { object: { metadata: { work_id: 42 } } } })).toBeNull();
    });
});
