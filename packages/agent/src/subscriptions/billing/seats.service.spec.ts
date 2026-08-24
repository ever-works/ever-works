import {
    SeatLimitExceededError,
    SeatsBelowUsageError,
    SeatsNotPurchasableError,
    SeatsService,
} from './seats.service';
import { BillingProviderNotConfiguredError } from './billing.provider';
import { SubscriptionStatus } from '@src/entities/user-subscription.entity';

/**
 * Seats — employees OR agents (billing spec §3.6).
 *
 * The money-shaped rules pinned here: a person in three Organizations of
 * one Tenant is ONE seat, agents count tenant-wide, the admission check
 * fails OPEN on everything except a genuinely full allowance, an unbounded
 * plan never refuses, the server clamps the billable extras from the plan
 * row (never a client number), and an owner can never shrink the allowance
 * below what is already in use.
 */
const PRO_PLAN = {
    code: 'standard',
    displayName: 'Pro',
    hosting: 'cloud',
    seatsIncluded: 10,
    seatMonthlyPrice: '5',
};

const ENTERPRISE_UNBOUNDED = {
    code: 'premium',
    displayName: 'Enterprise',
    hosting: 'cloud',
    seatsIncluded: null,
    seatMonthlyPrice: null,
};

function makeHarness(
    options: {
        subscription?: Record<string, unknown> | null;
        plan?: Record<string, unknown> | null;
        members?: number;
        agents?: number;
        tenantId?: string | null;
        subscriptionsEnabled?: boolean;
        configured?: boolean;
    } = {},
) {
    const savedEnv = process.env.SUBSCRIPTIONS_ENABLED;
    if (options.subscriptionsEnabled === false) {
        delete process.env.SUBSCRIPTIONS_ENABLED;
    } else {
        process.env.SUBSCRIPTIONS_ENABLED = 'true';
    }

    const subscription =
        options.subscription === undefined
            ? {
                  id: 'sub-row-1',
                  userId: 'owner-1',
                  planCode: 'standard',
                  status: SubscriptionStatus.ACTIVE,
                  providerSubscriptionId: 'sub_stripe',
                  providerSeatItemId: null,
                  seats: 0,
                  plan: PRO_PLAN,
                  createdAt: new Date('2026-08-01T00:00:00Z'),
                  currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
              }
            : options.subscription;

    const billingProvider = {
        isConfigured: jest.fn(() => options.configured ?? true),
        getProviderId: jest.fn(() => 'stripe'),
        updateSeatQuantity: jest.fn(async () => ({
            subscriptionId: 'sub_stripe',
            status: 'active',
            cancelAtPeriodEnd: false,
            currentPeriodEnd: null,
            canceledAt: null,
            seats: 5,
            seatItemId: 'si_seat',
        })),
    };
    const userSubscriptionRepository = {
        findActiveByUser: jest.fn(async () => subscription),
        updateSeats: jest.fn(async () => undefined),
    };
    const planRepository = {
        findByCode: jest.fn(async () => options.plan ?? PRO_PLAN),
    };
    const organizationMemberRepository = {
        countDistinctUsersForTenant: jest.fn(async () => options.members ?? 3),
    };
    const agentRepository = {
        countActiveForTenant: jest.fn(async () => options.agents ?? 2),
        countActiveForUser: jest.fn(async () => options.agents ?? 2),
    };
    const userRepository = {
        findById: jest.fn(async () => ({
            id: 'owner-1',
            tenantId: options.tenantId === undefined ? 'tenant-1' : options.tenantId,
        })),
    };
    const tenantRepository = {
        findById: jest.fn(async () => ({ id: 'tenant-1', ownerUserId: 'owner-1' })),
    };

    const service = new SeatsService(
        billingProvider as any,
        userSubscriptionRepository as any,
        planRepository as any,
        organizationMemberRepository as any,
        agentRepository as any,
        userRepository as any,
        tenantRepository as any,
    );
    return {
        service,
        billingProvider,
        userSubscriptionRepository,
        planRepository,
        organizationMemberRepository,
        agentRepository,
        userRepository,
        tenantRepository,
        restoreEnv: () => {
            if (savedEnv === undefined) delete process.env.SUBSCRIPTIONS_ENABLED;
            else process.env.SUBSCRIPTIONS_ENABLED = savedEnv;
        },
    };
}

