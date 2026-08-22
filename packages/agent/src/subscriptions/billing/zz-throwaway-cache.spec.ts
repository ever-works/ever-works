import { StripeBillingProvider } from './stripe-billing.provider';

const req = {
    userId: 'u1',
    customerId: 'cus_1',
    plan: {
        code: 'selfhosted_pro',
        label: 'Pro Edition plan',
        priceCents: 9900,
        currency: 'usd',
        interval: 'month' as const,
        mode: 'payment' as const,
        lookupKey: 'ever_works_selfhosted_pro_lifetime',
        seatLookupKey: null,
        extraSeats: 0,
    },
    successUrl: 'https://app.test/ok',
    cancelUrl: 'https://app.test/no',
    referenceId: 'u1:selfhosted_pro',
};

it('THROWAWAY — ONE transient prices.list failure poisons the key for the process lifetime', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    const list = jest
        .fn()
        // first call: Stripe hiccup (timeout / 500)
        .mockRejectedValueOnce(new Error('Request timed out'))
        // every later call: Stripe is healthy again and the key IS present live
        .mockResolvedValue({ data: [{ id: 'price_live_lifetime' }] });
    const client = {
        customers: { create: jest.fn(), update: jest.fn().mockResolvedValue({ id: 'cus_1' }) },
        prices: { list },
        checkout: {
            sessions: {
                create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' }),
            },
        },
        webhooks: { constructEvent: jest.fn() },
    } as any;
    const provider = new StripeBillingProvider(jest.fn().mockReturnValue(client));

    await provider.createPlanCheckoutSession(req as any); // buyer #1, during the hiccup
    await provider.createPlanCheckoutSession(req as any); // buyer #2, Stripe healthy
    await provider.createPlanCheckoutSession(req as any); // buyer #3, Stripe healthy

    // Stripe was only ever asked ONCE — the null answer was memoised.
    expect(list).toHaveBeenCalledTimes(1);
    for (const call of client.checkout.sessions.create.mock.calls) {
        const p = call[0];
        // eslint-disable-next-line no-console
        console.log('emitted:', JSON.stringify({ mode: p.mode, li: p.line_items[0] }));
        expect(p.mode).toBe('payment');
        expect(p.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
    }
});
