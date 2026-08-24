import { BillingProviderError, BillingProviderNotConfiguredError } from './billing.provider';
import {
    StripeBillingProvider,
    STRIPE_METADATA_KEYS,
    STRIPE_PERPETUAL_LICENCE,
    STRIPE_PURCHASE_KINDS,
    STRIPE_SETUP_KIND,
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
        customers: {
            create: jest.fn().mockResolvedValue({ id: 'cus_new' }),
            update: jest.fn().mockResolvedValue({ id: 'cus_1' }),
        },
        checkout: {
            sessions: {
                create: jest
                    .fn()
                    .mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' }),
                retrieve: jest.fn(),
            },
        },
        paymentIntents: {
            create: jest.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' }),
        },
        paymentMethods: {
            list: jest.fn().mockResolvedValue({ data: [] }),
            retrieve: jest.fn().mockResolvedValue({ id: 'pm_1', customer: 'cus_1', card: {} }),
            detach: jest.fn().mockResolvedValue({ id: 'pm_1' }),
        },
        webhooks: { constructEvent: jest.fn() },
        ...overrides,
    } as any;
}

function cardMethod(id: string, customer: string | null, last4 = '4242') {
    return {
        id,
        customer,
        card: { brand: 'visa', last4, exp_month: 4, exp_year: 2031 },
    };
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
                create: jest.fn().mockRejectedValue(
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

describe('StripeBillingProvider — payment methods (billing PRD §3.3)', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    it('captures cards through the provider HOSTED element, never a form of ours', async () => {
        const { provider, client } = build();

        const session = await provider.createPaymentMethodSetupSession({
            userId: 'u1',
            customerId: 'cus_1',
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        // `mode: setup` is the hosted card element: the PAN is posted to
        // the provider's page, not to us.
        expect(params.mode).toBe('setup');
        expect(params.customer).toBe('cus_1');
        // No card datum is ever passed out of this process.
        expect(JSON.stringify(params)).not.toMatch(/card|number|cvc/i);
        expect(session).toEqual({ url: 'https://pay.example/cs_1', sessionId: 'cs_1' });
    });

    it('stamps the setup session with a kind that can NEVER credit the ledger', async () => {
        const { provider, client } = build();

        await provider.createPaymentMethodSetupSession({
            userId: 'u1',
            customerId: 'cus_1',
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
        });

        const meta = client.checkout.sessions.create.mock.calls[0][0].metadata;
        expect(meta[STRIPE_METADATA_KEYS.kind]).toBe(STRIPE_SETUP_KIND);
        expect(Object.values(STRIPE_PURCHASE_KINDS)).not.toContain(meta[STRIPE_METADATA_KEYS.kind]);
    });

    it('lists only cards attached to the given customer, as display metadata', async () => {
        const client = fakeClient();
        client.paymentMethods.list.mockResolvedValue({
            data: [cardMethod('pm_1', 'cus_1'), cardMethod('pm_2', 'cus_1', '1881')],
        });
        const { provider } = build(client);

        const methods = await provider.listPaymentMethods('cus_1');

        expect(client.paymentMethods.list).toHaveBeenCalledWith(
            expect.objectContaining({ customer: 'cus_1', type: 'card' }),
        );
        expect(methods).toEqual([
            { ref: 'pm_1', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2031 },
            { ref: 'pm_2', brand: 'visa', last4: '1881', expMonth: 4, expYear: 2031 },
        ]);
    });

    it('findPaymentMethod() returns null for a reference owned by ANOTHER customer', async () => {
        const client = fakeClient();
        client.paymentMethods.retrieve.mockResolvedValue(cardMethod('pm_x', 'cus_victim'));
        const { provider } = build(client);

        await expect(provider.findPaymentMethod('cus_attacker', 'pm_x')).resolves.toBeNull();
    });

    it('findPaymentMethod() returns null (never throws) for an unknown reference', async () => {
        const client = fakeClient();
        client.paymentMethods.retrieve.mockRejectedValue(new Error('No such PaymentMethod pm_zzz'));
        const { provider } = build(client);

        await expect(provider.findPaymentMethod('cus_1', 'pm_zzz')).resolves.toBeNull();
    });

    it('refuses to make a FOREIGN payment method the default', async () => {
        const client = fakeClient();
        client.paymentMethods.retrieve.mockResolvedValue(cardMethod('pm_x', 'cus_victim'));
        const { provider } = build(client);

        await expect(
            provider.setDefaultPaymentMethod('cus_attacker', 'pm_x'),
        ).rejects.toBeInstanceOf(BillingProviderError);
        expect(client.customers.update).not.toHaveBeenCalled();
    });

    it('refuses to detach a FOREIGN payment method', async () => {
        const client = fakeClient();
        client.paymentMethods.retrieve.mockResolvedValue(cardMethod('pm_x', 'cus_victim'));
        const { provider } = build(client);

        await expect(provider.detachPaymentMethod('cus_attacker', 'pm_x')).rejects.toBeInstanceOf(
            BillingProviderError,
        );
        expect(client.paymentMethods.detach).not.toHaveBeenCalled();
    });

    it('sets and detaches an OWNED payment method', async () => {
        const client = fakeClient();
        client.paymentMethods.retrieve.mockResolvedValue(cardMethod('pm_1', 'cus_1'));
        const { provider } = build(client);

        const updated = await provider.setDefaultPaymentMethod('cus_1', 'pm_1');
        expect(client.customers.update).toHaveBeenCalledWith('cus_1', {
            invoice_settings: { default_payment_method: 'pm_1' },
        });
        expect(updated).toEqual({
            ref: 'pm_1',
            brand: 'visa',
            last4: '4242',
            expMonth: 4,
            expYear: 2031,
        });

        await provider.detachPaymentMethod('cus_1', 'pm_1');
        expect(client.paymentMethods.detach).toHaveBeenCalledWith('pm_1');
    });

    it('fails closed on every payment-method method without a secret key', async () => {
        delete process.env.STRIPE_SECRET_KEY;
        const { provider, factory } = build();

        await expect(
            provider.createPaymentMethodSetupSession({
                userId: 'u1',
                customerId: 'cus_1',
                successUrl: 'https://app.test/ok',
                cancelUrl: 'https://app.test/no',
            }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
        await expect(provider.listPaymentMethods('cus_1')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        await expect(provider.findPaymentMethod('cus_1', 'pm_1')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        await expect(provider.setDefaultPaymentMethod('cus_1', 'pm_1')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        await expect(provider.detachPaymentMethod('cus_1', 'pm_1')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        expect(factory).not.toHaveBeenCalled();
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

    it('normalizes payment_method.detached to `payment_method.removed`', async () => {
        const normalized = await parse({
            id: 'evt_12',
            type: 'payment_method.detached',
            data: {
                object: cardMethod('pm_gone', null),
                // The object has already lost its customer; attribution
                // comes from the SIGNED previous_attributes.
                previous_attributes: { customer: 'cus_1' },
            },
        });

        expect(normalized.kind).toBe('payment_method.removed');
        expect(normalized.customerId).toBe('cus_1');
        expect(normalized.paymentMethod).toEqual(
            expect.objectContaining({ ref: 'pm_gone', last4: '4242' }),
        );
    });

    it('a hosted CARD-CAPTURE session never credits the ledger', async () => {
        const normalized = await parse({
            id: 'evt_13',
            type: 'checkout.session.completed',
            data: {
                object: {
                    customer: 'cus_1',
                    payment_status: 'no_payment_required',
                    metadata: { [STRIPE_METADATA_KEYS.kind]: STRIPE_SETUP_KIND },
                },
            },
        });

        expect(normalized.kind).toBe('ignored');
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

    // ── Subscription lifecycle (audit B07/B08) ───────────────────────

    function subscriptionObject(overrides: Record<string, unknown> = {}) {
        return {
            id: 'sub_1',
            customer: 'cus_1',
            currency: 'usd',
            status: 'active',
            cancel_at_period_end: false,
            canceled_at: null,
            // Only subscriptions WE sold carry this marker, and the
            // normalizer refuses to speak about any others — a Stripe
            // account may hold subscriptions this platform never sold, and
            // projecting their state onto one of our billing profiles
            // would be wrong. The fixture represents one of ours.
            metadata: {
                [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.planSubscription,
                [STRIPE_METADATA_KEYS.userId]: 'u1',
                [STRIPE_METADATA_KEYS.planCode]: 'standard',
                [STRIPE_METADATA_KEYS.referenceId]: 'u1:standard',
            },
            // Period end lives on the ITEMS in the current API version.
            items: { data: [{ id: 'si_1', current_period_end: 1_790_000_000 }] },
            ...overrides,
        };
    }

    it('normalizes a subscription update, reading the period end off the item', async () => {
        const normalized = await parse({
            id: 'evt_12',
            type: 'customer.subscription.updated',
            data: { object: subscriptionObject({ cancel_at_period_end: true }) },
        });

        // An ACTIVE subscription re-asserts the tier, so the kind is
        // `subscription.activated` (idempotent). What this test is really
        // about is the SNAPSHOT — which now rides on every kind, so a
        // `cancel_at_period_end` toggle reaches the billing profile.
        expect(normalized.kind).toBe('subscription.activated');
        expect(normalized.customerId).toBe('cus_1');
        expect(normalized.subscription).toEqual({
            subscriptionId: 'sub_1',
            status: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date(1_790_000_000 * 1000),
            canceledAt: null,
            // Billing spec §3.5 — the snapshot also carries the period
            // start + first item (this fixture sets no period start).
            currentPeriodStart: null,
            subscriptionItemId: 'si_1',
        });
    });

    it('carries a past_due status straight through (drives the recovery banner)', async () => {
        const normalized = await parse({
            id: 'evt_13',
            type: 'customer.subscription.updated',
            data: { object: subscriptionObject({ status: 'past_due' }) },
        });

        expect(normalized.subscription?.status).toBe('past_due');
    });

    it('treats a delete as terminal regardless of what the object still says', async () => {
        const normalized = await parse({
            id: 'evt_14',
            type: 'customer.subscription.deleted',
            data: {
                object: subscriptionObject({
                    status: 'active',
                    cancel_at_period_end: true,
                    canceled_at: 1_789_000_000,
                }),
            },
        });

        expect(normalized.subscription).toEqual(
            expect.objectContaining({
                status: 'canceled',
                cancelAtPeriodEnd: false,
                canceledAt: new Date(1_789_000_000 * 1000),
            }),
        );
    });

    it('falls back to the legacy top-level period end on an older payload', async () => {
        const normalized = await parse({
            id: 'evt_15',
            type: 'customer.subscription.updated',
            data: {
                object: subscriptionObject({
                    items: { data: [] },
                    current_period_end: 1_791_000_000,
                }),
            },
        });

        expect(normalized.subscription?.currentPeriodEnd).toEqual(new Date(1_791_000_000 * 1000));
    });

    it('maps an unrecognized provider status to `none` rather than trusting it', async () => {
        const normalized = await parse({
            id: 'evt_16',
            type: 'customer.subscription.updated',
            data: { object: subscriptionObject({ status: 'some_future_state' }) },
        });

        expect(normalized.subscription?.status).toBe('none');
    });
});

describe('StripeBillingProvider — subscription mutations + portal (B07/B08)', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    function withSubscriptions() {
        const updated = {
            id: 'sub_1',
            status: 'active',
            cancel_at_period_end: true,
            canceled_at: null,
            items: { data: [{ current_period_end: 1_790_000_000 }] },
        };
        const client = fakeClient({
            subscriptions: { update: jest.fn().mockResolvedValue(updated) },
            billingPortal: {
                sessions: {
                    create: jest
                        .fn()
                        .mockResolvedValue({ url: 'https://pay.example/portal/bps_1' }),
                },
            },
        });
        return build(client);
    }

    it('cancel schedules at period end — it never deletes the subscription', async () => {
        const { provider, client } = withSubscriptions();

        const snapshot = await provider.cancelSubscriptionAtPeriodEnd({
            subscriptionId: 'sub_1',
        });

        expect(client.subscriptions.update).toHaveBeenCalledWith('sub_1', {
            cancel_at_period_end: true,
        });
        // There is no `cancel`/delete call on the fake — if the provider
        // ever reached for one this spec would throw.
        expect(client.subscriptions.cancel).toBeUndefined();
        expect(snapshot).toEqual({
            subscriptionId: 'sub_1',
            status: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date(1_790_000_000 * 1000),
            canceledAt: null,
            currentPeriodStart: null,
            subscriptionItemId: null,
        });
    });

    it('resume clears the pending cancellation flag', async () => {
        const { provider, client } = withSubscriptions();

        await provider.resumeSubscription({ subscriptionId: 'sub_1' });

        expect(client.subscriptions.update).toHaveBeenCalledWith('sub_1', {
            cancel_at_period_end: false,
        });
    });

    it('creates a portal session with the SERVER-built return URL', async () => {
        const { provider, client } = withSubscriptions();

        const session = await provider.createBillingPortalSession({
            customerId: 'cus_1',
            returnUrl: 'https://app.test/settings/billing',
        });

        expect(client.billingPortal.sessions.create).toHaveBeenCalledWith({
            customer: 'cus_1',
            return_url: 'https://app.test/settings/billing',
        });
        expect(session).toEqual({ url: 'https://pay.example/portal/bps_1' });
    });

    it('fails closed on every lifecycle call without a secret key', async () => {
        delete process.env.STRIPE_SECRET_KEY;
        const { provider, factory } = build();

        await expect(
            provider.cancelSubscriptionAtPeriodEnd({ subscriptionId: 'sub_1' }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
        await expect(
            provider.resumeSubscription({ subscriptionId: 'sub_1' }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
        await expect(
            provider.createBillingPortalSession({
                customerId: 'cus_1',
                returnUrl: 'https://app.test/settings/billing',
            }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
        expect(factory).not.toHaveBeenCalled();
    });
});

describe('StripeBillingProvider — paid-plan checkout (audit B24)', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    const planRequest = {
        userId: 'u1',
        customerId: 'cus_1',
        plan: {
            code: 'standard',
            label: 'Standard plan',
            priceCents: 2900,
            currency: 'usd',
            interval: 'month' as const,
        },
        successUrl: 'https://app.test/settings/billing?plan=success',
        cancelUrl: 'https://app.test/settings/billing?plan=cancelled',
        referenceId: 'u1:standard',
    };

    it('creates a recurring session priced from the SERVER plan descriptor', async () => {
        const { provider, client } = build();

        const session = await provider.createPlanCheckoutSession(planRequest);

        expect(session).toEqual({
            url: 'https://pay.example/cs_1',
            sessionId: 'cs_1',
            customerId: 'cus_1',
        });
        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.mode).toBe('subscription');
        expect(params.line_items[0].price_data.unit_amount).toBe(2900);
        expect(params.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
    });

    it('buys a perpetual licence in payment mode, with no subscription_data', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: { ...planRequest.plan, mode: 'payment', code: 'selfhosted_pro' },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.mode).toBe('payment');
        // Stripe rejects subscription_data outright in payment mode; the one-off equivalent is
        // payment_intent_data, and the metadata has to be mirrored there because a one-off
        // purchase creates no subscription for it to live on.
        expect(params.subscription_data).toBeUndefined();
        expect(params.payment_intent_data.metadata[STRIPE_METADATA_KEYS.planCode]).toBe(
            'selfhosted_pro',
        );
    });

    it('marks a licence sale so manual fulfilment can find it', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: { ...planRequest.plan, mode: 'payment' },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        // Issuing the licence document is manual for now, so this marker is the only way to list
        // who is owed one. It must be on BOTH objects.
        expect(params.metadata[STRIPE_METADATA_KEYS.licence]).toBe(STRIPE_PERPETUAL_LICENCE);
        expect(params.payment_intent_data.metadata[STRIPE_METADATA_KEYS.licence]).toBe(
            STRIPE_PERPETUAL_LICENCE,
        );
    });

    it('leaves the licence marker OFF a recurring purchase', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession(planRequest);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.mode).toBe('subscription');
        // A false positive here would put a recurring subscriber on the manual-fulfilment list.
        expect(params.metadata[STRIPE_METADATA_KEYS.licence]).toBeUndefined();
        expect(params.subscription_data.metadata[STRIPE_METADATA_KEYS.licence]).toBeUndefined();
    });

    it('keeps a licence purchase on the SAME webhook kind, so activation is one path', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: { ...planRequest.plan, mode: 'payment' },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        // The act is identical — grant this user this plan — and `activate()` already accepts a
        // null provider subscription id. A separate kind would need a second activation path for
        // no reason, and the webhook gate keys on exactly this value.
        expect(params.metadata[STRIPE_METADATA_KEYS.kind]).toBe(
            STRIPE_PURCHASE_KINDS.planSubscription,
        );
    });

    /**
     * 🛑 REGRESSION. Stripe rejects a line item carrying `recurring` in a `mode: payment` session.
     * The inline fallback attached it unconditionally, so on any deployment whose catalog is NOT
     * synced — exactly the deployments the fallback exists to serve — the $99 perpetual licence
     * checkout threw instead of selling.
     */
    it('omits recurring from the inline fallback for a one-off licence', async () => {
        const { provider, client } = build();
        client.prices = { list: jest.fn().mockResolvedValue({ data: [] }) };

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: {
                ...planRequest.plan,
                mode: 'payment',
                lookupKey: 'ever_works_selfhosted_pro_lifetime',
            },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.mode).toBe('payment');
        expect(params.line_items[0].price_data).toBeDefined();
        expect(params.line_items[0].price_data.recurring).toBeUndefined();
    });

    it('KEEPS recurring on the inline fallback for a subscription', async () => {
        // Control: the fix must not strip it from the recurring path.
        const { provider, client } = build();
        client.prices = { list: jest.fn().mockResolvedValue({ data: [] }) };

        await provider.createPlanCheckoutSession(planRequest);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.mode).toBe('subscription');
        expect(params.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
    });

    it('bills the shared-account CATALOG price when the lookup key resolves', async () => {
        const { provider, client } = build();
        client.prices = {
            list: jest.fn().mockResolvedValue({ data: [{ id: 'price_cat_1' }] }),
        };

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: { ...planRequest.plan, lookupKey: 'ever_works_cloud_pro_monthly' },
        });

        expect(client.prices.list).toHaveBeenCalledWith(
            expect.objectContaining({
                lookup_keys: ['ever_works_cloud_pro_monthly'],
                active: true,
            }),
        );
        const params = client.checkout.sessions.create.mock.calls[0][0];
        // The catalog price object, NOT an ad-hoc amount — that is what makes the invoice line
        // traceable back to a reviewed commit.
        expect(params.line_items[0].price).toBe('price_cat_1');
        expect(params.line_items[0].price_data).toBeUndefined();
        expect(params.line_items).toHaveLength(1);
    });

    it('falls back to the inline price when the account has no such lookup key', async () => {
        // This is what protects self-hosters, CI and local dev: a deployment that has never run
        // the catalog sync must still be able to take a payment.
        const { provider, client } = build();
        client.prices = { list: jest.fn().mockResolvedValue({ data: [] }) };

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: { ...planRequest.plan, lookupKey: 'ever_works_cloud_pro_monthly' },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.line_items[0].price).toBeUndefined();
        expect(params.line_items[0].price_data.unit_amount).toBe(2900);
    });

    it('falls back to the inline price when the lookup itself throws', async () => {
        // A Stripe outage on the price lookup must not take checkout down with it.
        const { provider, client } = build();
        client.prices = { list: jest.fn().mockRejectedValue(new Error('stripe down')) };

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: { ...planRequest.plan, lookupKey: 'ever_works_cloud_pro_monthly' },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.line_items[0].price_data.unit_amount).toBe(2900);
    });

    /**
     * 🛑 REGRESSION. A THROWN lookup must not be memoised. It is a transient condition — timeout,
     * 5xx, rate limit — not an answer about this account. Caching it made one blip permanent for
     * the process lifetime, and because the seat line has no inline fallback (the per-seat amount
     * lives only in the catalog) every later checkout on that pod would silently stop billing
     * seats. Undercharging, and invisible after the first warning.
     */
    it('does NOT cache a thrown lookup — the next attempt retries and bills correctly', async () => {
        const { provider, client } = build();
        const list = jest
            .fn()
            .mockRejectedValueOnce(new Error('stripe timeout'))
            .mockResolvedValue({ data: [{ id: 'price_cat_1' }] });
        client.prices = { list };

        const req = {
            ...planRequest,
            plan: { ...planRequest.plan, lookupKey: 'ever_works_cloud_pro_monthly' },
        };

        // First attempt: the lookup throws, so it falls back to the inline price.
        await provider.createPlanCheckoutSession(req);
        expect(
            client.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data,
        ).toBeDefined();

        // Second attempt: Stripe is healthy again and the catalog price MUST be used.
        await provider.createPlanCheckoutSession(req);
        const second = client.checkout.sessions.create.mock.calls[1][0];
        expect(second.line_items[0].price).toBe('price_cat_1');
        expect(second.line_items[0].price_data).toBeUndefined();
        // Proves the retry actually happened rather than a cached null being reused.
        expect(list).toHaveBeenCalledTimes(2);
    });

    /**
     * 🛑 A MISS must NOT be memoised either. The catalog is published by a script that runs
     * independently of the pods, so a pod that starts before the sync would otherwise pin every key
     * to null for its whole lifetime — and because the seat line has no inline fallback, that pod
     * silently stops billing seats, with nothing in the logs after the first warning.
     */
    it('re-checks after a MISS, so a later catalog sync is picked up without a restart', async () => {
        const { provider, client } = build();
        const list = jest
            .fn()
            .mockResolvedValueOnce({ data: [] }) // catalog not synced yet
            .mockResolvedValue({ data: [{ id: 'price_cat_1' }] }); // sync ran
        client.prices = { list };

        const req = {
            ...planRequest,
            plan: { ...planRequest.plan, lookupKey: 'ever_works_cloud_pro_monthly' },
        };
        await provider.createPlanCheckoutSession(req);
        await provider.createPlanCheckoutSession(req);

        expect(list).toHaveBeenCalledTimes(2);
        // The second checkout uses the now-published catalog price rather than a cached miss.
        expect(client.checkout.sessions.create.mock.calls[1][0].line_items[0].price).toBe(
            'price_cat_1',
        );
    });

    /**
     * 🛑 REGRESSION. The resolved-price cache belongs to the KEY, not the process. The same 22
     * `ever_works_*` lookup keys exist in BOTH test and live mode of the shared account, so a
     * process that resolved under `sk_test_…` and rotates to `sk_live_…` would otherwise hand
     * TEST-mode price ids to a LIVE client.
     */
    it('drops the price cache when the secret key rotates', async () => {
        const { provider, client } = build();
        const list = jest
            .fn()
            .mockResolvedValueOnce({ data: [{ id: 'price_TEST_mode' }] })
            .mockResolvedValue({ data: [{ id: 'price_LIVE_mode' }] });
        client.prices = { list };

        const req = {
            ...planRequest,
            plan: { ...planRequest.plan, lookupKey: 'ever_works_cloud_pro_monthly' },
        };

        await provider.createPlanCheckoutSession(req);
        expect(client.checkout.sessions.create.mock.calls[0][0].line_items[0].price).toBe(
            'price_TEST_mode',
        );

        // Rotate the key, exactly as a Secret update would.
        process.env.STRIPE_SECRET_KEY = 'sk_live_rotated';
        await provider.createPlanCheckoutSession(req);

        const second = client.checkout.sessions.create.mock.calls[1][0];
        expect(second.line_items[0].price).toBe('price_LIVE_mode');
        // Proves the cache was dropped rather than the id reused.
        expect(list).toHaveBeenCalledTimes(2);
    });

    it('memoises a HIT, so a healthy account is queried once and not per checkout', async () => {
        const { provider, client } = build();
        const list = jest.fn().mockResolvedValue({ data: [{ id: 'price_cat_1' }] });
        client.prices = { list };

        const req = {
            ...planRequest,
            plan: { ...planRequest.plan, lookupKey: 'ever_works_cloud_pro_monthly' },
        };
        await provider.createPlanCheckoutSession(req);
        await provider.createPlanCheckoutSession(req);

        expect(list).toHaveBeenCalledTimes(1);
    });

    it('adds a second line item for the seats beyond the allowance', async () => {
        const { provider, client } = build();
        client.prices = {
            list: jest.fn().mockImplementation(async ({ lookup_keys }) => ({
                data: [{ id: lookup_keys[0].includes('_seat_') ? 'price_seat_1' : 'price_cat_1' }],
            })),
        };

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: {
                ...planRequest.plan,
                lookupKey: 'ever_works_cloud_pro_monthly',
                seatLookupKey: 'ever_works_cloud_pro_seat_monthly',
                extraSeats: 17,
            },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.line_items).toHaveLength(2);
        expect(params.line_items[0]).toEqual({ quantity: 1, price: 'price_cat_1' });
        expect(params.line_items[1]).toEqual({ quantity: 17, price: 'price_seat_1' });
    });

    it('never emits a zero-quantity seat line — Stripe rejects one', async () => {
        const { provider, client } = build();
        client.prices = { list: jest.fn().mockResolvedValue({ data: [{ id: 'price_cat_1' }] }) };

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: {
                ...planRequest.plan,
                lookupKey: 'ever_works_cloud_pro_monthly',
                seatLookupKey: 'ever_works_cloud_pro_seat_monthly',
                extraSeats: 0,
            },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.line_items).toHaveLength(1);
    });

    it('sells the base plan rather than inventing a seat price it cannot resolve', async () => {
        // The per-seat amount lives in the catalog, not the plan row, so there is no honest inline
        // fallback for it. Billing a made-up number would be worse than under-billing.
        const { provider, client } = build();
        client.prices = {
            list: jest.fn().mockImplementation(async ({ lookup_keys }) => ({
                data: lookup_keys[0].includes('_seat_') ? [] : [{ id: 'price_cat_1' }],
            })),
        };

        await provider.createPlanCheckoutSession({
            ...planRequest,
            plan: {
                ...planRequest.plan,
                lookupKey: 'ever_works_cloud_pro_monthly',
                seatLookupKey: 'ever_works_cloud_pro_seat_monthly',
                extraSeats: 4,
            },
        });

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.line_items).toHaveLength(1);
        expect(params.line_items[0].price).toBe('price_cat_1');
    });

    it('mirrors the plan metadata onto the SUBSCRIPTION so renewals stay attributable', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession(planRequest);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.metadata[STRIPE_METADATA_KEYS.kind]).toBe(
            STRIPE_PURCHASE_KINDS.planSubscription,
        );
        expect(params.metadata[STRIPE_METADATA_KEYS.planCode]).toBe('standard');
        // Unlike the credit path, the lifecycle events are a DIFFERENT
        // decision and must carry the plan themselves.
        expect(params.subscription_data.metadata).toEqual(params.metadata);
    });

    it('appends its own session-id token to the caller’s clean success URL', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession(planRequest);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.success_url).toBe(
            'https://app.test/settings/billing?plan=success&session_id={CHECKOUT_SESSION_ID}',
        );
        // The cancel URL is passed through untouched.
        expect(params.cancel_url).toBe('https://app.test/settings/billing?plan=cancelled');
    });

    it('fails closed with no secret key', async () => {
        delete process.env.STRIPE_SECRET_KEY;
        const { provider } = build();

        await expect(provider.createPlanCheckoutSession(planRequest)).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
    });

    it('reads a session back with the metadata WE stamped (the ownership check)', async () => {
        const client = fakeClient();
        client.checkout.sessions.retrieve = jest.fn().mockResolvedValue({
            id: 'cs_plan_1',
            status: 'complete',
            payment_status: 'paid',
            customer: 'cus_1',
            subscription: { id: 'sub_1', current_period_end: 1790000000 },
            metadata: {
                [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.planSubscription,
                [STRIPE_METADATA_KEYS.userId]: 'u1',
                [STRIPE_METADATA_KEYS.planCode]: 'standard',
            },
        });
        const { provider } = build(client);

        const snapshot = await provider.retrieveCheckoutSession('cs_plan_1');

        expect(snapshot).toEqual(
            expect.objectContaining({
                sessionId: 'cs_plan_1',
                status: 'complete',
                paid: true,
                purpose: 'plan',
                userId: 'u1',
                planCode: 'standard',
                customerId: 'cus_1',
                subscriptionId: 'sub_1',
            }),
        );
        expect(snapshot.currentPeriodEnd).toEqual(new Date(1790000000 * 1000));
    });

    it('treats a trial session (no payment required) as settled', async () => {
        const client = fakeClient();
        client.checkout.sessions.retrieve = jest.fn().mockResolvedValue({
            id: 'cs_plan_2',
            status: 'complete',
            payment_status: 'no_payment_required',
            metadata: {
                [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.planSubscription,
                [STRIPE_METADATA_KEYS.userId]: 'u1',
                [STRIPE_METADATA_KEYS.planCode]: 'standard',
            },
        });
        const { provider } = build(client);

        expect((await provider.retrieveCheckoutSession('cs_plan_2')).paid).toBe(true);
    });

    it('labels a credit session read through this route as `credits`, not `plan`', async () => {
        const client = fakeClient();
        client.checkout.sessions.retrieve = jest.fn().mockResolvedValue({
            id: 'cs_1',
            status: 'complete',
            payment_status: 'paid',
            metadata: {
                [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.checkout,
                [STRIPE_METADATA_KEYS.userId]: 'u1',
                [STRIPE_METADATA_KEYS.packId]: 'credits-1000',
            },
        });
        const { provider } = build(client);

        const snapshot = await provider.retrieveCheckoutSession('cs_1');
        expect(snapshot.purpose).toBe('credits');
        expect(snapshot.planCode).toBeNull();
    });

    it('never echoes the provider message when a session cannot be read', async () => {
        const client = fakeClient();
        client.checkout.sessions.retrieve = jest
            .fn()
            .mockRejectedValue(new Error('No such checkout.session: cs_secret; req_123'));
        const { provider } = build(client);

        await expect(provider.retrieveCheckoutSession('cs_missing')).rejects.toMatchObject({
            name: 'BillingProviderError',
            message: 'Checkout session could not be read',
        });
    });
});

describe('StripeBillingProvider — subscription event normalization (audit B24)', () => {
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

    const planMeta = {
        [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.planSubscription,
        [STRIPE_METADATA_KEYS.userId]: 'u1',
        [STRIPE_METADATA_KEYS.planCode]: 'standard',
        [STRIPE_METADATA_KEYS.referenceId]: 'u1:standard',
    };

    it('normalizes a paid plan checkout to subscription.activated', async () => {
        const normalized = await parse({
            id: 'evt_p1',
            type: 'checkout.session.completed',
            data: {
                object: {
                    payment_status: 'paid',
                    customer: 'cus_1',
                    client_reference_id: 'u1:standard',
                    subscription: 'sub_1',
                    amount_total: 2900,
                    currency: 'usd',
                    metadata: planMeta,
                },
            },
        });

        expect(normalized).toEqual(
            expect.objectContaining({
                kind: 'subscription.activated',
                planCode: 'standard',
                subscriptionId: 'sub_1',
                customerId: 'cus_1',
                referenceId: 'u1:standard',
            }),
        );
    });

    it('never activates a plan from an unpaid checkout session', async () => {
        const normalized = await parse({
            id: 'evt_p2',
            type: 'checkout.session.completed',
            data: { object: { payment_status: 'unpaid', metadata: planMeta } },
        });

        expect(normalized.kind).toBe('ignored');
    });

    it('does not confuse a plan checkout with a credit top-up', async () => {
        const normalized = await parse({
            id: 'evt_p3',
            type: 'checkout.session.completed',
            data: {
                object: { payment_status: 'paid', amount_total: 2900, metadata: planMeta },
            },
        });

        // A plan sale must NEVER credit the usage ledger.
        expect(normalized.kind).not.toBe('credits.purchased');
        expect(normalized.packId).toBeNull();
    });

    it('normalizes an active subscription update to subscription.activated', async () => {
        const normalized = await parse({
            id: 'evt_p4',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    id: 'sub_1',
                    status: 'active',
                    customer: 'cus_1',
                    cancel_at_period_end: true,
                    current_period_end: 1790000000,
                    metadata: planMeta,
                },
            },
        });

        expect(normalized).toEqual(
            expect.objectContaining({
                kind: 'subscription.activated',
                subscriptionId: 'sub_1',
                planCode: 'standard',
                cancelAtPeriodEnd: true,
            }),
        );
        expect(normalized.currentPeriodEnd).toEqual(new Date(1790000000 * 1000));
    });

    it('reads the period end from the subscription ITEM when the root field is absent', async () => {
        const normalized = await parse({
            id: 'evt_p5',
            type: 'customer.subscription.updated',
            data: {
                object: {
                    id: 'sub_1',
                    status: 'trialing',
                    metadata: planMeta,
                    items: { data: [{ current_period_end: 1790000001 }] },
                },
            },
        });

        expect(normalized.kind).toBe('subscription.activated');
        expect(normalized.currentPeriodEnd).toEqual(new Date(1790000001 * 1000));
    });

    it('normalizes a deleted subscription to subscription.canceled', async () => {
        const normalized = await parse({
            id: 'evt_p6',
            type: 'customer.subscription.deleted',
            data: { object: { id: 'sub_1', status: 'canceled', metadata: planMeta } },
        });

        expect(normalized.kind).toBe('subscription.canceled');
        expect(normalized.subscriptionId).toBe('sub_1');
    });

    it('does NOT revoke a plan on a transient dunning state', async () => {
        for (const status of ['past_due', 'incomplete']) {
            const normalized = await parse({
                id: `evt_p7_${status}`,
                type: 'customer.subscription.updated',
                data: { object: { id: 'sub_1', status, metadata: planMeta } },
            });
            // The invariant this test is named for: a transient state must
            // never produce a REVOKING kind. `subscription.canceled` is
            // the only kind that revokes.
            expect(normalized.kind).not.toBe('subscription.canceled');
            // It used to assert `ignored`, which was the proxy for "nothing
            // happens" back when there was nowhere else for these to go.
            // Audit B07/B08 gives them a home: they now surface as a
            // lifecycle snapshot, which is what drives the dunning banner.
            // The no-revoke guarantee moved to where revoking actually
            // happens — see plan-subscription.service.spec.
            expect(normalized.kind).toBe('subscription.updated');
        }
    });

    it('ignores a subscription that is not one of ours', async () => {
        const normalized = await parse({
            id: 'evt_p8',
            type: 'customer.subscription.updated',
            data: { object: { id: 'sub_other', status: 'active', metadata: {} } },
        });

        expect(normalized.kind).toBe('ignored');
    });
});

// H5: the account has Stripe Tax active with live registrations, but no session asked for it —
// so every invoice would have shipped with NO tax line while we were registered to collect it.
// A session only calculates tax if it sets `automatic_tax`; nothing else turns it on.
describe('Stripe Tax — every session that CHARGES asks for tax', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    const taxPlanRequest = {
        userId: 'u1',
        customerId: 'cus_1',
        plan: {
            code: 'standard',
            label: 'Standard plan',
            priceCents: 2500,
            currency: 'usd',
            interval: 'month' as const,
        },
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/no',
        referenceId: 'u1:standard',
    };

    it('enables automatic tax on a plan checkout, and collects what Stripe needs to compute it', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession(taxPlanRequest as any);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.automatic_tax).toEqual({ enabled: true });
        // Required alongside automatic_tax when an existing customer is passed: Stripe needs an
        // address to pick a jurisdiction, and without this the session errors instead of taxing.
        //
        // 🛑 `name: 'auto'` is just as load-bearing, and this assertion previously said
        // `{ address: 'auto' }` alone — which Stripe REJECTS with a 400 whenever
        // `tax_id_collection` is on and the session names an existing customer. The test
        // passed because it asserted the object we built, not the object Stripe accepts.
        expect(params.customer_update).toEqual({ address: 'auto', name: 'auto' });
        // Lets a business supply its VAT/GST number, which is what triggers EU reverse charge.
        expect(params.tax_id_collection).toEqual({ enabled: true });
    });

    it('enables automatic tax on a credit-pack purchase too', async () => {
        const { provider, client } = build();

        await provider.createCreditCheckoutSession({
            userId: 'u1',
            userEmail: 'u1@example.com',
            customerId: 'cus_1',
            pack: {
                id: 'credits-5500',
                label: '5,500 credits',
                credits: 5500,
                priceCents: 5000,
                currency: 'usd',
            },
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
            referenceId: 'u1:credits-5500',
        } as any);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.automatic_tax).toEqual({ enabled: true });
    });

    /**
     * 🛑 THE INVARIANT THIS FILE EXISTS TO PROTECT.
     *
     * Stripe refuses `tax_id_collection` on any session that passes an existing
     * `customer` unless `customer_update.name` is also `'auto'`:
     *
     *   "Tax ID collection requires updating business name on the customer. To
     *    enable tax ID collection for an existing customer, please set
     *    `customer_update[name]` to `auto`."
     *
     * Every charging session here passes a customer, so dropping that one field
     * does not degrade tax collection — it 400s EVERY purchase in the product:
     * credit packs, plans and the perpetual licence alike.
     *
     * This cannot be caught by mocking harder. The Stripe client is a jest mock in
     * these specs, so it accepts any shape; the rejection exists only at the real
     * API. Verified against Stripe test mode on 2026-08-23:
     *   address-only            -> 400 invalid_request_error
     *   address + name = 'auto' -> 200, session created
     * Re-run that probe if this ever needs changing; do not reason about it.
     */
    it('pairs tax_id_collection with customer_update.name on EVERY charging session', async () => {
        const { provider, client } = build();

        await provider.createPlanCheckoutSession(taxPlanRequest as any);
        await provider.createCreditCheckoutSession({
            userId: 'u1',
            userEmail: 'u1@example.com',
            customerId: 'cus_1',
            pack: {
                id: 'credits-1000',
                label: '1,000 credits',
                credits: 1000,
                priceCents: 1000,
                currency: 'usd',
            },
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
            referenceId: 'u1:credits-1000',
        } as any);
        await provider.createPlanCheckoutSession({
            ...taxPlanRequest,
            plan: { ...taxPlanRequest.plan, mode: 'payment', code: 'selfhosted_pro' },
        } as any);

        const calls = client.checkout.sessions.create.mock.calls.map(([params]) => params);
        expect(calls).toHaveLength(3);
        for (const params of calls) {
            if (!params.tax_id_collection?.enabled) continue;
            expect(params.customer_update?.name).toBe('auto');
        }
        // Control: the loop must actually have inspected something. Without this, a
        // future change that stops setting tax_id_collection would make the assertion
        // vacuous and this test would keep passing while collecting no tax ids.
        expect(calls.filter((p) => p.tax_id_collection?.enabled)).toHaveLength(3);
    });

    it('does NOT enable automatic tax on a card-setup session', async () => {
        // `mode: 'setup'` charges nothing and Stripe rejects automatic_tax there, so this is not
        // an oversight to "fix" later — sending it would break saving a card outright.
        const { provider, client } = build();

        await provider.createPaymentMethodSetupSession({
            userId: 'u1',
            customerId: 'cus_1',
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
        } as any);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.mode).toBe('setup');
        expect(params.automatic_tax).toBeUndefined();
        expect(params.tax_id_collection).toBeUndefined();
    });

    /**
     * 🛑 A `mode: 'setup'` session needs EITHER `currency` or an explicit
     * `payment_method_types`. With neither, Stripe answers
     * "Missing required param: currency" and saving a card fails outright - it does
     * not degrade, it 400s.
     *
     * This was live and unnoticed because the Stripe client is mocked here, so the
     * incomplete shape looked fine to every test. Confirmed against Stripe test mode
     * on 2026-08-23: without currency => 400, with currency => 200 and
     * `payment_method_types: ["card"]` still resolved dynamically.
     */
    it('sends a currency on the setup session, or Stripe refuses it', async () => {
        const { provider, client } = build();

        await provider.createPaymentMethodSetupSession({
            userId: 'u1',
            customerId: 'cus_1',
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
        } as any);

        const params = client.checkout.sessions.create.mock.calls[0][0];
        expect(params.mode).toBe('setup');
        expect(Boolean(params.currency) || Boolean(params.payment_method_types?.length)).toBe(true);
    });
});

