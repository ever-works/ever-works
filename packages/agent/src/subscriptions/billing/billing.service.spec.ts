import {
    BillingService,
    UnknownCreditPackError,
    BILLING_PAYMENT_REF_TYPE,
} from './billing.service';
import { BillingProviderNotConfiguredError, type BillingWebhookEvent } from './billing.provider';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';

/**
 * The money path's business layer. No DB, no Nest container, no vendor
 * SDK — the `BillingProvider` seam is a jest.fn() shell, which is exactly
 * the swappability the seam exists to give us.
 *
 * What these specs pin (billing PRD §3.2/§3.5/§5.2):
 *   - checkout is priced by the SERVER pack table, never by the caller;
 *   - webhook writes are idempotent on the provider EVENT id;
 *   - refunds reverse from what was actually granted;
 *   - unattributable / unknown events are acknowledged, never 500'd.
 */

function makeProvider(overrides: Record<string, unknown> = {}) {
    return {
        getProviderId: jest.fn().mockReturnValue('stripe'),
        getDefaultCurrency: jest.fn().mockReturnValue('usd'),
        isConfigured: jest.fn().mockReturnValue(true),
        isWebhookConfigured: jest.fn().mockReturnValue(true),
        ensureCustomer: jest.fn().mockResolvedValue('cus_1'),
        createCreditCheckoutSession: jest.fn().mockResolvedValue({
            url: 'https://pay.example/session/cs_1',
            sessionId: 'cs_1',
            customerId: 'cus_1',
        }),
        chargeOffSession: jest.fn(),
        verifyAndParseWebhook: jest.fn(),
        ...overrides,
    } as any;
}

