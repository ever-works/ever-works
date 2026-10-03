import { createHash, createHmac } from 'crypto';
import {
    StripeRelayDeadLetterNotFoundError,
    StripeRelayNotConfiguredError,
    StripeRelayService,
    StripeRelaySignatureError,
    extractWorkId,
} from '../stripe-relay.service';

/**
 * The relay's job is ROUTING, RETRY CLASSIFICATION and — since audit CC05-06 —
 * making sure nothing it could not deliver disappears. Getting any of these
 * wrong loses a customer's payment or replays it forever. These tests
 * therefore assert the decision for each real failure shape, and lead with the
 * cases that must be REFUSED rather than the happy path.
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
    StripeRelayDeadLetterRepository: class {},
}));
jest.mock('@ever-works/agent/entities', () => ({
    StripeRelayDeadLetterResolution: {
        STRIPE_RETRY: 'stripe-retry',
        REPLAYED: 'replayed',
        DISMISSED: 'dismissed',
    },
    StripeRelayDeadLetterStatus: { OPEN: 'open', RESOLVED: 'resolved' },
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

/** What the directory's `/api/stripe/platform-webhook` answers after dispatching. */
const DISPATCHED = { received: true, type: 'subscription.created', dispatched: true };

function siteResponse(status: number, body?: unknown) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return {
        status,
        text: jest.fn().mockResolvedValue(text),
        body: { cancel: jest.fn().mockResolvedValue(undefined) },
    };
}

