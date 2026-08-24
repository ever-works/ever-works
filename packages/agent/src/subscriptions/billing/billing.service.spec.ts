import {
    BillingService,
    NoActiveSubscriptionError,
    UnknownCreditPackError,
    BILLING_PAYMENT_REF_TYPE,
} from './billing.service';
import {
    BillingProviderNotConfiguredError,
    type BillingSubscriptionSnapshot,
    type BillingWebhookEvent,
} from './billing.provider';
import type { PaygService } from './payg.service';
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
        // Subscription lifecycle (audit B07/B08).
        cancelSubscriptionAtPeriodEnd: jest.fn().mockResolvedValue({
            subscriptionId: 'sub_1',
            status: 'active',
            cancelAtPeriodEnd: true,
            currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
            canceledAt: null,
        }),
        resumeSubscription: jest.fn().mockResolvedValue({
            subscriptionId: 'sub_1',
            status: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
            canceledAt: null,
        }),
        createBillingPortalSession: jest
            .fn()
            .mockResolvedValue({ url: 'https://pay.example/portal/bps_1' }),
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
        // Last-write-wins projection of the provider's lifecycle state.
        updateSubscriptionState: jest
            .fn()
            .mockImplementation(async (_userId: string, state: any) => ({
                ...(profile ?? {}),
                ...state,
                subscriptionCanceledAt: state.subscriptionCanceledAt ?? null,
            })),
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
    // Pay-as-you-go collaborator (billing spec §3.5) — OPTIONAL, appended last.
    const payg = parts.payg;
    const service = new BillingService(
        provider,
        profiles,
        invoices,
        ledgerRepo,
        ledgerService,
        users,
        plans,
        payg,
    );
    return { service, provider, profiles, invoices, ledgerRepo, ledgerService, users, plans, payg };
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

    it('clears the stored summary when the DEFAULT card is detached out-of-band', async () => {
        const profiles = makeProfileRepository({ ...PROFILE, autoRechargeEnabled: true });
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'payment_method.removed',
                    customerId: 'cus_1',
                    paymentMethod: {
                        ref: 'pm_1',
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

        expect(outcome.action).toBe('payment-method-removed');
        expect(profiles.updatePaymentMethod).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ defaultPaymentMethodRef: null }),
        );
        // Auto-recharge cannot run without a stored method — leaving the
        // toggle on would be a lie in the UI and a guaranteed failure.
        expect(profiles.updateAutoRecharge).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ autoRechargeEnabled: false }),
        );
    });

    it('leaves the default alone when a NON-default card is detached', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'payment_method.removed',
                    customerId: 'cus_1',
                    paymentMethod: {
                        ref: 'pm_other',
                        brand: 'visa',
                        last4: '1881',
                        expMonth: 12,
                        expYear: 2030,
                    },
                }),
            ),
        });
        const { service } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('payment-method-removed-noop');
        expect(profiles.updatePaymentMethod).not.toHaveBeenCalled();
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

/**
 * Subscription lifecycle (audit B07/B08).
 *
 * B07 — the page could start a subscription but not manage one: no
 * cancel path and no `cancelAtPeriodEnd` state. B08 — the status chip
 * was hardcoded to "active" and nothing surfaced a failed collection.
 *
 * What these pin: cancel goes through the SEAM and persists the flag;
 * resume clears it; a past-due webhook flips the persisted status; and
 * every lifecycle call is owner-scoped so a caller can never reach
 * another account's (or another org's) subscription.
 */

/** An owner on a paid plan, org-scoped, with a live provider subscription. */
const SUBSCRIBED_PROFILE = {
    ...PROFILE,
    organizationId: 'org-a',
    providerSubscriptionId: 'sub_1',
    subscriptionStatus: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
    subscriptionCanceledAt: null,
};

