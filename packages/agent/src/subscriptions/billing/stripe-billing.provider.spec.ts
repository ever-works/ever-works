import { BillingProviderError, BillingProviderNotConfiguredError } from './billing.provider';
import {
    StripeBillingProvider,
    STRIPE_METADATA_KEYS,
    STRIPE_PURCHASE_KINDS,
} from './stripe-billing.provider';

/**
 * The real provider implementation. The vendor SDK is replaced by a fake
 * client injected through the constructor seam, so these specs exercise
 * OUR logic — configuration posture, fail-closed verification and event
 * normalization — without a network or a live key.
 *
 * The one thing deliberately NOT re-tested here is the HMAC itself: that
 * lives inside the vendor's `constructEvent` (constant-time compare +
 * timestamp tolerance) and re-implementing it is exactly what the
 * official-SDK house rule forbids. What IS pinned is that a throwing
 * `constructEvent` can never produce a usable event.
 */

const ENV_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = saved[key];
        }
    }
});

function fakeClient(overrides: Record<string, unknown> = {}) {
    return {
        customers: { create: jest.fn().mockResolvedValue({ id: 'cus_new' }) },
        checkout: {
            sessions: {
                create: jest
                    .fn()
                    .mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' }),
            },
        },
        paymentIntents: {
            create: jest.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' }),
        },
        webhooks: { constructEvent: jest.fn() },
        ...overrides,
    } as any;
}

function build(client = fakeClient()) {
    const factory = jest.fn().mockReturnValue(client);
    return { provider: new StripeBillingProvider(factory), client, factory };
}

describe('StripeBillingProvider — configuration posture', () => {
    it('reports not-configured with no secret key', () => {
        const { provider } = build();
        expect(provider.isConfigured()).toBe(false);
        expect(provider.isWebhookConfigured()).toBe(false);
        expect(provider.getProviderId()).toBe('stripe');
    });

    it('reports configured once the keys are present', () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
        const { provider } = build();
        expect(provider.isConfigured()).toBe(true);
        expect(provider.isWebhookConfigured()).toBe(true);
    });

    it('treats a whitespace-only key as unconfigured', () => {
        process.env.STRIPE_SECRET_KEY = '   ';
        const { provider } = build();
        expect(provider.isConfigured()).toBe(false);
    });

    it('fails closed on every money method without a secret key', async () => {
        const { provider, factory } = build();

        await expect(provider.ensureCustomer({ userId: 'u1' })).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        await expect(
            provider.createCreditCheckoutSession({
                userId: 'u1',
                pack: {
                    id: 'credits-1000',
                    priceCents: 1000,
                    credits: 1000,
                    currency: 'usd',
                    label: 'x',
                },
                successUrl: 'https://app.test/ok',
                cancelUrl: 'https://app.test/no',
                referenceId: 'u1:credits-1000',
            }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
        // No client is ever constructed without a key.
        expect(factory).not.toHaveBeenCalled();
    });

    it('never builds more than one client for a stable key', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        const { provider, factory } = build();

        await provider.ensureCustomer({ userId: 'u1' });
        await provider.ensureCustomer({ userId: 'u2' });

        expect(factory).toHaveBeenCalledTimes(1);
    });
});

describe('StripeBillingProvider — checkout', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    it('reuses an existing customer id instead of creating another', async () => {
        const { provider, client } = build();

        const id = await provider.ensureCustomer({ userId: 'u1', existingCustomerId: 'cus_old' });

        expect(id).toBe('cus_old');
        expect(client.customers.create).not.toHaveBeenCalled();
    });

    it('prices the session from the pack and stamps attribution metadata', async () => {
        const { provider, client } = build();

        const session = await provider.createCreditCheckoutSession({
            userId: 'u1',
            customerId: 'cus_1',
            pack: {
                id: 'credits-5500',
                priceCents: 5000,
                credits: 5500,
                currency: 'usd',
                label: '5,500 credits',
            },
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
            referenceId: 'u1:credits-5500',
        });

        expect(session).toEqual({
            url: 'https://pay.example/cs_1',
            sessionId: 'cs_1',
            customerId: 'cus_1',
        });
        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.line_items[0].price_data.unit_amount).toBe(5000);
        expect(params.metadata[STRIPE_METADATA_KEYS.kind]).toBe(STRIPE_PURCHASE_KINDS.checkout);
        expect(params.metadata[STRIPE_METADATA_KEYS.packId]).toBe('credits-5500');
        // Deliberately absent — this is what keeps a checkout from
        // crediting twice (session.completed AND payment_intent.succeeded).
        expect(params.payment_intent_data).toBeUndefined();
    });

    it('passes the claim key as the provider idempotency key on an off-session charge', async () => {
        const { provider, client } = build();

        const result = await provider.chargeOffSession({
            customerId: 'cus_1',
            paymentMethodRef: 'pm_1',
            userId: 'u1',
            idempotencyKey: 'auto:u1:credits-1000:1',
            pack: {
                id: 'credits-1000',
                priceCents: 1000,
                credits: 1000,
                currency: 'usd',
                label: '1,000 credits',
            },
        });

        expect(result).toEqual({ paymentId: 'pi_1', status: 'succeeded' });
        const [params, options] = client.paymentIntents.create.mock.calls[0];
        expect(params.amount).toBe(1000);
        expect(params.off_session).toBe(true);
        expect(params.metadata[STRIPE_METADATA_KEYS.kind]).toBe(STRIPE_PURCHASE_KINDS.autoRecharge);
        expect(options).toEqual({ idempotencyKey: 'auto:u1:credits-1000:1' });
    });

    it('reports a declined charge as failed instead of throwing', async () => {
        const client = fakeClient({
            paymentIntents: {
                create: jest
                    .fn()
                    .mockRejectedValue(
                        Object.assign(new Error('Your card was declined'), {
                            code: 'card_declined',
                        }),
                    ),
            },
        });
        const { provider } = build(client);

        const result = await provider.chargeOffSession({
            customerId: 'cus_1',
            paymentMethodRef: 'pm_1',
            userId: 'u1',
            idempotencyKey: 'k',
            pack: {
                id: 'credits-1000',
                priceCents: 1000,
                credits: 1000,
                currency: 'usd',
                label: 'x',
            },
        });

        expect(result).toEqual({ paymentId: '', status: 'failed', failureCode: 'card_declined' });
    });
});