afterEach(() => {
    delete process.env.SUBSCRIPTIONS_ENABLED;
});

describe('SeatsService.getSeats', () => {
    it('composes allowance from the plan + purchased extras and usage from people AND agents', async () => {
        const h = makeHarness({
            members: 3,
            agents: 2,
            subscription: {
                id: 'sub-row-1',
                planCode: 'standard',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_stripe',
                seats: 4,
                plan: PRO_PLAN,
                createdAt: new Date('2026-08-01T00:00:00Z'),
                currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
            },
        });

        const seats = await h.service.getSeats('owner-1');

        expect(seats).toMatchObject({
            included: 10,
            purchased: 4,
            allowance: 14,
            members: 3,
            agents: 2,
            used: 5,
            available: 9,
            seatPriceCents: 500,
            purchasable: true,
        });
        // Distinct PEOPLE, not membership rows — a member of three orgs is one seat.
        expect(h.organizationMemberRepository.countDistinctUsersForTenant).toHaveBeenCalledWith(
            'tenant-1',
        );
        // Agents counted TENANT-wide: one built by a teammate is capacity too.
        expect(h.agentRepository.countActiveForTenant).toHaveBeenCalledWith('tenant-1');
    });

    it('reports an unbounded plan as allowance null (never 0, which would lock everyone out)', async () => {
        const h = makeHarness({
            plan: ENTERPRISE_UNBOUNDED,
            subscription: {
                id: 'sub-row-1',
                planCode: 'premium',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_stripe',
                seats: null,
                plan: ENTERPRISE_UNBOUNDED,
            },
        });

        const seats = await h.service.getSeats('owner-1');

        expect(seats.included).toBeNull();
        expect(seats.allowance).toBeNull();
        expect(seats.available).toBeNull();
        expect(seats.purchasable).toBe(false);
    });

    it('counts the owner as a seat even with no roster row, and falls back to their own agents with no Tenant', async () => {
        const h = makeHarness({ members: 0, agents: 1, tenantId: null });

        const seats = await h.service.getSeats('owner-1');

        expect(seats.members).toBe(1);
        expect(h.agentRepository.countActiveForUser).toHaveBeenCalledWith('owner-1');
        expect(h.agentRepository.countActiveForTenant).not.toHaveBeenCalled();
    });

    it('falls back to the default plan when there is no subscription', async () => {
        const h = makeHarness({ subscription: null });
        const seats = await h.service.getSeats('owner-1');
        expect(h.planRepository.findByCode).toHaveBeenCalledWith('free');
        expect(seats.purchased).toBe(0);
        expect(seats.purchasable).toBe(false);
    });
});

describe('SeatsService.assertSeatAvailable', () => {
    it('admits while a seat is left and refuses when the next one would exceed the allowance', async () => {
        const full = makeHarness({ members: 10, agents: 4 }); // 14 used, allowance 10
        await expect(full.service.assertSeatAvailable('owner-1')).rejects.toBeInstanceOf(
            SeatLimitExceededError,
        );

        const room = makeHarness({ members: 3, agents: 2 }); // 5 used, allowance 10
        await expect(room.service.assertSeatAvailable('owner-1')).resolves.toBeUndefined();
    });

    it('refuses exactly at the boundary, not one seat early', async () => {
        // 9 used of 10 → the 10th is allowed; an 11th is not.
        const h = makeHarness({ members: 7, agents: 2 });
        await expect(h.service.assertSeatAvailable('owner-1', 1)).resolves.toBeUndefined();
        await expect(h.service.assertSeatAvailable('owner-1', 2)).rejects.toBeInstanceOf(
            SeatLimitExceededError,
        );
    });

    it('is a no-op when subscriptions are disabled, on an unbounded plan, and when resolution throws (fail-open)', async () => {
        const off = makeHarness({ members: 99, agents: 99, subscriptionsEnabled: false });
        await expect(off.service.assertSeatAvailable('owner-1')).resolves.toBeUndefined();

        const unbounded = makeHarness({
            members: 99,
            agents: 99,
            plan: ENTERPRISE_UNBOUNDED,
            subscription: {
                id: 's',
                planCode: 'premium',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_stripe',
                plan: ENTERPRISE_UNBOUNDED,
            },
        });
        await expect(unbounded.service.assertSeatAvailable('owner-1')).resolves.toBeUndefined();

        const broken = makeHarness({ members: 99, agents: 99 });
        broken.userSubscriptionRepository.findActiveByUser.mockRejectedValue(new Error('DB down'));
        await expect(broken.service.assertSeatAvailable('owner-1')).resolves.toBeUndefined();
    });
});

