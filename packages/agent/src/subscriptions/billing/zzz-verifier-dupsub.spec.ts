import { PlanSubscriptionService } from './plan-subscription.service';
import type { BillingWebhookEvent } from './billing.provider';
import { SubscriptionStatus } from '@src/entities/user-subscription.entity';

/**
 * THROWAWAY verifier spec — reproduces the "second checkout stacks a second live
 * Stripe subscription" claim with in-memory fakes that mirror the REAL repository
 * semantics (see user-subscription.repository.ts / billing-profile.repository).
 */

const PLANS: Record<string, any> = {
    standard: {
        id: 'plan-standard', code: 'standard', displayName: 'Pro', hosting: 'cloud',
        monthlyPrice: '25', annualPrice: '204', lifetimePrice: null, seatsIncluded: 10,
        seatMonthlyPrice: '5', currency: 'usd', active: true,
    },
    premium: {
        id: 'plan-premium', code: 'premium', displayName: 'Enterprise', hosting: 'cloud',
        monthlyPrice: '199', annualPrice: '1668', lifetimePrice: null, seatsIncluded: 10,
        seatMonthlyPrice: '10', currency: 'usd', active: true,
    },
};

// ── fakes with the real repositories' semantics ───────────────────────────────
class FakeSubRepo {
    rows: any[] = [];
    private seq = 0;
    findActiveByUser = jest.fn(async (userId: string) =>
        this.rows.find((r) => r.userId === userId && r.status === SubscriptionStatus.ACTIVE) ?? null,
    );
    findByProviderSubscriptionId = jest.fn(async (id: string) =>
        this.rows.find((r) => r.providerSubscriptionId === id) ?? null,
    );
    createOrUpdate = jest.fn(async (userId: string, data: any) => {
        const existing = await this.findActiveByUser(userId);
        if (existing) { Object.assign(existing, data); return existing; }
        const row = { id: `row-${++this.seq}`, userId, ...data };
        this.rows.push(row);
        return row;
    });
    cancel = jest.fn(async (id: string) => {
        const r = this.rows.find((x) => x.id === id);
        if (r) r.status = SubscriptionStatus.CANCELED;
    });
}

class FakeProfileRepo {
    profile: any = null;
    findByUserId = jest.fn(async (userId: string) =>
        this.profile && this.profile.userId === userId ? this.profile : null,
    );
    findByCustomerId = jest.fn(async (_p: string, cus: string) =>
        this.profile && this.profile.providerCustomerId === cus ? this.profile : null,
    );
    ensure = jest.fn(async (input: any) => {
        this.profile = this.profile ?? { userId: input.userId, providerCustomerId: input.providerCustomerId };
        return this.profile;
    });
    updateSubscriptionState = jest.fn(async (userId: string, state: any) => {
        if (this.profile?.userId === userId) Object.assign(this.profile, state);
        return this.profile;
    });
}

function build() {
    const subRepo = new FakeSubRepo();
    const profileRepo = new FakeProfileRepo();
    const stripeSubs: any[] = []; // what Stripe would actually be billing
    const provider = {
        getProviderId: () => 'stripe',
        getDefaultCurrency: () => 'usd',
        isConfigured: () => true,
        ensureCustomer: jest.fn(async () => 'cus_1'),
        createPlanCheckoutSession: jest.fn(async (req: any) => {
            // Stripe: mode:'subscription' + an existing customer ALWAYS creates a NEW subscription.
            const id = `sub_${stripeSubs.length + 1}`;
            stripeSubs.push({ id, planCode: req.plan.code, priceCents: req.plan.priceCents, status: 'active' });
            return { url: `https://pay.example/${id}`, sessionId: `cs_${id}`, customerId: 'cus_1' };
        }),
        retrieveCheckoutSession: jest.fn(),
    } as any;
    const planRepo = { findByCode: jest.fn(async (c: string) => PLANS[c] ?? null) } as any;
    const userRepo = { findById: jest.fn(async () => ({ id: 'u1', email: 'b@e.test' })) } as any;
    const assigned: string[] = [];
    const subscriptionService = {
        isEnabled: () => true,
        assignPlanToUser: jest.fn(async (_u: any, code: string) => { assigned.push(code); }),
        changePlanSelfService: jest.fn(async (_u: any, code: string) => { assigned.push(code); }),
    } as any;
    const service = new PlanSubscriptionService(
        provider, planRepo, subRepo as any, profileRepo as any, userRepo, subscriptionService,
    );
    return { service, subRepo, profileRepo, provider, stripeSubs, assigned };
}

