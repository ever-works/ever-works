import {
    CheckoutSessionNotFoundError,
    PlanNotPurchasableError,
    PlanSubscriptionService,
    UnknownSubscriptionPlanError,
} from './plan-subscription.service';
import { BillingProviderNotConfiguredError, type BillingWebhookEvent } from './billing.provider';
import { SubscriptionStatus } from '@src/entities/user-subscription.entity';

/**
 * Paid-plan purchase (audit B24). No DB, no Nest container, no vendor
 * SDK — the `BillingProvider` seam is a jest.fn() shell.
 *
 * What these specs pin:
 *   - checkout is priced from the SERVER plan row, never by the caller;
 *   - a free plan is not purchasable (that path stays self-service);
 *   - the return route authorizes on the user id the PROVIDER holds in
 *     our session metadata — a session id in a URL is not an
 *     authorization, and someone else's session is a 404-shaped error;
 *   - only a billing-verified path reaches the privileged plan grant;
 *   - activation is idempotent, so a webhook replay (or a webhook racing
 *     the return route) grants the same tier once.
 */

// Mirrors what `SubscriptionService.seedPlans()` actually writes: code 'standard' is the tier the
// marketing site calls "Pro", at Ever Gauzy / Ever Teams cloud Small Business pricing.
const STANDARD_PLAN = {
    id: 'plan-standard',
    code: 'standard',
    displayName: 'Pro',
    hosting: 'cloud',
    monthlyPrice: '25',
    // The YEARLY charge, not the "$17/mo" the marketing site displays.
    annualPrice: '204',
    lifetimePrice: null,
    seatsIncluded: 10,
    seatMonthlyPrice: '5',
    monthlyCredits: 3000,
    currency: 'usd',
    active: true,
};

// The only row sold as a one-off perpetual commercial licence — and the only one whose "annual"
// slot and one-time slot both exist, which is precisely the pair the catalog has to keep apart.
const SELFHOSTED_PRO_PLAN = {
    id: 'plan-selfhosted-pro',
    code: 'selfhosted_pro',
    displayName: 'Pro Edition',
    hosting: 'selfhosted',
    monthlyPrice: '49',
    annualPrice: '408',
    lifetimePrice: '99',
    seatsIncluded: 10,
    seatMonthlyPrice: '5',
    monthlyCredits: 3000,
    currency: 'usd',
    active: true,
};

const FREE_PLAN = {
    id: 'plan-free',
    code: 'free',
    displayName: 'Free',
    monthlyPrice: '0',
    currency: 'usd',
    active: true,
};

function makeProvider(overrides: Record<string, unknown> = {}) {
    return {
        getProviderId: jest.fn().mockReturnValue('stripe'),
        getDefaultCurrency: jest.fn().mockReturnValue('usd'),
        isConfigured: jest.fn().mockReturnValue(true),
        ensureCustomer: jest.fn().mockResolvedValue('cus_1'),
        createPlanCheckoutSession: jest.fn().mockResolvedValue({
            url: 'https://pay.example/cs_plan_1',
            sessionId: 'cs_plan_1',
            customerId: 'cus_1',
        }),
        retrieveCheckoutSession: jest.fn(),
        ...overrides,
    } as any;
}

function makePlanRepository(overrides: Record<string, unknown> = {}) {
    return {
        findByCode: jest.fn().mockImplementation(async (code: string) => {
            if (code === 'standard') return STANDARD_PLAN;
            if (code === 'free') return FREE_PLAN;
            return null;
        }),
        ...overrides,
    } as any;
}