describe('SeatsService.resolveBillingOwner', () => {
    it('resolves the Tenant owner, and the acting user when there is no Tenant or the lookup fails', async () => {
        const h = makeHarness();
        h.tenantRepository.findById.mockResolvedValue({
            id: 'tenant-1',
            ownerUserId: 'boss',
        } as any);
        expect(await h.service.resolveBillingOwner('member-9')).toBe('boss');

        const solo = makeHarness({ tenantId: null });
        expect(await solo.service.resolveBillingOwner('member-9')).toBe('member-9');

        const broken = makeHarness();
        broken.userRepository.findById.mockRejectedValue(new Error('DB down'));
        expect(await broken.service.resolveBillingOwner('member-9')).toBe('member-9');
    });
});

describe('SeatsService.setSeats', () => {
    it('bills only the extras above the plan allowance, clamped server-side, and persists what the provider confirms', async () => {
        const h = makeHarness({ members: 3, agents: 2 });

        await h.service.setSeats('owner-1', 15);

        // 15 wanted − 10 included = 5 extras. The client's number never reaches the provider raw.
        expect(h.billingProvider.updateSeatQuantity).toHaveBeenCalledWith({
            subscriptionId: 'sub_stripe',
            seatLookupKey: 'ever_works_cloud_pro_seat_monthly',
            seatItemId: null,
            quantity: 5,
        });
        expect(h.userSubscriptionRepository.updateSeats).toHaveBeenCalledWith('sub-row-1', {
            seats: 5,
            providerSeatItemId: 'si_seat',
        });
    });

    it('refuses to drop the allowance below the seats already in use', async () => {
        const h = makeHarness({ members: 8, agents: 4 }); // 12 in use
        await expect(h.service.setSeats('owner-1', 6)).rejects.toBeInstanceOf(SeatsBelowUsageError);
        expect(h.billingProvider.updateSeatQuantity).not.toHaveBeenCalled();
    });

    it('rejects when there is nothing to add seats to, or the plan sells none, or the provider is off', async () => {
        const noSub = makeHarness({ subscription: null });
        await expect(noSub.service.setSeats('owner-1', 12)).rejects.toBeInstanceOf(
            SeatsNotPurchasableError,
        );

        const unbounded = makeHarness({
            plan: ENTERPRISE_UNBOUNDED,
            subscription: {
                id: 's',
                planCode: 'premium',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_stripe',
                plan: ENTERPRISE_UNBOUNDED,
            },
        });
        await expect(unbounded.service.setSeats('owner-1', 12)).rejects.toBeInstanceOf(
            SeatsNotPurchasableError,
        );

        const off = makeHarness({ configured: false });
        await expect(off.service.setSeats('owner-1', 12)).rejects.toBeInstanceOf(
            BillingProviderNotConfiguredError,
        );
    });

    it('setting the total back to the included allowance removes the extras (quantity 0)', async () => {
        const h = makeHarness({
            members: 3,
            agents: 2,
            subscription: {
                id: 'sub-row-1',
                planCode: 'standard',
                status: SubscriptionStatus.ACTIVE,
                providerSubscriptionId: 'sub_stripe',
                providerSeatItemId: 'si_seat',
                seats: 5,
                plan: PRO_PLAN,
                createdAt: new Date('2026-08-01T00:00:00Z'),
                currentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
            },
        });

        await h.service.setSeats('owner-1', 10);

        expect(h.billingProvider.updateSeatQuantity).toHaveBeenCalledWith(
            expect.objectContaining({ seatItemId: 'si_seat', quantity: 0 }),
        );
    });
});
