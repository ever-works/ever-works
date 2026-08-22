import { PlanSubscriptionService } from './plan-subscription.service';
import { StripeBillingProvider } from './stripe-billing.provider';

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

function stripeClient(priceData: any[]) {
    return {
        customers: {
            create: jest.fn().mockResolvedValue({ id: 'cus_new' }),
            update: jest.fn().mockResolvedValue({ id: 'cus_1' }),
        },
        prices: { list: jest.fn().mockResolvedValue({ data: priceData }) },
        checkout: {
            sessions: {
                create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' }),
            },
        },
        webhooks: { constructEvent: jest.fn() },
    } as any;
}

function wire(priceData: any[]) {
    const client = stripeClient(priceData);
    const provider = new StripeBillingProvider(jest.fn().mockReturnValue(client));
    const service = new PlanSubscriptionService(
        provider as any,
        { findByCode: jest.fn().mockResolvedValue(SELFHOSTED_PRO_PLAN) } as any,
        {
            createOrUpdate: jest.fn(),
            findByProviderSubscriptionId: jest.fn().mockResolvedValue(null),
            findActiveByUser: jest.fn().mockResolvedValue(null),
            cancel: jest.fn(),
        } as any,
        {
            findByUserId: jest.fn().mockResolvedValue(null),
            findByCustomerId: jest.fn().mockResolvedValue(null),
            ensure: jest.fn().mockResolvedValue({ userId: 'u1', providerCustomerId: 'cus_1' }),
        } as any,
        { findById: jest.fn().mockResolvedValue({ id: 'u1', email: 'buyer@example.test' }) } as any,
        { isEnabled: jest.fn().mockReturnValue(true) } as any,
    );
    return { service, client };
}

const options = {
    userId: 'u1',
    planCode: 'selfhosted_pro',
    successUrl: 'https://app.test/settings/billing?plan=success',
    cancelUrl: 'https://app.test/settings/billing?plan=cancelled',
};

describe('THROWAWAY e2e — real service + real provider, fake Stripe SDK', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    it('CONTROL — synced account: one-time catalog price, no recurring anywhere', async () => {
        const { service, client } = wire([{ id: 'price_live_lifetime' }]);
        await service.startPlanCheckout({ ...options, interval: 'lifetime' } as any);
        const p = client.checkout.sessions.create.mock.calls[0][0];
        // eslint-disable-next-line no-console
        console.log('CONTROL:', JSON.stringify({ mode: p.mode, line_items: p.line_items }));
        expect(p.mode).toBe('payment');
        expect(p.line_items[0].price).toBe('price_live_lifetime');
    });

    it('DEFECT — unsynced account: mode=payment WITH price_data.recurring', async () => {
        const { service, client } = wire([]);
        await service.startPlanCheckout({ ...options, interval: 'lifetime' } as any);
        const p = client.checkout.sessions.create.mock.calls[0][0];
        // eslint-disable-next-line no-console
        console.log('DEFECT:', JSON.stringify({ mode: p.mode, line_items: p.line_items }));
        expect(p.mode).toBe('payment');
        expect(p.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
        expect(p.line_items[0].price_data.unit_amount).toBe(9900);
    });

    it('CONTROL 2 — annual (subscription mode) fallback is a VALID combination', async () => {
        const { service, client } = wire([]);
        await service.startPlanCheckout({ ...options, interval: 'annual' } as any);
        const p = client.checkout.sessions.create.mock.calls[0][0];
        // eslint-disable-next-line no-console
        console.log('CONTROL2:', JSON.stringify({ mode: p.mode, line_items: p.line_items }));
        expect(p.mode).toBe('subscription');
        expect(p.line_items[0].price_data.recurring).toEqual({ interval: 'year' });
    });
});