function makeSubscriptionRepository(overrides: Record<string, unknown> = {}) {
    return {
        createOrUpdate: jest.fn().mockResolvedValue({ id: 'sub-row-1' }),
        findByProviderSubscriptionId: jest.fn().mockResolvedValue(null),
        findActiveByUser: jest.fn().mockResolvedValue(null),
        cancel: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as any;
}

function makeProfileRepository(overrides: Record<string, unknown> = {}) {
    return {
        findByUserId: jest.fn().mockResolvedValue(null),
        findByCustomerId: jest.fn().mockResolvedValue(null),
        ensure: jest.fn().mockResolvedValue({ userId: 'u1', providerCustomerId: 'cus_1' }),
        ...overrides,
    } as any;
}

function makeUserRepository(overrides: Record<string, unknown> = {}) {
    return {
        findById: jest.fn().mockResolvedValue({ id: 'u1', email: 'buyer@example.test' }),
        ...overrides,
    } as any;
}

function makeSubscriptionService(overrides: Record<string, unknown> = {}) {
    return {
        isEnabled: jest.fn().mockReturnValue(true),
        assignPlanToUser: jest.fn().mockResolvedValue(STANDARD_PLAN),
        changePlanSelfService: jest.fn().mockResolvedValue(FREE_PLAN),
        ...overrides,
    } as any;
}

function build(
    overrides: {
        provider?: any;
        planRepository?: any;
        subscriptionRepository?: any;
        profileRepository?: any;
        userRepository?: any;
        subscriptionService?: any;
    } = {},
) {
    const provider = overrides.provider ?? makeProvider();
    const planRepository = overrides.planRepository ?? makePlanRepository();
    const subscriptionRepository = overrides.subscriptionRepository ?? makeSubscriptionRepository();
    const profileRepository = overrides.profileRepository ?? makeProfileRepository();
    const userRepository = overrides.userRepository ?? makeUserRepository();
    const subscriptionService = overrides.subscriptionService ?? makeSubscriptionService();
    const service = new PlanSubscriptionService(
        provider,
        planRepository,
        subscriptionRepository,
        profileRepository,
        userRepository,
        subscriptionService,
    );
    return {
        service,
        provider,
        planRepository,
        subscriptionRepository,
        profileRepository,
        userRepository,
        subscriptionService,
    };
}

const checkoutOptions = {
    userId: 'u1',
    planCode: 'standard',
    successUrl: 'https://app.test/settings/billing?plan=success',
    cancelUrl: 'https://app.test/settings/billing?plan=cancelled',
};

describe('startPlanCheckout — the server prices everything', () => {
    it('prices the checkout from the SERVER plan row', async () => {
        const { service, provider } = build();

        const started = await service.startPlanCheckout(checkoutOptions);

        expect(started).toEqual({
            url: 'https://pay.example/cs_plan_1',
            sessionId: 'cs_plan_1',
            planCode: 'standard',
            priceCents: 2500,
            currency: 'usd',
        });
        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        // $25.00 → 2500 cents. The row and the shared-account catalog agree; neither comes from the body.
        expect(request.plan).toEqual(
            expect.objectContaining({ code: 'standard', priceCents: 2500, interval: 'month' }),
        );
        // Server-authored correlation id, echoed back on the signed event.
        expect(request.referenceId).toBe('u1:standard');
    });

    it('names the shared-account catalog price so the invoice traces back to a reviewed commit', async () => {
        const { service, provider } = build();

        await service.startPlanCheckout(checkoutOptions);

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        // Plan code 'standard' is sold as the "Pro" tier; the fixture has no hosting, which the
        // resolver reads as cloud — the same default the migration gives every pre-existing row.
        expect(request.plan.lookupKey).toBe('ever_works_cloud_pro_monthly');
        // priceCents is still carried: the provider falls back to it when the account has no
        // catalog price, so removing it would break every unsynced deployment. Here the catalog
        // and the seeded row agree, which is the invariant stripe-catalog.spec.ts guards.
        expect(request.plan.priceCents).toBe(2500);
    });

    it('bills no seat line when the buyer stays inside the plan allowance', async () => {
        const { service, provider } = build();

        // Pro includes 10. Asking for 10 is not an upsell.
        await service.startPlanCheckout({ ...checkoutOptions, seats: 10 });

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        expect(request.plan.extraSeats).toBe(0);
        expect(request.plan.seatLookupKey).toBeNull();
    });

    it('bills only the seats beyond the allowance, on the matching seat price', async () => {
        const { service, provider } = build();

        await service.startPlanCheckout({ ...checkoutOptions, seats: 27 });

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        // 27 requested - 10 included = 17 billable, NOT 27.
        expect(request.plan.extraSeats).toBe(17);
        expect(request.plan.seatLookupKey).toBe('ever_works_cloud_pro_seat_monthly');
    });

    it('clamps a hostile seat count on the server rather than trusting it', async () => {
        // The clamp lives against the PLAN row, so a caller cannot under- or over-report its way
        // into a wrong bill. Negative and non-finite values must produce no seat charge at all.
        for (const seats of [-100, 0, Number.NaN]) {
            const { service, provider } = build();
            await service.startPlanCheckout({ ...checkoutOptions, seats });
            const request = provider.createPlanCheckoutSession.mock.calls[0][0];
            expect(request.plan.extraSeats).toBe(0);
            expect(request.plan.seatLookupKey).toBeNull();
        }
    });

    it('omits the seat count entirely when the caller does not ask for seats', async () => {
        const { service, provider } = build();

        await service.startPlanCheckout(checkoutOptions);

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        expect(request.plan.extraSeats).toBe(0);
    });

    it('defaults to the monthly period when the caller does not name one', async () => {
        const { service, provider } = build();

        await service.startPlanCheckout(checkoutOptions);

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        expect(request.plan.interval).toBe('month');
        expect(request.plan.lookupKey).toBe('ever_works_cloud_pro_monthly');
    });

    it('buys the annual SKU as a YEARLY subscription when asked for one', async () => {
        const { service, provider } = build();

        await service.startPlanCheckout({ ...checkoutOptions, interval: 'annual' });

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        expect(request.plan.interval).toBe('year');
        expect(request.plan.lookupKey).toBe('ever_works_cloud_pro_annual');
        // The seat line has to follow the plan's period — a monthly seat price cannot ride on a
        // yearly subscription, Stripe rejects mixed intervals in one subscription.
        expect(request.plan.seatLookupKey).toBeNull();
    });

    it('matches the seat period to the plan period on an annual purchase', async () => {
        const { service, provider } = build();

        await service.startPlanCheckout({ ...checkoutOptions, interval: 'annual', seats: 12 });

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        expect(request.plan.extraSeats).toBe(2);
        expect(request.plan.seatLookupKey).toBe('ever_works_cloud_pro_seat_annual');
    });

    it('sells a perpetual licence as a ONE-OFF payment, never a subscription', async () => {
        const { service, provider } = build({
            planRepository: makePlanRepository({
                findByCode: jest.fn().mockResolvedValue(SELFHOSTED_PRO_PLAN),
            }),
        });

        const started = await service.startPlanCheckout({
            ...checkoutOptions,
            planCode: 'selfhosted_pro',
            interval: 'lifetime',
        });

        const request = provider.createPlanCheckoutSession.mock.calls[0][0];
        expect(request.plan.mode).toBe('payment');
        expect(request.plan.lookupKey).toBe('ever_works_selfhosted_pro_lifetime');
        // $99 once. Fulfilment (issuing the licence document) is MANUAL for now.
        expect(request.plan.priceCents).toBe(9900);
        expect(started.priceCents).toBe(9900);
        // A one-off purchase cannot carry a recurring seat line.
        expect(request.plan.seatLookupKey).toBeNull();
    });

    it('never sells a recurring period as a one-off, or the reverse', async () => {
        const { service, provider } = build({
            planRepository: makePlanRepository({
                findByCode: jest.fn().mockResolvedValue(SELFHOSTED_PRO_PLAN),
            }),
        });

        // The self-hosted "annual" slot is a yearly SUBSCRIPTION on this tier even though the same
        // tier also sells a one-time licence — the exact confusion the catalog exists to prevent.
        await service.startPlanCheckout({
            ...checkoutOptions,
            planCode: 'selfhosted_pro',
            interval: 'annual',
        });
        const annual = provider.createPlanCheckoutSession.mock.calls[0][0];
        expect(annual.plan.mode).toBe('subscription');
        expect(annual.plan.interval).toBe('year');
        expect(annual.plan.priceCents).toBe(40800);
    });

    it('refuses a period the plan does not sell rather than downgrading to one it does', async () => {
        // Cloud Pro has no lifetime price. Selling the monthly one instead would take money for
        // the wrong thing entirely.
        const { service, provider } = build();

        await expect(
            service.startPlanCheckout({ ...checkoutOptions, interval: 'lifetime' }),
        ).rejects.toBeInstanceOf(PlanNotPurchasableError);
        expect(provider.createPlanCheckoutSession).not.toHaveBeenCalled();
    });

    it('lazily creates the provider customer + billing profile', async () => {
        const { service, provider, profileRepository } = build();

        await service.startPlanCheckout(checkoutOptions);

        expect(provider.ensureCustomer).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', existingCustomerId: null }),
        );
        expect(profileRepository.ensure).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u1', provider: 'stripe' }),
        );
    });

    it('refuses a free plan — that move stays on the self-service path', async () => {
        const { service, provider } = build();

        await expect(
            service.startPlanCheckout({ ...checkoutOptions, planCode: 'free' }),
        ).rejects.toBeInstanceOf(PlanNotPurchasableError);
        expect(provider.createPlanCheckoutSession).not.toHaveBeenCalled();
    });

    it('refuses an unknown or inactive plan', async () => {
        const { service } = build();
        await expect(
            service.startPlanCheckout({ ...checkoutOptions, planCode: 'enterprise' }),
        ).rejects.toBeInstanceOf(UnknownSubscriptionPlanError);

        const inactive = build({
            planRepository: makePlanRepository({
                findByCode: jest.fn().mockResolvedValue({ ...STANDARD_PLAN, active: false }),
            }),
        });
        await expect(inactive.service.startPlanCheckout(checkoutOptions)).rejects.toBeInstanceOf(
            UnknownSubscriptionPlanError,
        );
    });

    it('fails closed when the provider is not configured', async () => {
        const { service } = build({
            provider: makeProvider({ isConfigured: jest.fn().mockReturnValue(false) }),
        });

        await expect(service.startPlanCheckout(checkoutOptions)).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
    });

    it('fails closed when subscriptions are disabled on the deployment', async () => {
        const { service, provider } = build({
            subscriptionService: makeSubscriptionService({
                isEnabled: jest.fn().mockReturnValue(false),
            }),
        });

        await expect(service.startPlanCheckout(checkoutOptions)).rejects.toBeInstanceOf(
            PlanNotPurchasableError,
        );
        expect(provider.createPlanCheckoutSession).not.toHaveBeenCalled();
    });

    it('treats a malformed plan price as not sellable rather than charging it', async () => {
        const { service } = build({
            planRepository: makePlanRepository({
                findByCode: jest.fn().mockResolvedValue({ ...STANDARD_PLAN, monthlyPrice: 'abc' }),
            }),
        });

        await expect(service.startPlanCheckout(checkoutOptions)).rejects.toBeInstanceOf(
            PlanNotPurchasableError,
        );
    });
});

