import { PlanSubscriptionService } from './plan-subscription.service';
import { StripeBillingProvider } from './stripe-billing.provider';
import { CATALOG_CURRENCY, resolveSkuForPlanRow } from './stripe-catalog';

// The row SubscriptionService.seedPlans() writes when BILLING_DEFAULT_CURRENCY=eur.
const PREMIUM_EUR = {
    id: 'plan-premium',
    code: 'premium',
    displayName: 'Enterprise',
    hosting: 'cloud',
    monthlyPrice: '199',
    annualPrice: '1668',
    lifetimePrice: null,
    seatsIncluded: 10,
    seatMonthlyPrice: '10',
    monthlyCredits: 25000,
    currency: 'eur', // <- from config.billing.getDefaultCurrency()
    active: true,
};

function provider() {
    return {
        getProviderId: jest.fn().mockReturnValue('stripe'),
        getDefaultCurrency: jest.fn().mockReturnValue('eur'),
        isConfigured: jest.fn().mockReturnValue(true),
        ensureCustomer: jest.fn().mockResolvedValue('cus_1'),
        createPlanCheckoutSession: jest.fn().mockResolvedValue({
            url: 'https://pay.example/cs_1',
            sessionId: 'cs_1',
            customerId: 'cus_1',
        }),
        retrieveCheckoutSession: jest.fn(),
    } as any;
}

function build() {
    const p = provider();
    const svc = new PlanSubscriptionService(
        p,
        { findByCode: jest.fn().mockResolvedValue(PREMIUM_EUR) } as any,
        {} as any,
        {
            findByUserId: jest.fn().mockResolvedValue(null),
            ensure: jest.fn().mockResolvedValue({ userId: 'u1', providerCustomerId: 'cus_1' }),
        } as any,
        { findById: jest.fn().mockResolvedValue({ id: 'u1', email: 'b@e.test' }) } as any,
        { isEnabled: jest.fn().mockReturnValue(true) } as any,
    );
    return { svc, p };
}

it('CONTROL: the catalog itself is USD and the annual enterprise SKU is 166800', () => {
    expect(CATALOG_CURRENCY).toBe('usd');
    const sku = resolveSkuForPlanRow({ code: 'premium', hosting: 'cloud', interval: 'annual' });
    expect(sku?.lookupKey).toBe('ever_works_cloud_enterprise_annual');
    expect(sku?.price.amountCents).toBe(166800);
});

it('CATALOG PATH: amount comes from the USD catalog, currency echoed to the buyer is eur', async () => {
    const { svc, p } = build();
    const started = await svc.startPlanCheckout({
        userId: 'u1',
        planCode: 'premium',
        interval: 'annual',
        successUrl: 'https://a/s',
        cancelUrl: 'https://a/c',
    });
    const req = p.createPlanCheckoutSession.mock.calls[0][0];
    console.log('descriptor  =', JSON.stringify(req.plan));
    console.log('API response=', JSON.stringify(started));
    expect(req.plan.lookupKey).toBe('ever_works_cloud_enterprise_annual');
    expect(req.plan.priceCents).toBe(166800); // catalog amount, denominated in USD
    expect(started.currency).toBe('eur'); // told to the buyer
});

it('FALLBACK PATH: unresolvable lookup_key => Stripe price_data.currency = eur on a USD amount', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy_for_config_posture_only';
    const client = {
        customers: { create: jest.fn(), update: jest.fn().mockResolvedValue({ id: 'cus_1' }) },
        prices: { list: jest.fn().mockResolvedValue({ data: [] }) }, // account not synced
        checkout: {
            sessions: {
                create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay/cs_1' }),
            },
        },
    } as any;
    const stripe = new StripeBillingProvider(jest.fn().mockReturnValue(client));
    await stripe.createPlanCheckoutSession({
        userId: 'u1',
        userEmail: 'b@e.test',
        customerId: 'cus_1',
        referenceId: 'u1:premium',
        successUrl: 'https://a/s',
        cancelUrl: 'https://a/c',
        plan: {
            code: 'premium',
            label: 'Enterprise plan',
            priceCents: 166800,
            currency: 'eur',
            interval: 'year',
            mode: 'subscription',
            lookupKey: 'ever_works_cloud_enterprise_annual',
            seatLookupKey: null,
            extraSeats: 0,
        },
    } as any);
    const params = client.checkout.sessions.create.mock.calls[0][0];
    console.log('line_items  =', JSON.stringify(params.line_items));
    expect(params.line_items[0].price_data.currency).toBe('eur');
    expect(params.line_items[0].price_data.unit_amount).toBe(166800);
    delete process.env.STRIPE_SECRET_KEY;
});