function makeProfileRepository(profile: any = null, overrides: Record<string, unknown> = {}) {
    return {
        findByUserId: jest.fn().mockResolvedValue(profile),
        findByCustomerId: jest.fn().mockResolvedValue(profile),
        ensure: jest
            .fn()
            .mockResolvedValue(profile ?? { userId: 'u1', providerCustomerId: 'cus_1' }),
        updatePaymentMethod: jest.fn().mockResolvedValue(profile),
        updateAutoRecharge: jest.fn().mockResolvedValue(profile),
        claimAutoRechargeSlot: jest.fn().mockResolvedValue(true),
        releaseAutoRechargeSlot: jest.fn().mockResolvedValue(undefined),
        recordAutoRechargeFailure: jest.fn().mockResolvedValue(undefined),
        resetAutoRechargeFailures: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as any;
}

function makeInvoiceRepository(overrides: Record<string, unknown> = {}) {
    return {
        mirror: jest.fn().mockResolvedValue({ id: 'inv-1' }),
        findForUser: jest.fn().mockResolvedValue({ invoices: [], total: 0 }),
        findOneForUser: jest.fn().mockResolvedValue(null),
        ...overrides,
    } as any;
}

function makeLedgerRepository(overrides: Record<string, unknown> = {}) {
    return {
        findByIdempotencyKey: jest.fn().mockResolvedValue(null),
        findLatestByRef: jest.fn().mockResolvedValue(null),
        ...overrides,
    } as any;
}

function makeLedgerService(overrides: Record<string, unknown> = {}) {
    return {
        record: jest.fn().mockImplementation(async (options: any) => ({
            id: 'entry-1',
            ...options,
            balanceAfter: options.amountCredits,
        })),
        getBalance: jest.fn().mockResolvedValue(0),
        ...overrides,
    } as any;
}

function makeUserRepository(overrides: Record<string, unknown> = {}) {
    return {
        findById: jest.fn().mockResolvedValue({ id: 'u1', email: 'buyer@example.test' }),
        ...overrides,
    } as any;
}

function build(parts: Partial<Record<string, any>> = {}) {
    const provider = parts.provider ?? makeProvider();
    const profiles = parts.profiles ?? makeProfileRepository();
    const invoices = parts.invoices ?? makeInvoiceRepository();
    const ledgerRepo = parts.ledgerRepo ?? makeLedgerRepository();
    const ledgerService = parts.ledgerService ?? makeLedgerService();
    const users = parts.users ?? makeUserRepository();
    // Paid-plan lifecycle collaborator (audit B24) — OPTIONAL, so the
    // credit-path specs keep the original 6-argument construction.
    const plans = parts.plans;
    const service = new BillingService(
        provider,
        profiles,
        invoices,
        ledgerRepo,
        ledgerService,
        users,
        plans,
    );
    return { service, provider, profiles, invoices, ledgerRepo, ledgerService, users, plans };
}

const CHECKOUT = {
    userId: 'u1',
    successUrl: 'https://app.test/settings/billing?topup=success',
    cancelUrl: 'https://app.test/settings/billing?topup=cancelled',
};

function event(overrides: Partial<BillingWebhookEvent>): BillingWebhookEvent {
    return {
        id: 'evt_1',
        kind: 'ignored',
        customerId: null,
        referenceId: null,
        packId: null,
        amountCents: null,
        currency: null,
        paymentId: null,
        providerType: 'test.event',
        ...overrides,
    } as BillingWebhookEvent;
}

const PROFILE = {
    userId: 'u1',
    provider: 'stripe',
    providerCustomerId: 'cus_1',
    organizationId: null,
    tenantId: null,
    defaultPaymentMethodRef: 'pm_1',
    autoRechargeEnabled: false,
    autoRechargeThresholdCredits: null,
    autoRechargePackId: null,
    autoRechargeFailureCount: 0,
};

describe('BillingService — checkout', () => {
    it('prices the checkout from the SERVER pack table', async () => {
        const { service, provider } = build();

        const result = await service.startCreditCheckout({ ...CHECKOUT, packId: 'credits-5500' });

        expect(result).toEqual(
            expect.objectContaining({
                url: 'https://pay.example/session/cs_1',
                packId: 'credits-5500',
                priceCents: 5000,
                credits: 5500,
            }),
        );
        const passed = provider.createCreditCheckoutSession.mock.calls[0][0];
        expect(passed.pack).toEqual(
            expect.objectContaining({ id: 'credits-5500', priceCents: 5000, credits: 5500 }),
        );
    });

    it('rejects a client-supplied amount: only a pack id can select a price', async () => {
        const { service, provider } = build();

        // A caller that smuggles price fields past the DTO still cannot
        // move the price — the service reads nothing but `packId`.
        await service.startCreditCheckout({
            ...CHECKOUT,
            packId: 'credits-1000',
            // @ts-expect-error — deliberately passing fields the type forbids
            amountCents: 1,
            priceCents: 1,
            credits: 999999,
        });

        const passed = provider.createCreditCheckoutSession.mock.calls[0][0];
        expect(passed.pack.priceCents).toBe(1000);
        expect(passed.pack.credits).toBe(1000);
        expect(passed).not.toHaveProperty('amountCents');
    });

    it('rejects an unknown pack id with a stable-named error', async () => {
        const { service, provider } = build();

        await expect(
            service.startCreditCheckout({ ...CHECKOUT, packId: 'credits-free-please' }),
        ).rejects.toBeInstanceOf(UnknownCreditPackError);
        expect(provider.createCreditCheckoutSession).not.toHaveBeenCalled();
    });

    it('fails closed when the provider is not configured', async () => {
        const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
        const { service } = build({ provider });

        await expect(
            service.startCreditCheckout({ ...CHECKOUT, packId: 'credits-1000' }),
        ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
        expect(provider.createCreditCheckoutSession).not.toHaveBeenCalled();
    });

    it('reuses an existing provider customer instead of minting a second one', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const { service, provider } = build({ profiles });

        await service.startCreditCheckout({ ...CHECKOUT, packId: 'credits-1000' });

        expect(provider.ensureCustomer).toHaveBeenCalledWith(
            expect.objectContaining({ existingCustomerId: 'cus_1' }),
        );
    });
});

describe('BillingService — webhook: purchases', () => {
    it('credits the ledger with the provider EVENT id as the idempotency key', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    id: 'evt_abc',
                    kind: 'credits.purchased',
                    customerId: 'cus_1',
                    packId: 'credits-5500',
                    amountCents: 5000,
                    paymentId: 'pi_1',
                }),
            ),
        });
        const { service, ledgerService } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{"raw":true}', 'sig');

        expect(outcome.action).toBe('credited');
        expect(ledgerService.record).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                kind: CreditLedgerKind.PURCHASE,
                amountCredits: 5500,
                idempotencyKey: 'stripe:evt:evt_abc',
                refType: BILLING_PAYMENT_REF_TYPE,
                refId: 'pi_1',
            }),
        );
    });

    it('is idempotent: a replayed event id moves the balance zero times', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    id: 'evt_abc',
                    kind: 'credits.purchased',
                    customerId: 'cus_1',
                    packId: 'credits-1000',
                    amountCents: 1000,
                    paymentId: 'pi_1',
                }),
            ),
        });
        // The row already exists from the first delivery.
        const ledgerRepo = makeLedgerRepository({
            findByIdempotencyKey: jest
                .fn()
                .mockResolvedValue({ id: 'entry-1', amountCredits: 1000 }),
        });
        const { service } = build({ provider, profiles, ledgerRepo });

        const outcome = await service.handleWebhook('{"raw":true}', 'sig');

        expect(outcome.action).toBe('credited-idempotent');
        expect(outcome.creditsDelta).toBe(0);
    });

    it('grants the pack credits, not the charged amount', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'credits.purchased',
                    customerId: 'cus_1',
                    packId: 'credits-25000',
                    amountCents: 20000,
                    paymentId: 'pi_2',
                }),
            ),
        });
        const { service, ledgerService } = build({ provider, profiles });

        await service.handleWebhook('{}', 'sig');

        const write = ledgerService.record.mock.calls[0][0];
        // $200 charged → 25,000 credits (volume bonus), not 20,000.
        expect(write.amountCredits).toBe(25000);
        expect(write.costCentsRef).toBe(20000);
    });

    it('ignores a purchase carrying a pack id that is not in the table', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'credits.purchased',
                    customerId: 'cus_1',
                    packId: 'credits-hack',
                }),
            ),
        });
        const { service, ledgerService } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('ignored');
        expect(ledgerService.record).not.toHaveBeenCalled();
    });

    it('acknowledges (never throws on) an event it cannot attribute to an owner', async () => {
        const profiles = makeProfileRepository(null, {
            findByCustomerId: jest.fn().mockResolvedValue(null),
            findByUserId: jest.fn().mockResolvedValue(null),
        });
        const provider = makeProvider({
            verifyAndParseWebhook: jest
                .fn()
                .mockResolvedValue(event({ kind: 'credits.purchased', customerId: 'cus_unknown' })),
        });
        const { service, ledgerService } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('unattributed');
        expect(ledgerService.record).not.toHaveBeenCalled();
    });

    it('settles the auto-recharge in-flight guard when a purchase lands', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'credits.purchased',
                    customerId: 'cus_1',
                    packId: 'credits-1000',
                    amountCents: 1000,
                    paymentId: 'pi_3',
                }),
            ),
        });
        const { service } = build({ provider, profiles });

        await service.handleWebhook('{}', 'sig');

        expect(profiles.releaseAutoRechargeSlot).toHaveBeenCalledWith('u1');
        expect(profiles.resetAutoRechargeFailures).toHaveBeenCalledWith('u1');
    });

    it('propagates a verification failure — an unverified delivery never credits', async () => {
        const provider = makeProvider({
            verifyAndParseWebhook: jest
                .fn()
                .mockRejectedValue(new BillingProviderNotConfiguredError()),
        });
        const { service, ledgerService } = build({ provider });

        await expect(service.handleWebhook('{}', undefined)).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        expect(ledgerService.record).not.toHaveBeenCalled();
    });
});