describe('syncCheckoutReturn — a session id is not an authorization', () => {
    function paidPlanSnapshot(overrides: Record<string, unknown> = {}) {
        return {
            sessionId: 'cs_plan_1',
            status: 'complete',
            paid: true,
            purpose: 'plan',
            userId: 'u1',
            planCode: 'standard',
            packId: null,
            customerId: 'cus_1',
            subscriptionId: 'sub_1',
            currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
            ...overrides,
        };
    }

    it('activates the plan for the owning user', async () => {
        const { service, provider, subscriptionRepository, subscriptionService } = build({
            provider: makeProvider({
                retrieveCheckoutSession: jest.fn().mockResolvedValue(paidPlanSnapshot()),
            }),
        });

        const result = await service.syncCheckoutReturn('u1', 'cs_plan_1');

        expect(result).toEqual({ status: 'active', activated: true, planCode: 'standard' });
        expect(provider.retrieveCheckoutSession).toHaveBeenCalledWith('cs_plan_1');
        expect(subscriptionRepository.createOrUpdate).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                planCode: 'standard',
                planId: 'plan-standard',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_1',
            }),
        );
        // The PRIVILEGED grant — the only path allowed to set a paid tier.
        expect(subscriptionService.assignPlanToUser).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'u1' }),
            'standard',
        );
    });

    it('REFUSES a session belonging to another account, without leaking existence', async () => {
        const { service, subscriptionRepository, subscriptionService } = build({
            provider: makeProvider({
                retrieveCheckoutSession: jest
                    .fn()
                    .mockResolvedValue(paidPlanSnapshot({ userId: 'someone-else' })),
            }),
        });

        await expect(service.syncCheckoutReturn('u1', 'cs_plan_1')).rejects.toBeInstanceOf(
            CheckoutSessionNotFoundError,
        );
        expect(subscriptionRepository.createOrUpdate).not.toHaveBeenCalled();
        expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
    });

    it('REFUSES a session with no owner metadata at all', async () => {
        const { service } = build({
            provider: makeProvider({
                retrieveCheckoutSession: jest
                    .fn()
                    .mockResolvedValue(paidPlanSnapshot({ userId: null })),
            }),
        });

        await expect(service.syncCheckoutReturn('u1', 'cs_plan_1')).rejects.toBeInstanceOf(
            CheckoutSessionNotFoundError,
        );
    });

    it('grants nothing while the payment is still settling', async () => {
        const { service, subscriptionService } = build({
            provider: makeProvider({
                retrieveCheckoutSession: jest
                    .fn()
                    .mockResolvedValue(paidPlanSnapshot({ status: 'open', paid: false })),
            }),
        });

        const result = await service.syncCheckoutReturn('u1', 'cs_plan_1');

        expect(result).toEqual({ status: 'pending', activated: false, planCode: 'standard' });
        expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
    });

    it('grants nothing for a credit top-up session returning through this route', async () => {
        const { service, subscriptionService } = build({
            provider: makeProvider({
                retrieveCheckoutSession: jest.fn().mockResolvedValue(
                    paidPlanSnapshot({
                        purpose: 'credits',
                        planCode: null,
                        packId: 'credits-1000',
                    }),
                ),
            }),
        });

        const result = await service.syncCheckoutReturn('u1', 'cs_plan_1');

        expect(result).toEqual({ status: 'ignored', activated: false, planCode: null });
        expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
    });

    it('fails closed when the provider is not configured', async () => {
        const { service } = build({
            provider: makeProvider({ isConfigured: jest.fn().mockReturnValue(false) }),
        });

        await expect(service.syncCheckoutReturn('u1', 'cs_plan_1')).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
    });
});