describe('BillingService — subscription cancel / resume (B07)', () => {
    it('cancels AT PERIOD END through the provider seam and persists the flag', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const { service, provider } = build({ profiles });

        const state = await service.cancelSubscription('u1');

        expect(provider.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith({
            subscriptionId: 'sub_1',
        });
        // The persisted row is what the UI reads back.
        expect(profiles.updateSubscriptionState).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                providerSubscriptionId: 'sub_1',
                subscriptionStatus: 'active',
                cancelAtPeriodEnd: true,
                currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
            }),
        );
        expect(state.cancelAtPeriodEnd).toBe(true);
        expect(state.status).toBe('active');
        expect(state.manageable).toBe(true);
    });

    it('keeps the paid period the owner already bought', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const { service } = build({ profiles });

        const state = await service.cancelSubscription('u1');

        // At-period-end, not immediate: the plan is still `active` and
        // the period end is preserved so the UI can say when it stops.
        expect(state.status).toBe('active');
        expect(state.currentPeriodEnd).toEqual(new Date('2026-08-01T00:00:00Z'));
        expect(state.canceledAt).toBeNull();
    });

    it('resume clears the pending cancellation', async () => {
        const profiles = makeProfileRepository({
            ...SUBSCRIBED_PROFILE,
            cancelAtPeriodEnd: true,
        });
        const { service, provider } = build({ profiles });

        const state = await service.resumeSubscription('u1');

        expect(provider.resumeSubscription).toHaveBeenCalledWith({ subscriptionId: 'sub_1' });
        expect(state.cancelAtPeriodEnd).toBe(false);
        expect(profiles.updateSubscriptionState).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ cancelAtPeriodEnd: false }),
        );
    });

    it('refuses to resume a subscription that has already ended', async () => {
        const profiles = makeProfileRepository({
            ...SUBSCRIBED_PROFILE,
            subscriptionStatus: 'canceled',
            cancelAtPeriodEnd: false,
        });
        const { service, provider } = build({ profiles });

        await expect(service.resumeSubscription('u1')).rejects.toBeInstanceOf(
            NoActiveSubscriptionError,
        );
        expect(provider.resumeSubscription).not.toHaveBeenCalled();
    });

    it('refuses cancel when the owner has no provider subscription', async () => {
        // A free-tier profile: customer mapping only, no subscription id.
        const profiles = makeProfileRepository(PROFILE);
        const { service, provider } = build({ profiles });

        await expect(service.cancelSubscription('u1')).rejects.toBeInstanceOf(
            NoActiveSubscriptionError,
        );
        expect(provider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
        expect(profiles.updateSubscriptionState).not.toHaveBeenCalled();
    });

    it('fails closed when the payment provider is not configured', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const provider = makeProvider({ isConfigured: jest.fn().mockReturnValue(false) });
        const { service } = build({ provider, profiles });

        await expect(service.cancelSubscription('u1')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
        expect(provider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    });
});

describe('BillingService — subscription lifecycle is owner/org scoped', () => {
    it('resolves the subscription from the CALLER, never a supplied id', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const { service } = build({ profiles });

        await service.cancelSubscription('u1');

        // The only input that reaches the lookup is the caller's user id.
        expect(profiles.findByUserId).toHaveBeenCalledWith('u1');
    });

    it('refuses a caller from another org: they simply have no subscription', async () => {
        // User `u2` (org-b) has no billing profile at all; `u1` (org-a)
        // owns the only subscription in the system.
        const profiles = makeProfileRepository(null, {
            findByUserId: jest.fn().mockResolvedValue(null),
        });
        const { service, provider } = build({ profiles });

        await expect(service.cancelSubscription('u2')).rejects.toBeInstanceOf(
            NoActiveSubscriptionError,
        );
        // Nothing was cancelled anywhere — u1's subscription is untouched.
        expect(provider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
        expect(profiles.updateSubscriptionState).not.toHaveBeenCalled();
    });

    it('refuses to mutate a row belonging to a different owner/org', async () => {
        // Defence in depth: even if the lookup ever handed back another
        // org's row, the ownership re-check stops the mutation.
        const profiles = makeProfileRepository(null, {
            findByUserId: jest.fn().mockResolvedValue(SUBSCRIBED_PROFILE),
        });
        const { service, provider } = build({ profiles });

        await expect(service.cancelSubscription('u2')).rejects.toBeInstanceOf(
            NoActiveSubscriptionError,
        );
        expect(provider.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
    });

    it('refuses a portal session for a foreign billing account', async () => {
        const profiles = makeProfileRepository(null, {
            findByUserId: jest.fn().mockResolvedValue(SUBSCRIBED_PROFILE),
        });
        const { service, provider } = build({ profiles });

        await expect(
            service.createBillingPortalSession('u2', 'https://app.test/settings/billing'),
        ).rejects.toBeInstanceOf(NoActiveSubscriptionError);
        expect(provider.createBillingPortalSession).not.toHaveBeenCalled();
    });

    it('opens the portal for the caller’s own customer (the past-due recovery action)', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const { service, provider } = build({ profiles });

        const session = await service.createBillingPortalSession(
            'u1',
            'https://app.test/settings/billing',
        );

        expect(provider.createBillingPortalSession).toHaveBeenCalledWith({
            customerId: 'cus_1',
            returnUrl: 'https://app.test/settings/billing',
        });
        expect(session.url).toBe('https://pay.example/portal/bps_1');
    });
});