describe('BillingService — webhook: refunds', () => {
    it('reverses the full grant on a full refund', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const ledgerRepo = makeLedgerRepository({
            findLatestByRef: jest
                .fn()
                .mockResolvedValue({ amountCredits: 5500, costCentsRef: 5000 }),
        });
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    id: 'evt_ref',
                    kind: 'credits.refunded',
                    customerId: 'cus_1',
                    amountCents: 5000,
                    paymentId: 'pi_1',
                }),
            ),
        });
        const { service, ledgerService } = build({ provider, profiles, ledgerRepo });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('reversed');
        expect(ledgerService.record).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: CreditLedgerKind.ADJUSTMENT,
                amountCredits: -5500,
                idempotencyKey: 'stripe:evt:evt_ref',
                allowNegativeBalance: true,
            }),
        );
    });

    it('reverses proportionally on a partial refund', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const ledgerRepo = makeLedgerRepository({
            findLatestByRef: jest
                .fn()
                .mockResolvedValue({ amountCredits: 5500, costCentsRef: 5000 }),
        });
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'credits.refunded',
                    customerId: 'cus_1',
                    amountCents: 2500, // half
                    paymentId: 'pi_1',
                }),
            ),
        });
        const { service, ledgerService } = build({ provider, profiles, ledgerRepo });

        await service.handleWebhook('{}', 'sig');

        expect(ledgerService.record.mock.calls[0][0].amountCredits).toBe(-2750);
    });

    it('never reverses more than was granted, even if the event over-reports', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const ledgerRepo = makeLedgerRepository({
            findLatestByRef: jest
                .fn()
                .mockResolvedValue({ amountCredits: 1000, costCentsRef: 1000 }),
        });
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'credits.refunded',
                    customerId: 'cus_1',
                    amountCents: 999999,
                    paymentId: 'pi_1',
                }),
            ),
        });
        const { service, ledgerService } = build({ provider, profiles, ledgerRepo });

        await service.handleWebhook('{}', 'sig');

        expect(ledgerService.record.mock.calls[0][0].amountCredits).toBe(-1000);
    });

    it('is idempotent on replay of the same refund event', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const ledgerRepo = makeLedgerRepository({
            findLatestByRef: jest
                .fn()
                .mockResolvedValue({ amountCredits: 1000, costCentsRef: 1000 }),
            findByIdempotencyKey: jest.fn().mockResolvedValue({ id: 'entry-9' }),
        });
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'credits.refunded',
                    customerId: 'cus_1',
                    amountCents: 1000,
                    paymentId: 'pi_1',
                }),
            ),
        });
        const { service } = build({ provider, profiles, ledgerRepo });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('reversed-idempotent');
        expect(outcome.creditsDelta).toBe(0);
    });

    it('ignores a refund with no matching purchase rather than guessing', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'credits.refunded',
                    customerId: 'cus_1',
                    amountCents: 1000,
                    paymentId: 'pi_unknown',
                }),
            ),
        });
        const { service, ledgerService } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('ignored');
        expect(ledgerService.record).not.toHaveBeenCalled();
    });
});