describe('StripeBillingProvider — pay-as-you-go (billing spec §3.5)', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
        process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    });

    const subscriptionObject = {
        id: 'sub_payg',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
        canceled_at: null,
        currency: 'usd',
        metadata: {
            [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.paygSubscription,
            [STRIPE_METADATA_KEYS.userId]: 'u1',
            [STRIPE_METADATA_KEYS.referenceId]: 'u1:payg',
        },
        items: {
            data: [
                {
                    id: 'si_payg',
                    current_period_start: 1_787_000_000,
                    current_period_end: 1_789_600_000,
                },
            ],
        },
    };

    function withPayg(overrides: Record<string, unknown> = {}) {
        const client = fakeClient({
            prices: {
                list: jest.fn().mockResolvedValue({ data: [{ id: 'price_payg' }] }),
            },
            subscriptions: {
                create: jest.fn().mockResolvedValue(subscriptionObject),
                cancel: jest.fn().mockResolvedValue({
                    ...subscriptionObject,
                    status: 'canceled',
                    canceled_at: 1_788_000_000,
                }),
                retrieve: jest.fn().mockResolvedValue(subscriptionObject),
            },
            billing: {
                meterEvents: { create: jest.fn().mockResolvedValue({ identifier: 'run:r1' }) },
            },
            ...overrides,
        });
        return build(client);
    }

    const request = {
        userId: 'u1',
        customerId: 'cus_1',
        paymentMethodRef: 'pm_1',
        lookupKey: 'ever_works_payg_credits_monthly',
        invoiceThresholdCents: 5000,
        referenceId: 'u1:payg',
        idempotencyKey: 'payg-enable:u1:cus_1:initial',
    };

    it('creates the usage subscription from the CATALOG price (never inline), with thresholds, card and our metadata', async () => {
        const { provider, client } = withPayg();

        const snapshot = await provider.createMeteredSubscription(request);

        expect(client.prices.list).toHaveBeenCalledWith({
            lookup_keys: ['ever_works_payg_credits_monthly'],
            active: true,
            limit: 1,
        });
        expect(client.subscriptions.create).toHaveBeenCalledWith(
            {
                customer: 'cus_1',
                items: [{ price: 'price_payg' }],
                collection_method: 'charge_automatically',
                default_payment_method: 'pm_1',
                billing_thresholds: { amount_gte: 5000, reset_billing_cycle_anchor: false },
                // Stripe Tax, same posture as every charging Checkout session.
                automatic_tax: { enabled: true },
                metadata: {
                    [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.paygSubscription,
                    [STRIPE_METADATA_KEYS.userId]: 'u1',
                    [STRIPE_METADATA_KEYS.referenceId]: 'u1:payg',
                },
            },
            { idempotencyKey: 'payg-enable:u1:cus_1:initial' },
        );
        expect(snapshot).toEqual({
            subscriptionId: 'sub_payg',
            status: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: new Date(1_789_600_000 * 1000),
            canceledAt: null,
            currentPeriodStart: new Date(1_787_000_000 * 1000),
            subscriptionItemId: 'si_payg',
        });
    });

    // Same posture as every charging Checkout session (STRIPE_TAX_SESSION_FIELDS):
    // the account has Stripe Tax active with live registrations, so an arrears
    // invoice that shipped without a tax line would be VAT out of margin.
    it('always asks for automatic tax on the usage subscription, and never the Checkout-only tax params', async () => {
        const { provider, client } = withPayg();
        await provider.createMeteredSubscription(request);
        const params = client.subscriptions.create.mock.calls[0][0];
        expect(params.automatic_tax).toEqual({ enabled: true });
        // `customer_update` / `tax_id_collection` are Checkout-only — Stripe
        // rejects them on subscriptions.create.
        expect(params.customer_update).toBeUndefined();
        expect(params.tax_id_collection).toBeUndefined();
    });

    it('refuses to create the usage subscription when the catalog price is not in this account (no inline fallback)', async () => {
        const { provider, client } = withPayg({
            prices: { list: jest.fn().mockResolvedValue({ data: [] }) },
        });
        await expect(provider.createMeteredSubscription(request)).rejects.toMatchObject({
            name: 'BillingProviderError',
            code: 'payg-price-missing',
        });
        expect(client.subscriptions.create).not.toHaveBeenCalled();
    });

    it('cancels the usage subscription IMMEDIATELY and invoices accrued usage now', async () => {
        const { provider, client } = withPayg();
        const snapshot = await provider.cancelMeteredSubscriptionNow({
            subscriptionId: 'sub_payg',
        });
        expect(client.subscriptions.cancel).toHaveBeenCalledWith('sub_payg', {
            invoice_now: true,
            prorate: false,
        });
        expect(snapshot.status).toBe('canceled');
        expect(snapshot.canceledAt).toEqual(new Date(1_788_000_000 * 1000));
    });

    it('reports a meter event with the identifier as BOTH payload identifier and request idempotency key', async () => {
        const { provider, client } = withPayg();
        const when = new Date('2026-09-10T12:00:00.000Z');

        const outcome = await provider.reportMeterEvent({
            eventName: 'ever_works_credits',
            customerId: 'cus_1',
            value: 380,
            identifier: 'run:r1',
            timestamp: when,
        });

        expect(outcome).toEqual({ status: 'accepted' });
        expect(client.billing.meterEvents.create).toHaveBeenCalledWith(
            {
                event_name: 'ever_works_credits',
                identifier: 'run:r1',
                timestamp: Math.floor(when.getTime() / 1000),
                payload: { stripe_customer_id: 'cus_1', value: '380' },
            },
            { idempotencyKey: 'run:r1' },
        );
    });

    it('returns (never throws) a provider refusal, flagging a timestamp-window refusal as terminal', async () => {
        const { provider, client } = withPayg();
        client.billing.meterEvents.create
            .mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { code: 'rate_limit' }))
            .mockRejectedValueOnce(
                Object.assign(new Error('The timestamp must be within the past 35 days'), {
                    code: 'invalid_request_error',
                }),
            );
        const req = {
            eventName: 'ever_works_credits',
            customerId: 'cus_1',
            value: 1,
            identifier: 'run:r2',
            timestamp: new Date(),
        };
        await expect(provider.reportMeterEvent(req)).resolves.toEqual({
            status: 'failed',
            failureCode: 'rate_limit',
            terminal: false,
        });
        await expect(provider.reportMeterEvent(req)).resolves.toMatchObject({
            status: 'failed',
            terminal: true,
        });
    });

    it('fails closed on every pay-as-you-go call without a secret key', async () => {
        delete process.env.STRIPE_SECRET_KEY;
        const { provider, factory } = build();
        await expect(provider.retrieveSubscriptionSnapshot('sub_payg')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        await expect(
            provider.reportMeterEvent({
                eventName: 'x',
                customerId: 'cus_1',
                value: 1,
                identifier: 'run:r3',
                timestamp: new Date(),
            }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
        expect(factory).not.toHaveBeenCalled();
    });

    describe('normalization', () => {
        function parse(raw: any) {
            const client = fakeClient({
                webhooks: { constructEvent: jest.fn().mockReturnValue(raw) },
            });
            const { provider } = build(client);
            return provider.verifyAndParseWebhook('{}', 'sig');
        }

        it('routes the usage subscription to payg.updated — never to a plan-tier kind', async () => {
            const normalized = await parse({
                id: 'evt_p1',
                type: 'customer.subscription.updated',
                data: { object: { ...subscriptionObject, status: 'past_due' } },
            });
            expect(normalized.kind).toBe('payg.updated');
            expect(normalized.subscriptionId).toBe('sub_payg');
            expect(normalized.customerId).toBe('cus_1');
            expect(normalized.referenceId).toBe('u1:payg');
            expect(normalized.subscription).toEqual(
                expect.objectContaining({
                    status: 'past_due',
                    currentPeriodStart: new Date(1_787_000_000 * 1000),
                    subscriptionItemId: 'si_payg',
                }),
            );
            expect(normalized.planCode).toBeUndefined();
        });

        it('a deleted usage subscription is terminal regardless of the object status', async () => {
            const normalized = await parse({
                id: 'evt_p2',
                type: 'customer.subscription.deleted',
                data: { object: subscriptionObject },
            });
            expect(normalized.kind).toBe('payg.updated');
            expect(normalized.subscription?.status).toBe('canceled');
        });

        it('tags a pay-as-you-go invoice with its subscription kind and flags payment failures', async () => {
            const invoice = {
                id: 'in_1',
                customer: 'cus_1',
                status: 'open',
                total: 380,
                subtotal: 380,
                amount_paid: 0,
                currency: 'usd',
                lines: { data: [] },
                parent: {
                    type: 'subscription_details',
                    subscription_details: {
                        subscription: 'sub_payg',
                        metadata: {
                            [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.paygSubscription,
                        },
                    },
                },
            };
            const failed = await parse({
                id: 'evt_i1',
                type: 'invoice.payment_failed',
                data: { object: invoice },
            });
            expect(failed.kind).toBe('invoice.updated');
            expect(failed.invoice).toEqual(
                expect.objectContaining({
                    subscriptionId: 'sub_payg',
                    subscriptionKind: 'payg',
                    paymentFailed: true,
                }),
            );
            const paid = await parse({
                id: 'evt_i2',
                type: 'invoice.paid',
                data: { object: { ...invoice, status: 'paid', amount_paid: 380 } },
            });
            expect(paid.invoice).toEqual(
                expect.objectContaining({
                    subscriptionKind: 'payg',
                    paymentFailed: false,
                    status: 'paid',
                }),
            );
        });

        it('tags a plan invoice as plan and a one-off as null (legacy top-level fields still read)', async () => {
            const legacy = await parse({
                id: 'evt_i3',
                type: 'invoice.paid',
                data: {
                    object: {
                        id: 'in_2',
                        customer: 'cus_1',
                        status: 'paid',
                        total: 2500,
                        subtotal: 2500,
                        amount_paid: 2500,
                        currency: 'usd',
                        lines: { data: [] },
                        subscription: 'sub_plan',
                        subscription_details: {
                            metadata: {
                                [STRIPE_METADATA_KEYS.kind]: STRIPE_PURCHASE_KINDS.planSubscription,
                            },
                        },
                    },
                },
            });
            expect(legacy.invoice).toEqual(
                expect.objectContaining({ subscriptionId: 'sub_plan', subscriptionKind: 'plan' }),
            );
            const oneOff = await parse({
                id: 'evt_i4',
                type: 'invoice.paid',
                data: {
                    object: {
                        id: 'in_3',
                        customer: 'cus_1',
                        status: 'paid',
                        total: 1000,
                        subtotal: 1000,
                        amount_paid: 1000,
                        currency: 'usd',
                        lines: { data: [] },
                    },
                },
            });
            expect(oneOff.invoice).toEqual(
                expect.objectContaining({ subscriptionId: null, subscriptionKind: null }),
            );
        });
    });
});