describe('applyWebhook — activation and revocation', () => {
    function event(overrides: Partial<BillingWebhookEvent> = {}): BillingWebhookEvent {
        return {
            id: 'evt_1',
            kind: 'subscription.activated',
            customerId: 'cus_1',
            referenceId: 'u1:standard',
            packId: null,
            amountCents: 2900,
            currency: 'usd',
            paymentId: null,
            providerType: 'checkout.session.completed',
            planCode: 'standard',
            subscriptionId: 'sub_1',
            currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
            cancelAtPeriodEnd: false,
            ...overrides,
        };
    }

    /**
     * REGRESSION (audit B07/B08). `applyWebhook` used to be
     * `if (activated) {…} else { cancel() }` — a bare fallthrough that was
     * only safe while the kind union had exactly two members. Adding
     * `subscription.updated` for the lifecycle made every dunning, pause
     * and resume delivery land in the else-branch, which would have
     * silently downgraded a PAYING customer. Revoking is now something
     * only an explicit `subscription.canceled` can do.
     */
    it.each([
        // The real third member: a lifecycle snapshot.
        ['subscription.updated', 'subscription-reconciled'],
        // A kind this service has never heard of. Cast deliberately —
        // the whole point is to simulate a FUTURE union member reaching a
        // build of this service that predates it, which is exactly how the
        // old fallthrough would have started revoking plans.
        ['subscription.trial_ending', 'ignored'],
    ])('a %s delivery never revokes the plan', async (kind, expected) => {
        const { service, subscriptionService } = build({
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'u1' }),
            }),
        });

        await expect(
            service.applyWebhook(event({ kind: kind as BillingWebhookEvent['kind'] })),
        ).resolves.toBe(expected);
        // Granting is `assignPlanToUser`; revoking is `cancel()`, which
        // reaches the subscription repository. Neither may happen here.
        expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
    });

    it('activates the plan, attributing by provider customer id', async () => {
        const { service, subscriptionService, profileRepository } = build({
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'u1' }),
            }),
        });

        await expect(service.applyWebhook(event())).resolves.toBe('subscription-activated');
        expect(profileRepository.findByCustomerId).toHaveBeenCalledWith('stripe', 'cus_1');
        expect(subscriptionService.assignPlanToUser).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'u1' }),
            'standard',
        );
    });

    it('is idempotent — a replayed delivery re-asserts the same tier', async () => {
        const { service, subscriptionRepository, subscriptionService } = build({
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'u1' }),
            }),
        });

        await service.applyWebhook(event());
        await service.applyWebhook(event());

        expect(subscriptionRepository.createOrUpdate).toHaveBeenCalledTimes(2);
        expect(subscriptionRepository.createOrUpdate.mock.calls[0][1]).toEqual(
            subscriptionRepository.createOrUpdate.mock.calls[1][1],
        );
        expect(subscriptionService.assignPlanToUser).toHaveBeenCalledTimes(2);
        expect(subscriptionService.assignPlanToUser).toHaveBeenLastCalledWith(
            expect.objectContaining({ id: 'u1' }),
            'standard',
        );
    });

    it('acknowledges an unattributable event instead of throwing', async () => {
        const { service, subscriptionService } = build();

        await expect(
            service.applyWebhook(event({ customerId: null, referenceId: null })),
        ).resolves.toBe('unattributed');
        expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
    });

    it('ignores an activation naming a plan we do not sell', async () => {
        const { service, subscriptionService } = build({
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'u1' }),
            }),
        });

        await expect(service.applyWebhook(event({ planCode: 'enterprise' }))).resolves.toBe(
            'ignored',
        );
        expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
    });

    it('revokes a cancelled subscription back to the free tier', async () => {
        const { service, subscriptionRepository, subscriptionService } = build({
            subscriptionRepository: makeSubscriptionRepository({
                findByProviderSubscriptionId: jest
                    .fn()
                    .mockResolvedValue({ id: 'sub-row-1', userId: 'u1' }),
            }),
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'u1' }),
            }),
        });

        await expect(
            service.applyWebhook(
                event({
                    kind: 'subscription.canceled',
                    providerType: 'customer.subscription.deleted',
                }),
            ),
        ).resolves.toBe('subscription-canceled');
        expect(subscriptionRepository.cancel).toHaveBeenCalledWith('sub-row-1');
        expect(subscriptionService.changePlanSelfService).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'u1' }),
            'free',
        );
    });

    it('never revokes a DIFFERENT live subscription when the named one is not on file', async () => {
        // The owner may legitimately hold a second, active subscription
        // this event says nothing about — "cancel whatever is active" is
        // exactly the wrong fallback.
        const { service, subscriptionRepository, subscriptionService } = build({
            subscriptionRepository: makeSubscriptionRepository({
                findByProviderSubscriptionId: jest.fn().mockResolvedValue(null),
                findActiveByUser: jest
                    .fn()
                    .mockResolvedValue({ id: 'sub-row-other', userId: 'u1' }),
            }),
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'u1' }),
            }),
        });

        await expect(
            service.applyWebhook(
                event({ kind: 'subscription.canceled', subscriptionId: 'sub_unknown' }),
            ),
        ).resolves.toBe('ignored');
        expect(subscriptionRepository.cancel).not.toHaveBeenCalled();
        expect(subscriptionService.changePlanSelfService).not.toHaveBeenCalled();
    });

    it('prefers the subscription row over the customer mapping when attributing', async () => {
        const { service, subscriptionService } = build({
            subscriptionRepository: makeSubscriptionRepository({
                findByProviderSubscriptionId: jest
                    .fn()
                    .mockResolvedValue({ id: 'sub-row-1', userId: 'owner-of-record' }),
            }),
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'stale-mapping' }),
            }),
            userRepository: makeUserRepository({
                findById: jest.fn().mockResolvedValue({ id: 'owner-of-record' }),
            }),
        });

        await service.applyWebhook(event());

        expect(subscriptionService.assignPlanToUser).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'owner-of-record' }),
            'standard',
        );
    });

    it('still records the provider truth when subscriptions are flag-disabled', async () => {
        const { service, subscriptionRepository, subscriptionService } = build({
            profileRepository: makeProfileRepository({
                findByCustomerId: jest.fn().mockResolvedValue({ userId: 'u1' }),
            }),
            subscriptionService: makeSubscriptionService({
                isEnabled: jest.fn().mockReturnValue(false),
            }),
        });

        await expect(service.applyWebhook(event())).resolves.toBe('subscription-activated');
        expect(subscriptionRepository.createOrUpdate).toHaveBeenCalled();
        // …but the privileged grant is not attempted on a deploy that
        // has subscriptions switched off (it would throw by contract).
        expect(subscriptionService.assignPlanToUser).not.toHaveBeenCalled();
    });
});