describe('BillingService — webhook: invoices + payment methods', () => {
    it('mirrors an invoice from the verified event', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'invoice.updated',
                    customerId: 'cus_1',
                    invoice: {
                        providerInvoiceId: 'in_1',
                        number: 'EW-0001',
                        status: 'paid',
                        periodStart: new Date('2026-07-01T00:00:00Z'),
                        periodEnd: new Date('2026-08-01T00:00:00Z'),
                        subtotalCents: 5000,
                        totalCents: 5000,
                        amountPaidCents: 5000,
                        currency: 'usd',
                        hostedUrl: 'https://pay.example/invoice/in_1',
                        pdfUrl: null,
                        lines: [{ description: '5,500 credits', quantity: 1, amountCents: 5000 }],
                        issuedAt: new Date('2026-07-01T00:00:00Z'),
                    },
                }),
            ),
        });
        const { service, invoices } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('invoice-mirrored');
        expect(invoices.mirror).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                providerInvoiceId: 'in_1',
                totalCents: 5000,
                status: 'paid',
            }),
        );
    });

    it('stores only the payment-method SUMMARY — no PAN can reach the DB', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'payment_method.updated',
                    customerId: 'cus_1',
                    paymentMethod: {
                        ref: 'pm_9',
                        brand: 'visa',
                        last4: '4242',
                        expMonth: 12,
                        expYear: 2030,
                    },
                }),
            ),
        });
        const { service } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('payment-method-updated');
        const written = profiles.updatePaymentMethod.mock.calls[0][1];
        expect(Object.keys(written).sort()).toEqual(
            [
                'defaultPaymentMethodRef',
                'paymentMethodBrand',
                'paymentMethodExpMonth',
                'paymentMethodExpYear',
                'paymentMethodLast4',
            ].sort(),
        );
        expect(written.paymentMethodLast4).toBe('4242');
    });

    it('acknowledges an unhandled event type without touching the ledger', async () => {
        const provider = makeProvider({
            verifyAndParseWebhook: jest
                .fn()
                .mockResolvedValue(event({ kind: 'ignored', providerType: 'ping' })),
        });
        const { service, ledgerService, invoices } = build({ provider });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('ignored');
        expect(ledgerService.record).not.toHaveBeenCalled();
        expect(invoices.mirror).not.toHaveBeenCalled();
    });
});

