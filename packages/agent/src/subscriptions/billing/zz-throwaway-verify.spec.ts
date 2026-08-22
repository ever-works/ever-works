import { StripeBillingProvider } from './stripe-billing.provider';

function fakeClient(pricesListResult: any) {
    return {
        customers: {
            create: jest.fn().mockResolvedValue({ id: 'cus_new' }),
            update: jest.fn().mockResolvedValue({ id: 'cus_1' }),
        },
        prices: { list: jest.fn().mockResolvedValue(pricesListResult) },
        checkout: {
            sessions: {
                create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' }),
            },
        },
        webhooks: { constructEvent: jest.fn() },
    } as any;
}

describe('THROWAWAY — lifetime fallback', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    const lifetimeRequest = {
        userId: 'u1',
        customerId: 'cus_1',
        plan: {
            code: 'selfhosted_pro',
            label: 'Self-hosted Pro Edition plan',
            priceCents: 9900,
            currency: 'usd',
            // exactly what plan-subscription.service.ts:200 computes for interval==='lifetime'
            interval: 'month' as const,
            // exactly what :203 computes
            mode: 'payment' as const,
            lookupKey: 'ever_works_selfhosted_pro_lifetime',
            seatLookupKey: null,
            extraSeats: 0,
        },
        successUrl: 'https://app.test/settings/billing?plan=success',
        cancelUrl: 'https://app.test/settings/billing?plan=cancelled',
        referenceId: 'u1:selfhosted_pro',
    };

    it('CONTROL: catalog key resolves -> no price_data at all', async () => {
        const client = fakeClient({ data: [{ id: 'price_live_lifetime' }] });
        const provider = new StripeBillingProvider(jest.fn().mockReturnValue(client));
        await provider.createPlanCheckoutSession(lifetimeRequest as any);
        const params = client.checkout.sessions.create.mock.calls[0][0];
        // eslint-disable-next-line no-console
        console.log('CONTROL params:', JSON.stringify({ mode: params.mode, line_items: params.line_items }, null, 2));
        expect(params.mode).toBe('payment');
        expect(params.line_items[0].price).toBe('price_live_lifetime');
        expect(params.line_items[0].price_data).toBeUndefined();
    });

    it('DEFECT: unsynced account -> payment mode carrying recurring price_data', async () => {
        const client = fakeClient({ data: [] }); // lookup_key not present in this account
        const provider = new StripeBillingProvider(jest.fn().mockReturnValue(client));
        await provider.createPlanCheckoutSession(lifetimeRequest as any);
        const params = client.checkout.sessions.create.mock.calls[0][0];
        // eslint-disable-next-line no-console
        console.log('DEFECT params:', JSON.stringify({ mode: params.mode, line_items: params.line_items }, null, 2));
        expect(params.mode).toBe('payment');
        expect(params.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
    });
});