describe('BillingService — subscription webhook reconciliation (B08)', () => {
    function subscriptionEvent(snapshot: Partial<BillingSubscriptionSnapshot> = {}) {
        return event({
            id: 'evt_sub',
            kind: 'subscription.updated',
            customerId: 'cus_1',
            providerType: 'customer.subscription.updated',
            subscription: {
                subscriptionId: 'sub_1',
                status: 'active',
                cancelAtPeriodEnd: false,
                currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
                canceledAt: null,
                ...snapshot,
            },
        });
    }

    it('a past-due delivery flips the persisted status', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest
                .fn()
                .mockResolvedValue(subscriptionEvent({ status: 'past_due' })),
        });
        const { service } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('subscription-reconciled');
        expect(profiles.updateSubscriptionState).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({ subscriptionStatus: 'past_due' }),
        );
    });

    it('the overview then reports pastDue so the banner renders', async () => {
        const profiles = makeProfileRepository({
            ...SUBSCRIBED_PROFILE,
            subscriptionStatus: 'past_due',
        });
        const { service } = build({ profiles });

        const overview = await service.getOverview('u1');

        expect(overview.subscription.status).toBe('past_due');
        expect(overview.subscription.pastDue).toBe(true);
        expect(overview.subscription.manageable).toBe(true);
    });

    it('reconciles an out-of-band cancellation made in the provider’s portal', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                subscriptionEvent({
                    status: 'canceled',
                    cancelAtPeriodEnd: false,
                    canceledAt: new Date('2026-07-20T00:00:00Z'),
                }),
            ),
        });
        const { service } = build({ provider, profiles });

        await service.handleWebhook('{}', 'sig');

        expect(profiles.updateSubscriptionState).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                subscriptionStatus: 'canceled',
                subscriptionCanceledAt: new Date('2026-07-20T00:00:00Z'),
            }),
        );
    });

    it('is replay-safe: a re-delivered event writes the same state', async () => {
        const profiles = makeProfileRepository(SUBSCRIBED_PROFILE);
        const provider = makeProvider({
            verifyAndParseWebhook: jest
                .fn()
                .mockResolvedValue(subscriptionEvent({ cancelAtPeriodEnd: true })),
        });
        const { service } = build({ provider, profiles });

        await service.handleWebhook('{}', 'sig');
        await service.handleWebhook('{}', 'sig');

        const writes = profiles.updateSubscriptionState.mock.calls.map(
            (call: unknown[]) => call[1],
        );
        expect(writes[0]).toEqual(writes[1]);
    });

    it('acknowledges a subscription event it cannot attribute', async () => {
        const profiles = makeProfileRepository(null, {
            findByCustomerId: jest.fn().mockResolvedValue(null),
            findByUserId: jest.fn().mockResolvedValue(null),
        });
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(subscriptionEvent({})),
        });
        const { service } = build({ provider, profiles });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('unattributed');
        expect(profiles.updateSubscriptionState).not.toHaveBeenCalled();
    });

    it('an account with no provider subscription reads as `none`, not `active`', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const { service } = build({ profiles });

        const overview = await service.getOverview('u1');

        expect(overview.subscription.status).toBe('none');
        expect(overview.subscription.manageable).toBe(false);
        expect(overview.subscription.pastDue).toBe(false);
    });
});