describe('BillingService — overview, invoices and auto-recharge settings', () => {
    it('reports the provider-not-configured state so the UI can degrade', async () => {
        const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
        const { service } = build({ provider });

        const overview = await service.getOverview('u1');

        expect(overview.providerConfigured).toBe(false);
        expect(overview.packs).toHaveLength(3);
        expect(overview.paymentMethod).toBeNull();
        expect(overview.autoRecharge.enabled).toBe(false);
    });

    it('never returns the payment-method token reference in the overview', async () => {
        const profiles = makeProfileRepository({
            ...PROFILE,
            paymentMethodBrand: 'visa',
            paymentMethodLast4: '4242',
            paymentMethodExpMonth: 4,
            paymentMethodExpYear: 2031,
        });
        const { service } = build({ profiles });

        const overview = await service.getOverview('u1');

        expect(overview.paymentMethod).toEqual({
            brand: 'visa',
            last4: '4242',
            expMonth: 4,
            expYear: 2031,
        });
        expect(JSON.stringify(overview)).not.toContain('pm_1');
    });

    it('lists invoices scoped to the calling owner only', async () => {
        const invoices = makeInvoiceRepository({
            findForUser: jest.fn().mockResolvedValue({ invoices: [{ id: 'inv-1' }], total: 1 }),
        });
        const { service } = build({ invoices });

        const page = await service.listInvoices('u1', 2, 5);

        expect(invoices.findForUser).toHaveBeenCalledWith('u1', { skip: 5, take: 5 });
        expect(page).toEqual(expect.objectContaining({ total: 1, page: 2, pageSize: 5 }));
    });

    it('clamps invoice paging to a sane window', async () => {
        const invoices = makeInvoiceRepository();
        const { service } = build({ invoices });

        await service.listInvoices('u1', -3, 5000);

        expect(invoices.findForUser).toHaveBeenCalledWith('u1', { skip: 0, take: 50 });
    });

    it('refuses to enable auto-recharge without a stored payment method', async () => {
        const profiles = makeProfileRepository({ ...PROFILE, defaultPaymentMethodRef: null });
        const { service } = build({ profiles });

        await expect(
            service.updateAutoRecharge('u1', { enabled: true, thresholdCredits: 500 }),
        ).rejects.toMatchObject({ name: 'BillingProviderError' });
        expect(profiles.updateAutoRecharge).not.toHaveBeenCalled();
    });

    it('refuses an auto-recharge pack id that is not published', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const { service } = build({ profiles });

        await expect(
            service.updateAutoRecharge('u1', {
                enabled: true,
                thresholdCredits: 500,
                packId: 'credits-hack',
            }),
        ).rejects.toBeInstanceOf(UnknownCreditPackError);
    });

    it('persists valid auto-recharge settings', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const { service } = build({ profiles });

        await service.updateAutoRecharge('u1', {
            enabled: true,
            thresholdCredits: 500,
            packId: 'credits-5500',
        });

        expect(profiles.updateAutoRecharge).toHaveBeenCalledWith('u1', {
            autoRechargeEnabled: true,
            autoRechargeThresholdCredits: 500,
            autoRechargePackId: 'credits-5500',
        });
    });
});

describe('handleWebhook — paid-plan lifecycle is delegated, not duplicated (audit B24)', () => {
    function planEvent(kind: 'subscription.activated' | 'subscription.canceled') {
        return event({
            id: 'evt_plan_1',
            kind,
            customerId: 'cus_1',
            planCode: 'standard',
            subscriptionId: 'sub_1',
            providerType: 'checkout.session.completed',
        });
    }

    it('hands a subscription event to the plan service and echoes its action', async () => {
        const plans = { applyWebhook: jest.fn().mockResolvedValue('subscription-activated') };
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(planEvent('subscription.activated')),
        });
        const { service, ledgerService } = build({ provider, plans });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(plans.applyWebhook).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'subscription.activated', planCode: 'standard' }),
        );
        expect(outcome.action).toBe('subscription-activated');
        // A plan sale must never touch the credits ledger.
        expect(ledgerService.record).not.toHaveBeenCalled();
    });

    it('echoes a revocation action', async () => {
        const plans = { applyWebhook: jest.fn().mockResolvedValue('subscription-canceled') };
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(planEvent('subscription.canceled')),
        });
        const { service } = build({ provider, plans });

        expect((await service.handleWebhook('{}', 'sig')).action).toBe('subscription-canceled');
    });

    it('acknowledges (never 500s) when plan handling is not wired', async () => {
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(planEvent('subscription.activated')),
        });
        const { service } = build({ provider });

        // A 5xx here would make the provider retry a delivery we can
        // never resolve.
        expect((await service.handleWebhook('{}', 'sig')).action).toBe('ignored');
    });
});