function makeService(overrides?: {
    work?: unknown;
    secret?: string | null;
    decryptThrows?: boolean;
    deadLetterRow?: unknown;
    recordFailureThrows?: boolean;
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
    const deadLetters = {
        findByEventId: jest.fn().mockResolvedValue(overrides?.deadLetterRow ?? null),
        recordFailure: jest.fn(async (failure: unknown) => {
            if (overrides?.recordFailureThrows) throw new Error('db down');
            return failure;
        }),
        markResolved: jest.fn().mockResolvedValue(false),
        countOpen: jest.fn().mockResolvedValue(0),
    };
    const service = new StripeRelayService(
        workRepository as never,
        secretService as never,
        deadLetters as never,
    );
    return { service, workRepository, secretService, deadLetters };
}

const event = (
    id: string,
    object: Record<string, unknown>,
    extra: Record<string, unknown> = {},
) => ({
    id,
    type: 'customer.subscription.created',
    data: { object },
    ...extra,
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
            const { service, deadLetters } = makeService();
            await expect(service.handle('{}', 'sig')).rejects.toBeInstanceOf(
                StripeRelayNotConfiguredError,
            );
            // Never touched the payload, the network or the dead-letter table.
            expect(constructStripeEvent).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
            expect(deadLetters.recordFailure).not.toHaveBeenCalled();
        });

        it('rejects a delivery with no signature header', async () => {
            const { service } = makeService();
            await expect(service.handle('{}', undefined)).rejects.toBeInstanceOf(
                StripeRelaySignatureError,
            );
            expect(constructStripeEvent).not.toHaveBeenCalled();
        });

        it('rejects a bad signature without echoing the SDK message, and records nothing', async () => {
            (constructStripeEvent as jest.Mock).mockImplementation(() => {
                throw new Error('No signatures found matching the expected signature for payload');
            });
            const { service, deadLetters } = makeService();
            await expect(service.handle('{}', 'sig')).rejects.toThrow(
                'Webhook signature verification failed',
            );
            // An unverified body must never be stored for a later replay.
            expect(deadLetters.recordFailure).not.toHaveBeenCalled();
        });

        it('refuses to sign for an SSRF-unsafe website, so the secret never leaves', async () => {
            process.env.NODE_ENV = 'production';
            (isSafeWebhookUrl as jest.Mock).mockReturnValue(false);
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_1', { metadata: { work_id: WORK_ID } }),
            );
            const { service, deadLetters } = makeService();
            const outcome = await service.handle('{}', 'sig');
            expect(outcome).toMatchObject({ status: 'unroutable', reason: 'ssrf_blocked' });
            expect(global.fetch).not.toHaveBeenCalled();
            // Visible to an operator instead of a log line.
            expect(deadLetters.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({ disposition: 'unroutable', reason: 'ssrf_blocked' }),
            );
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
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
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

        it('routes a legacy managed k8s Work by slug when website is null', async () => {
            delete process.env.EVER_WORKS_DOMAIN;
            const raw = JSON.stringify(event('evt_legacy', { metadata: { work_id: WORK_ID } }));
            (constructStripeEvent as jest.Mock).mockReturnValue(JSON.parse(raw));
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
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

        it('prefers a managed subdomain and respects the configured root domain', async () => {
            process.env.EVER_WORKS_DOMAIN = 'preview.ever.works';
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_managed', { metadata: { work_id: WORK_ID } }),
            );
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
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

        it('ignores a stale Vercel placeholder for a managed k8s Work', async () => {
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_placeholder', { metadata: { work_id: WORK_ID } }),
            );
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
            const { service } = makeService({
                work: {
                    id: WORK_ID,
                    slug: 'awesome-rust-tools-and-frameworks',
                    deployProvider: 'k8s',
                    website: 'https://awesome-rust-tools-and-frameworks-w.vercel.app',
                    managedSubdomain: null,
                    platformSyncSecretEncrypted: 'enc',
                },
            });

            expect(await service.handle('{}', 'sig')).toMatchObject({ status: 'forwarded' });
            expect(global.fetch).toHaveBeenCalledWith(
                'https://awesome-rust-tools-and-frameworks.ever.works/api/stripe/platform-webhook',
                expect.any(Object),
            );
        });

        it('binds the signature to the work id, so it cannot be replayed elsewhere', async () => {
            const raw = JSON.stringify(event('evt_3', { metadata: { work_id: WORK_ID } }));
            (constructStripeEvent as jest.Mock).mockReturnValue(JSON.parse(raw));
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
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

        it('acknowledges an event with no work_id WITHOUT dead-lettering it (platform-owned traffic)', async () => {
            (constructStripeEvent as jest.Mock).mockReturnValue(event('evt_4', {}));
            const { service, deadLetters, workRepository } = makeService();
            expect(await service.handle('{}', 'sig')).toMatchObject({
                status: 'unroutable',
                reason: 'no_work_id',
            });
            expect(workRepository.findById).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
            // Most relay traffic is Gauzy / ever.co / platform events; storing
            // each would bury the real dead letters.
            expect(deadLetters.recordFailure).not.toHaveBeenCalled();
        });

        it('acknowledges an unknown Work but dead-letters it for an operator', async () => {
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_ghost', { metadata: { work_id: 'ghost' } }, { livemode: true }),
            );
            const { service, deadLetters } = makeService({ work: null });
            expect(await service.handle('{"raw":"ghost"}', 'sig')).toMatchObject({
                status: 'unroutable',
                reason: 'unknown_work',
            });
            expect(global.fetch).not.toHaveBeenCalled();
            expect(deadLetters.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventId: 'evt_ghost',
                    eventType: 'customer.subscription.created',
                    workId: 'ghost',
                    livemode: true,
                    disposition: 'unroutable',
                    reason: 'unknown_work',
                    siteStatus: null,
                    payload: '{"raw":"ghost"}',
                }),
            );
        });

        it.each([
            [
                'the Work has no deployed website',
                { work: { id: WORK_ID, website: null } },
                'not_deployed',
            ],
            ['the per-Work secret was never provisioned', { secret: null }, 'not_provisioned'],
            [
                'the per-Work secret cannot be decrypted',
                { decryptThrows: true },
                'secret_undecryptable',
            ],
        ])(
            'RETRIES and dead-letters when %s (a provisioning gap is fixable inside Stripe’s window)',
            async (_label, overrides, reason) => {
                (constructStripeEvent as jest.Mock).mockReturnValue(
                    event('evt_gap', { metadata: { work_id: WORK_ID } }),
                );
                const { service, deadLetters } = makeService(overrides);
                expect(await service.handle('{}', 'sig')).toMatchObject({
                    status: 'retry',
                    reason,
                });
                expect(global.fetch).not.toHaveBeenCalled();
                expect(deadLetters.recordFailure).toHaveBeenCalledWith(
                    expect.objectContaining({ disposition: 'retry', reason, workId: WORK_ID }),
                );
            },
        );
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
            [503, 'retry'], // can come from ingress/site outage; status alone is not a trusted permanent signal
            [401, 'retry'], // stale secret — a re-sync may fix it inside the window
            [404, 'retry'], // missing ingress / tunnel rule (the 2026-08-23 rust-tools failure)
            [403, 'retry'], // a WAF challenge in front of the site
            [405, 'retry'],
            [413, 'retry'], // an ingress body-size limit
            [429, 'retry'],
            [301, 'retry'], // a redirect we refuse to follow is a misconfiguration, not a delivery
            [308, 'retry'],
            [409, 'unroutable'], // our routing bug; retrying repeats it
            [400, 'unroutable'], // malformed body is not fixable by retrying
        ])('site answers %i -> %s, and it is dead-lettered', async (siteStatus, expected) => {
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(siteStatus, { error: 'x' }));
            const { service, deadLetters } = makeService();
            const outcome = await service.handle('{}', 'sig');
            expect(outcome.status).toBe(expected);
            expect(deadLetters.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({ disposition: expected, siteStatus }),
            );
            expect(deadLetters.markResolved).not.toHaveBeenCalled();
        });

        it('treats a 2xx as delivered ONLY when the site confirms dispatch', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
            const { service, deadLetters } = makeService();
            expect(await service.handle('{}', 'sig')).toMatchObject({
                status: 'forwarded',
                siteStatus: 200,
            });
            expect(deadLetters.recordFailure).not.toHaveBeenCalled();
        });

        it('treats a site-side duplicate as delivered (it already ran the handler)', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(
                siteResponse(200, { received: true, duplicate: true }),
            );
            const { service } = makeService();
            expect((await service.handle('{}', 'sig')).status).toBe('forwarded');
        });

        it.each([
            ['a bare 200 with no body', siteResponse(200)],
            ['a 200 that received but did not dispatch', siteResponse(200, { received: true })],
            [
                'a 200 with dispatched:false',
                siteResponse(200, { received: true, dispatched: false }),
            ],
            ['a 204', siteResponse(204)],
            ['a 200 with an HTML body (a proxy page)', siteResponse(200, '<html>ok</html>')],
            [
                'a 200 whose body cannot be read',
                { status: 200, text: jest.fn().mockRejectedValue(new Error('reset')) },
            ],
        ])(
            'RETRIES %s — a no-op receiver must never count as delivered',
            async (_label, response) => {
                (global.fetch as jest.Mock).mockResolvedValue(response);
                const { service, deadLetters } = makeService();
                expect(await service.handle('{}', 'sig')).toMatchObject({
                    status: 'retry',
                    reason: 'site_unconfirmed',
                });
                expect(deadLetters.recordFailure).toHaveBeenCalledWith(
                    expect.objectContaining({ reason: 'site_unconfirmed' }),
                );
            },
        );

        it('retries a network failure rather than dropping a paid event', async () => {
            (global.fetch as jest.Mock).mockRejectedValue(
                new Error('connect ECONNREFUSED 10.0.0.1'),
            );
            const { service, deadLetters } = makeService();
            expect(await service.handle('{}', 'sig')).toMatchObject({
                status: 'retry',
                reason: 'network',
            });
            expect(deadLetters.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({ reason: 'network', siteStatus: null }),
            );
        });
    });

    describe('dead letters', () => {
        beforeEach(() => {
            (constructStripeEvent as jest.Mock).mockReturnValue(
                event('evt_dl', { metadata: { work_id: WORK_ID } }),
            );
        });

        it('resolves an open dead letter when a later Stripe retry is delivered', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
            const { service, deadLetters } = makeService();
            deadLetters.markResolved.mockResolvedValue(true);

            expect((await service.handle('{}', 'sig')).status).toBe('forwarded');
            expect(deadLetters.markResolved).toHaveBeenCalledWith('evt_dl', 'stripe-retry');
        });

        it('keeps a delivery a delivery even if resolving the dead letter fails', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
            const { service, deadLetters } = makeService();
            deadLetters.markResolved.mockRejectedValue(new Error('db down'));

            expect((await service.handle('{}', 'sig')).status).toBe('forwarded');
        });

        it('turns an unroutable event into a RETRY when its dead letter cannot be written', async () => {
            // Neither delivered nor recorded: acknowledging would lose it for good.
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(409, { error: 'x' }));
            const { service } = makeService({ recordFailureThrows: true });
            expect(await service.handle('{}', 'sig')).toMatchObject({
                status: 'retry',
                reason: 'dead_letter_unavailable',
            });
        });

        it('still retries a retryable event when its dead letter cannot be written', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(502));
            const { service } = makeService({ recordFailureThrows: true });
            expect((await service.handle('{}', 'sig')).status).toBe('retry');
        });
    });

    describe('replay (operator tool)', () => {
        const payload = JSON.stringify(
            event('evt_replay', { metadata: { work_id: WORK_ID } }, { livemode: true }),
        );
        const openRow = { eventId: 'evt_replay', status: 'open', payload };

        it('refuses an event it has no dead letter for', async () => {
            const { service } = makeService();
            await expect(service.replay('evt_nope')).rejects.toBeInstanceOf(
                StripeRelayDeadLetterNotFoundError,
            );
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('does nothing for a dead letter that is already resolved', async () => {
            const { service } = makeService({
                deadLetterRow: { ...openRow, status: 'resolved' },
            });
            expect(await service.replay('evt_replay')).toEqual({
                status: 'already-resolved',
                eventId: 'evt_replay',
            });
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('forwards the STORED bytes verbatim and resolves the row as replayed', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(200, DISPATCHED));
            const { service, deadLetters } = makeService({ deadLetterRow: openRow });

            expect(await service.replay('evt_replay')).toMatchObject({
                status: 'forwarded',
                workId: WORK_ID,
            });
            const [, init] = (global.fetch as jest.Mock).mock.calls[0];
            expect(init.body).toBe(payload);
            // The Stripe signature is not re-checked on a replay.
            expect(constructStripeEvent).not.toHaveBeenCalled();
            expect(deadLetters.markResolved).toHaveBeenCalledWith('evt_replay', 'replayed');
        });

        it('counts a failed replay as another attempt and reports why', async () => {
            (global.fetch as jest.Mock).mockResolvedValue(siteResponse(404));
            const { service, deadLetters } = makeService({ deadLetterRow: openRow });

            expect(await service.replay('evt_replay')).toEqual({
                status: 'failed',
                eventId: 'evt_replay',
                disposition: 'retry',
                reason: 'site_404',
            });
            expect(deadLetters.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({ eventId: 'evt_replay', reason: 'site_404', payload }),
            );
            expect(deadLetters.markResolved).not.toHaveBeenCalled();
        });

        it('refuses a stored payload that is not the event the row names', async () => {
            const { service } = makeService({
                deadLetterRow: { ...openRow, payload: JSON.stringify(event('evt_other', {})) },
            });
            expect(await service.replay('evt_replay')).toMatchObject({
                status: 'failed',
                reason: 'payload_mismatch',
            });
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it('refuses an unreadable stored payload', async () => {
            const { service } = makeService({
                deadLetterRow: { ...openRow, payload: '{not json' },
            });
            expect(await service.replay('evt_replay')).toMatchObject({
                status: 'failed',
                reason: 'payload_unreadable',
            });
        });
    });

    describe('dismiss', () => {
        it('closes an existing dead letter as dismissed', async () => {
            const { service, deadLetters } = makeService({
                deadLetterRow: { eventId: 'evt_x', status: 'open', payload: '{}' },
            });
            deadLetters.markResolved.mockResolvedValue(true);
            expect(await service.dismiss('evt_x')).toBe(true);
            expect(deadLetters.markResolved).toHaveBeenCalledWith('evt_x', 'dismissed');
        });

        it('refuses an event it has no dead letter for', async () => {
            const { service } = makeService();
            await expect(service.dismiss('evt_nope')).rejects.toBeInstanceOf(
                StripeRelayDeadLetterNotFoundError,
            );
        });
    });

    describe('health (alert hook)', () => {
        const NOW = new Date('2026-09-28T12:00:00.000Z');

        it('counts open dead letters older than a 60 minute grace by default', async () => {
            delete process.env.STRIPE_RELAY_DEAD_LETTER_ALERT_AFTER_MINUTES;
            const { service, deadLetters } = makeService();
            deadLetters.countOpen.mockResolvedValue(2);

            expect(await service.openDeadLetterCount(NOW)).toBe(2);
            expect(deadLetters.countOpen).toHaveBeenCalledWith(
                new Date('2026-09-28T11:00:00.000Z'),
            );
        });

        it('honours a configured grace, and ignores a nonsense one', async () => {
            const { service, deadLetters } = makeService();
            process.env.STRIPE_RELAY_DEAD_LETTER_ALERT_AFTER_MINUTES = '0';
            await service.openDeadLetterCount(NOW);
            expect(deadLetters.countOpen).toHaveBeenLastCalledWith(NOW);

            process.env.STRIPE_RELAY_DEAD_LETTER_ALERT_AFTER_MINUTES = 'soon';
            await service.openDeadLetterCount(NOW);
            expect(deadLetters.countOpen).toHaveBeenLastCalledWith(
                new Date('2026-09-28T11:00:00.000Z'),
            );
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
