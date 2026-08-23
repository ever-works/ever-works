// H1 — regression spec for the plan-checkout request BODY.
//
// 🛑 This exists because of the exact bug it guards. The API has accepted
// `interval` and `seats` on `POST /billing/checkout/plan` since the plan
// catalog landed, the controller forwarded them, the service priced them and
// the $99 perpetual-licence SKU sat in Stripe — and the perpetual licence was
// still unbuyable, because `billingAPI.startPlanCheckout` built a body of
// `{ planCode }` and nothing else. Every server-side test passed. The feature
// was not refused, it was unreachable.
//
// So the assertion here is the SERIALISED BODY, not a mock call count: if a
// refactor drops the `interval` key, this must go red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { serverFetchMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
}));

async function importApi() {
    return import('./billing');
}

/** The parsed JSON body of the single serverFetch call. */
function sentBody(): Record<string, unknown> {
    expect(serverFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = serverFetchMock.mock.calls[0];
    return JSON.parse(String(init.body));
}

beforeEach(() => {
    serverFetchMock.mockReset();
    serverFetchMock.mockResolvedValue({ status: 'success', url: 'https://pay.test/cs_1' });
});
afterEach(() => vi.resetModules());

describe('billingAPI.startPlanCheckout — what actually crosses the wire', () => {
    it('sends interval when asked for a lifetime licence', async () => {
        const { billingAPI } = await importApi();

        await billingAPI.startPlanCheckout('selfhosted_pro', { interval: 'lifetime' });

        expect(serverFetchMock).toHaveBeenCalledWith(
            '/billing/checkout/plan',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(sentBody()).toEqual({ planCode: 'selfhosted_pro', interval: 'lifetime' });
    });

    it('sends seats when a seat count is supplied', async () => {
        const { billingAPI } = await importApi();

        await billingAPI.startPlanCheckout('standard', { interval: 'monthly', seats: 17 });

        expect(sentBody()).toEqual({ planCode: 'standard', interval: 'monthly', seats: 17 });
    });

    it('sends seats: 0 — a falsy value that is still a real answer', async () => {
        const { billingAPI } = await importApi();

        await billingAPI.startPlanCheckout('standard', { seats: 0 });

        // A `if (options.seats)` truthiness check would silently drop this.
        expect(sentBody()).toEqual({ planCode: 'standard', seats: 0 });
    });

    it('omits both when not supplied, so the body stays what it always was', async () => {
        // Back-compatibility: the server defaults a missing interval to monthly,
        // and the DTO is `forbidNonWhitelisted` — an explicit `undefined` key
        // would serialise away, but an explicit `null` would 400.
        const { billingAPI } = await importApi();

        await billingAPI.startPlanCheckout('standard');

        expect(sentBody()).toEqual({ planCode: 'standard' });
    });

    it('still forwards organizationId, and never invents a price field', async () => {
        const { billingAPI } = await importApi();

        await billingAPI.startPlanCheckout('standard', {
            organizationId: 'org-1',
            interval: 'annual',
        });

        const body = sentBody();
        expect(body).toEqual({
            planCode: 'standard',
            organizationId: 'org-1',
            interval: 'annual',
        });
        // The client can never name an amount: the DTO rejects the whole request
        // rather than stripping it, so a stray field here is a hard 400.
        for (const forbidden of ['priceCents', 'monthlyPrice', 'amount', 'credits', 'userId']) {
            expect(body).not.toHaveProperty(forbidden);
        }
    });
});