describe('StripeBillingProvider — webhook verification (fail-closed)', () => {
    it('rejects every delivery when no webhook secret is configured', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        const { provider, client } = build();

        await expect(provider.verifyAndParseWebhook('{}', 'sig')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        // Fails BEFORE looking at the payload.
        expect(client.webhooks.constructEvent).not.toHaveBeenCalled();
    });

    it('rejects a delivery with no signature header', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
        const { provider, client } = build();

        await expect(provider.verifyAndParseWebhook('{}', undefined)).rejects.toBeInstanceOf(
            BillingProviderError,
        );
        expect(client.webhooks.constructEvent).not.toHaveBeenCalled();
    });

    it('rejects a delivery whose signature does not verify, without echoing the reason', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
        const client = fakeClient({
            webhooks: {
                constructEvent: jest.fn(() => {
                    throw new Error('No signatures found matching the expected signature for t=…');
                }),
            },
        });
        const { provider } = build(client);

        await expect(provider.verifyAndParseWebhook('{}', 'v1=bad')).rejects.toMatchObject({
            name: 'BillingProviderError',
            message: 'Webhook signature verification failed',
        });
    });

    it('verifies against the RAW body and the configured secret', async () => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
        const client = fakeClient({
            webhooks: {
                constructEvent: jest
                    .fn()
                    .mockReturnValue({ id: 'evt_1', type: 'ping', data: { object: {} } }),
            },
        });
        const { provider } = build(client);

        await provider.verifyAndParseWebhook('{"raw":1}', 'v1=good');

        expect(client.webhooks.constructEvent).toHaveBeenCalledWith(
            '{"raw":1}',
            'v1=good',
            'whsec_x',
        );
    });
});