describe('BillingService — pay-as-you-go wiring (billing spec §3.5)', () => {
    type PaygDouble = jest.Mocked<Pick<PaygService, 'getState' | 'applyWebhook' | 'applyInvoice'>>;

    function makePayg(overrides: Partial<PaygDouble> = {}): PaygDouble {
        return {
            getState: jest.fn().mockResolvedValue({
                available: true,
                enabled: true,
                subscriptionStatus: 'active',
                pastDue: false,
                monthlyCapCredits: 10000,
                defaultMonthlyCapCredits: 10000,
                maxMonthlyCapCredits: 100000,
                minMonthlyCapCredits: 500,
                cycleUsedCredits: 380,
                cycleEstimateCents: 380,
                periodStart: null,
                periodEnd: null,
                tiers: [],
                invoiceThresholdCents: 5000,
            }),
            applyWebhook: jest.fn().mockResolvedValue('payg-reconciled'),
            applyInvoice: jest.fn().mockResolvedValue(undefined),
            ...overrides,
        } as PaygDouble;
    }

    it('overview carries the pay-as-you-go state, and null when the collaborator is absent or failing', async () => {
        const wired = build({ payg: makePayg() });
        const overview = await wired.service.getOverview('u1');
        expect(overview.payg).toEqual(
            expect.objectContaining({ enabled: true, cycleUsedCredits: 380 }),
        );

        const absent = build();
        expect((await absent.service.getOverview('u1')).payg).toBeNull();

        const failing = build({
            payg: makePayg({ getState: jest.fn().mockRejectedValue(new Error('boom')) }),
        });
        expect((await failing.service.getOverview('u1')).payg).toBeNull();
    });

    it('routes payg.updated to PaygService and never to the plan-tier collaborator', async () => {
        const plans = { applyWebhook: jest.fn() } as any;
        const payg = makePayg();
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'payg.updated',
                    customerId: 'cus_1',
                    subscriptionId: 'sub_payg',
                }),
            ),
        });
        const { service } = build({ provider, plans, payg });

        const outcome = await service.handleWebhook('{}', 'sig');

        expect(outcome.action).toBe('payg-reconciled');
        expect(payg.applyWebhook).toHaveBeenCalledTimes(1);
        expect(plans.applyWebhook).not.toHaveBeenCalled();
    });

    it('acknowledges payg.updated as ignored when PAYG is not wired (never a 500 → provider retry storm)', async () => {
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'payg.updated',
                    customerId: 'cus_1',
                    subscriptionId: 'sub_payg',
                }),
            ),
        });
        const { service } = build({ provider });
        await expect(service.handleWebhook('{}', 'sig')).resolves.toMatchObject({
            action: 'ignored',
        });
    });

    it('a mirrored pay-as-you-go invoice also reaches PaygService.applyInvoice; a plan invoice does not', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const payg = makePayg();
        const invoiceSnapshot = (kind: 'payg' | 'plan') => ({
            providerInvoiceId: `in_${kind}`,
            number: 'EW-0002',
            status: 'open' as const,
            periodStart: null,
            periodEnd: null,
            subtotalCents: 380,
            totalCents: 380,
            amountPaidCents: 0,
            currency: 'usd',
            hostedUrl: null,
            pdfUrl: null,
            lines: [],
            issuedAt: null,
            subscriptionId: `sub_${kind}`,
            subscriptionKind: kind,
            paymentFailed: true,
        });

        const paygProvider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'invoice.updated',
                    customerId: 'cus_1',
                    invoice: invoiceSnapshot('payg'),
                }),
            ),
        });
        const a = build({ provider: paygProvider, profiles, payg });
        await expect(a.service.handleWebhook('{}', 'sig')).resolves.toMatchObject({
            action: 'invoice-mirrored',
        });
        expect(payg.applyInvoice).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1' }),
            expect.objectContaining({ subscriptionKind: 'payg', paymentFailed: true }),
        );

        payg.applyInvoice.mockClear();
        const planProvider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'invoice.updated',
                    customerId: 'cus_1',
                    invoice: invoiceSnapshot('plan'),
                }),
            ),
        });
        const b = build({ provider: planProvider, profiles, payg });
        await b.service.handleWebhook('{}', 'sig');
        expect(payg.applyInvoice).not.toHaveBeenCalled();
    });

    it('does not regress PAYG to past_due when a stale payment_failed event follows paid', async () => {
        const profiles = makeProfileRepository(PROFILE);
        const payg = makePayg();
        const invoices = makeInvoiceRepository({
            mirror: jest.fn().mockResolvedValue({ id: 'inv-1', status: 'paid' }),
        });
        const provider = makeProvider({
            verifyAndParseWebhook: jest.fn().mockResolvedValue(
                event({
                    kind: 'invoice.updated',
                    customerId: 'cus_1',
                    invoice: {
                        providerInvoiceId: 'in_payg',
                        number: 'EW-0002',
                        status: 'open',
                        periodStart: null,
                        periodEnd: null,
                        subtotalCents: 380,
                        totalCents: 380,
                        amountPaidCents: 0,
                        currency: 'usd',
                        hostedUrl: null,
                        pdfUrl: null,
                        lines: [],
                        issuedAt: null,
                        subscriptionId: 'sub_payg',
                        subscriptionKind: 'payg',
                        paymentFailed: true,
                    },
                }),
            ),
        });

        await build({ provider, profiles, invoices, payg }).service.handleWebhook('{}', 'sig');

        expect(payg.applyInvoice).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'paid', paymentFailed: false }),
        );
    });
});
