import { DataSource } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { BillingProfile } from '../../entities/billing-profile.entity';
import { SubscriptionPlan } from '../../entities/subscription-plan.entity';
import { SubscriptionPlanCode } from '../../entities/types';
import { User } from '../../entities/user.entity';
import { SubscriptionStatus, UserSubscription } from '../../entities/user-subscription.entity';
import { BillingProfileRepository } from './billing-profile.repository';
import { UserSubscriptionRepository } from './user-subscription.repository';

/**
 * The SQL behind "one free trial per organization" and the 7-day trial reminder, run against a
 * real engine (better-sqlite3) so the query builders are proven, not just mocked.
 */
describe('trial scope queries (better-sqlite3)', () => {
    let dataSource: DataSource;
    let subs: UserSubscriptionRepository;
    let profiles: BillingProfileRepository;
    let plan: SubscriptionPlan;
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = '22222222-2222-4222-8222-222222222222';
    const orgA = '33333333-3333-4333-8333-333333333333';

    const makeUser = (username: string, tenantId: string | null) =>
        dataSource
            .getRepository(User)
            .save({ username, slug: username, tenantId } as Partial<User>);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // Users <-> Tenants reference each other; this spec exercises the scope queries, not the
        // tenant bootstrap, so the tenant rows are not created.
        await dataSource.query('PRAGMA foreign_keys = OFF');
        subs = new UserSubscriptionRepository(dataSource.getRepository(UserSubscription));
        profiles = new BillingProfileRepository(dataSource.getRepository(BillingProfile));
        plan = await dataSource.getRepository(SubscriptionPlan).save({
            code: SubscriptionPlanCode.STANDARD,
            displayName: 'Pro',
            maxWorks: 1,
            allowedCadences: [],
            monthlyPrice: '49.00',
            overagePricePerRun: '0.00',
            currency: 'usd',
            active: true,
        } as Partial<SubscriptionPlan>);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('finds a provider subscription held by anyone in the Tenant, and nothing elsewhere', async () => {
        const owner = await makeUser('owner-a', tenantA);
        await makeUser('member-a', tenantA);
        const outsider = await makeUser('outsider-b', tenantB);

        expect(await subs.existsProviderSubscriptionInScope({ tenantId: tenantA })).toBe(false);

        // A free row (no provider id) never counts.
        await dataSource.getRepository(UserSubscription).save({
            userId: outsider.id,
            planCode: SubscriptionPlanCode.STANDARD,
            planId: plan.id,
            status: SubscriptionStatus.ACTIVE,
            currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
            providerSubscriptionId: null,
        } as Partial<UserSubscription>);
        expect(await subs.existsProviderSubscriptionInScope({ tenantId: tenantB })).toBe(false);

        // The owner's cancelled trial, with NO scope stamp on the row: found through users.tenantId.
        await dataSource.getRepository(UserSubscription).save({
            userId: owner.id,
            planCode: SubscriptionPlanCode.STANDARD,
            planId: plan.id,
            status: SubscriptionStatus.CANCELED,
            currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
            providerSubscriptionId: 'sub_owner_trial',
        } as Partial<UserSubscription>);
        expect(await subs.existsProviderSubscriptionInScope({ tenantId: tenantA })).toBe(true);
        expect(await subs.existsProviderSubscriptionInScope({ tenantId: tenantB })).toBe(false);
        expect(await subs.existsProviderSubscriptionInScope({})).toBe(false);
    });

    it('finds an organization-stamped billing profile with a plan subscription', async () => {
        const user = await makeUser('billing-a', null);
        await profiles.ensure({
            userId: user.id,
            provider: 'stripe',
            providerCustomerId: 'cus_a',
            organizationId: orgA,
        });
        expect(await profiles.existsPlanSubscriptionInScope({ organizationIds: [orgA] })).toBe(
            false,
        );
        await profiles.updateSubscriptionState(user.id, {
            providerSubscriptionId: 'sub_a',
            subscriptionStatus: 'trialing',
        });
        expect(await profiles.existsPlanSubscriptionInScope({ organizationIds: [orgA] })).toBe(
            true,
        );
        expect(await profiles.existsPlanSubscriptionInScope({ tenantId: tenantB })).toBe(false);
    });

    it('lists trialing, not-cancelling profiles whose trial ends in the window', async () => {
        const now = new Date('2026-12-23T00:00:00Z');
        const inWindow = new Date('2026-12-29T12:00:00Z');
        const later = new Date('2027-01-10T00:00:00Z');
        const users = await Promise.all(
            ['t-in', 't-late', 't-cancel', 't-active'].map((name) => makeUser(name, null)),
        );
        const rows: Array<[number, string, Date, boolean]> = [
            [0, 'trialing', inWindow, false],
            [1, 'trialing', later, false],
            [2, 'trialing', inWindow, true],
            [3, 'active', inWindow, false],
        ];
        for (const [index, status, end, cancel] of rows) {
            await profiles.ensure({
                userId: users[index].id,
                provider: 'stripe',
                providerCustomerId: `cus_${index}`,
            });
            await profiles.updateSubscriptionState(users[index].id, {
                providerSubscriptionId: `sub_${index}`,
                subscriptionStatus: status as 'trialing' | 'active',
                currentPeriodEnd: end,
                cancelAtPeriodEnd: cancel,
            });
        }
        const found = await profiles.findTrialsEndingBetween(
            new Date(now.getTime() + 6 * 86_400_000),
            new Date(now.getTime() + 7 * 86_400_000),
        );
        expect(found.map((profile) => profile.userId)).toEqual([users[0].id]);
    });
});