describe('StripeBillingProvider — event normalization', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    });

    function parse(raw: any) {
        const client = fakeClient({
            webhooks: { constructEvent: jest.fn().mockReturnValue(raw) },
        });
        const { provider } = build(client);
        return provider.verifyAndParseWebhook('{}', 'sig');
    }

    it('normalizes a paid credit checkout to credits.purchased', async () => {
        const normalized = await parse({
            id: 'evt_1',
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_1',
                    customer: 'cus_1',
                    client_reference_id: 'u1:credits-5500',
                    payment_status: 'paid',
                    amount_total: 5000,
                    currency: 'usd',
                    payment_intent: 'pi_1',
                    metadata: {
                        [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.checkout,
                        [STRIPE_METADATA_KEYS.packId]: 'credits-5500',
                    },
                },
            },
        });

        expect(normalized).toEqual(
            expect.objectContaining({
                id: 'evt_1',
                kind: 'credits.purchased',
                customerId: 'cus_1',
                packId: 'credits-5500',
                amountCents: 5000,
                paymentId: 'pi_1',
                referenceId: 'u1:credits-5500',
            }),
        );
    });

    it('ignores an UNPAID checkout session — no credits for an abandoned cart', async () => {
        const normalized = await parse({
            id: 'evt_2',
            type: 'checkout.session.completed',
            data: {
                object: {
                    payment_status: 'unpaid',
                    metadata: {
                        [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.checkout,
                        [STRIPE_METADATA_KEYS.packId]: 'credits-5500',
                    },
                },
            },
        });

        expect(normalized.kind).toBe('ignored');
    });

    it('ignores a checkout session that is not one of ours', async () => {
        const normalized = await parse({
            id: 'evt_3',
            type: 'checkout.session.completed',
            data: { object: { payment_status: 'paid', metadata: {} } },
        });

        expect(normalized.kind).toBe('ignored');
    });

    it("ignores a checkout's payment intent so one purchase credits exactly once", async () => {
        const normalized = await parse({
            id: 'evt_4',
            type: 'payment_intent.succeeded',
            // No metadata: a checkout PI carries none by design.
            data: { object: { id: 'pi_1', amount: 5000, metadata: {} } },
        });

        expect(normalized.kind).toBe('ignored');
    });

    it('normalizes an auto-recharge payment intent to credits.purchased', async () => {
        const normalized = await parse({
            id: 'evt_5',
            type: 'payment_intent.succeeded',
            data: {
                object: {
                    id: 'pi_auto',
                    customer: 'cus_1',
                    amount: 1000,
                    amount_received: 1000,
                    currency: 'usd',
                    metadata: {
                        [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.autoRecharge,
                        [STRIPE_METADATA_KEYS.packId]: 'credits-1000',
                    },
                },
            },
        });

        expect(normalized).toEqual(
            expect.objectContaining({
                kind: 'credits.purchased',
                packId: 'credits-1000',
                amountCents: 1000,
                paymentId: 'pi_auto',
            }),
        );
    });

    it('normalizes a refund and a dispute to credits.refunded', async () => {
        const refund = await parse({
            id: 'evt_6',
            type: 'charge.refunded',
            data: {
                object: {
                    customer: 'cus_1',
                    amount_refunded: 2500,
                    currency: 'usd',
                    payment_intent: 'pi_1',
                },
            },
        });
        expect(refund).toEqual(
            expect.objectContaining({
                kind: 'credits.refunded',
                amountCents: 2500,
                paymentId: 'pi_1',
            }),
        );

        const dispute = await parse({
            id: 'evt_7',
            type: 'charge.dispute.created',
            data: { object: { amount: 5000, currency: 'usd', payment_intent: 'pi_2' } },
        });
        expect(dispute).toEqual(
            expect.objectContaining({ kind: 'credits.refunded', amountCents: 5000 }),
        );
    });

    it('normalizes an invoice event into a vendor-neutral snapshot', async () => {
        const normalized = await parse({
            id: 'evt_8',
            type: 'invoice.paid',
            data: {
                object: {
                    id: 'in_1',
                    customer: 'cus_1',
                    number: 'EW-1',
                    status: 'paid',
                    currency: 'usd',
                    subtotal: 5000,
                    total: 5000,
                    amount_paid: 5000,
                    period_start: 1_780_000_000,
                    period_end: 1_782_000_000,
                    created: 1_780_000_000,
                    hosted_invoice_url: 'https://pay.example/in_1',
                    invoice_pdf: null,
                    lines: { data: [{ description: '5,500 credits', quantity: 1, amount: 5000 }] },
                },
            },
        });

        expect(normalized.kind).toBe('invoice.updated');
        expect(normalized.invoice).toEqual(
            expect.objectContaining({
                providerInvoiceId: 'in_1',
                number: 'EW-1',
                status: 'paid',
                totalCents: 5000,
                lines: [{ description: '5,500 credits', quantity: 1, amountCents: 5000 }],
            }),
        );
        expect(normalized.invoice?.periodStart).toEqual(new Date(1_780_000_000 * 1000));
    });

    it('normalizes a payment method into brand/last4/expiry only', async () => {
        const normalized = await parse({
            id: 'evt_9',
            type: 'payment_method.attached',
            data: {
                object: {
                    id: 'pm_1',
                    customer: 'cus_1',
                    card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 },
                },
            },
        });

        expect(normalized.kind).toBe('payment_method.updated');
        expect(normalized.paymentMethod).toEqual({
            ref: 'pm_1',
            brand: 'visa',
            last4: '4242',
            expMonth: 4,
            expYear: 2031,
        });
    });

    it('normalizes an unhandled event type to ignored (never throws)', async () => {
        const normalized = await parse({
            id: 'evt_10',
            type: 'customer.subscription.trial_will_end',
            data: { object: {} },
        });

        expect(normalized).toEqual(
            expect.objectContaining({
                kind: 'ignored',
                providerType: 'customer.subscription.trial_will_end',
            }),
        );
    });

    it('resolves expanded objects to ids', async () => {
        const normalized = await parse({
            id: 'evt_11',
            type: 'charge.refunded',
            data: {
                object: {
                    customer: { id: 'cus_expanded' },
                    amount_refunded: 100,
                    payment_intent: { id: 'pi_expanded' },
                },
            },
        });

        expect(normalized.customerId).toBe('cus_expanded');
        expect(normalized.paymentId).toBe('pi_expanded');
    });
});