const evt = (o: Partial<BillingWebhookEvent>): BillingWebhookEvent =>
    ({ id: `evt_${Math.random()}`, providerType: 'stripe', ...o }) as any;

it('DEMO: a second plan checkout stacks a second live subscription and orphans the first', async () => {
    const t = build();

    // 1) Buy Pro ($25/mo)
    await t.service.startPlanCheckout({
        userId: 'u1', planCode: 'standard', successUrl: 's', cancelUrl: 'c',
    });
    await (t.service as any).applyWebhook(evt({
        kind: 'subscription.activated', customerId: 'cus_1', planCode: 'standard',
        subscriptionId: 'sub_1', referenceId: 'u1:standard',
    }));
    expect(t.subRepo.rows).toHaveLength(1);
    expect(t.subRepo.rows[0].providerSubscriptionId).toBe('sub_1');

    // 2) SAME user starts a SECOND checkout for Enterprise. No guard fires.
    t.subRepo.findActiveByUser.mockClear();
    const second = await t.service.startPlanCheckout({
        userId: 'u1', planCode: 'premium', successUrl: 's', cancelUrl: 'c',
    });
    expect(second.sessionId).toBe('cs_sub_2');           // it was allowed
    expect(t.subRepo.findActiveByUser).not.toHaveBeenCalled(); // nothing ever looked

    await (t.service as any).applyWebhook(evt({
        kind: 'subscription.activated', customerId: 'cus_1', planCode: 'premium',
        subscriptionId: 'sub_2', referenceId: 'u1:premium',
    }));

    // 3) Stripe is now billing BOTH; the platform records only ONE row, pointing at sub_2.
    expect(t.stripeSubs.map((s) => [s.id, s.planCode, s.priceCents])).toEqual([
        ['sub_1', 'standard', 2500], ['sub_2', 'premium', 19900],
    ]);
    expect(t.subRepo.rows).toHaveLength(1);
    expect(t.subRepo.rows[0].providerSubscriptionId).toBe('sub_2');
    expect(await t.subRepo.findByProviderSubscriptionId('sub_1')).toBeNull(); // handle lost

    // 4) The billing profile's single subscription slot also points at sub_2 only.
    expect(t.profileRepo.profile.providerSubscriptionId ?? 'sub_2').toBe('sub_2');

    // 5) A cancel for sub_1 is REFUSED — "provider subscription is not on file".
    const canceled = await (t.service as any).applyWebhook(evt({
        kind: 'subscription.canceled', customerId: 'cus_1', subscriptionId: 'sub_1',
    }));
    expect(canceled).toBe('ignored');
    expect(t.subRepo.rows[0].status).toBe(SubscriptionStatus.ACTIVE);

    // 6) sub_1's next renewal (customer.subscription.updated, status active ->
    //    kind subscription.activated) is attributed via customerId and SILENTLY
    //    DOWNGRADES the account back to Pro while Enterprise is still being billed.
    await (t.service as any).applyWebhook(evt({
        kind: 'subscription.activated', customerId: 'cus_1', planCode: 'standard',
        subscriptionId: 'sub_1', referenceId: 'u1:standard',
    }));
    expect(t.subRepo.rows[0].planCode).toBe('standard');
    expect(t.assigned).toEqual(['standard', 'premium', 'standard']);
});
