import { StripeBillingProvider } from './stripe-billing.provider';

function build() {
    const client = {
        customers: { create: jest.fn(), update: jest.fn() },
        checkout: {
            sessions: {
                create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://pay.example/cs_1' }),
            },
        },
    } as any;
    return { provider: new StripeBillingProvider(jest.fn().mockReturnValue(client)), client };
}

describe('TMP VERIFY 2 — same scenario against whatever is on disk now', () => {
    beforeEach(() => {
        process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    });

    it('reports how many seat lookups happen after one blip', async () => {
        const { provider, client } = build();
        let seatCalls = 0;
        client.prices = {
            list: jest.fn().mockImplementation(async ({ lookup_keys }: any) => {
                const key = lookup_keys[0] as string;
                if (key.includes('_seat_')) {
                    seatCalls += 1;
                    if (seatCalls === 1) throw new Error('429 rate limited');
                    return { data: [{ id: 'price_seat_ent_monthly' }] };
                }
                return { data: [{ id: 'price_ent_monthly' }] };
            }),
        };
        const req = (u: string) => ({
            userId: u,
            customerId: 'cus_1',
            plan: {
                code: 'premium',
                label: 'Enterprise plan',
                priceCents: 19900,
                currency: 'usd',
                interval: 'month' as const,
                lookupKey: 'ever_works_cloud_enterprise_monthly',
                seatLookupKey: 'ever_works_cloud_enterprise_seat_monthly',
                extraSeats: 50,
            },
            successUrl: 'https://app.test/ok',
            cancelUrl: 'https://app.test/no',
            referenceId: `${u}:premium`,
        });
        await provider.createPlanCheckoutSession(req('buyer-1'));
        await provider.createPlanCheckoutSession(req('buyer-2'));
        const calls = client.checkout.sessions.create.mock.calls.map((c: any[]) => c[0]);
        // eslint-disable-next-line no-console
        console.log('RESULT seatCalls=', seatCalls, 'buyer2 lines=', JSON.stringify(calls[1].line_items));
    });
});
