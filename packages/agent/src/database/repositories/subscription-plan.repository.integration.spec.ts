import { DataSource } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { SubscriptionPlan } from '../../entities/subscription-plan.entity';
import { SubscriptionPlanCode, WorkScheduleCadence } from '../../entities/types';
import { SubscriptionPlanRepository } from './subscription-plan.repository';

describe('SubscriptionPlanRepository — concurrent seeding (better-sqlite3)', () => {
    let dataSource: DataSource;
    let plans: SubscriptionPlanRepository;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        plans = new SubscriptionPlanRepository(dataSource.getRepository(SubscriptionPlan));
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('lets simultaneous boot seeders converge on one row and update it in place', async () => {
        const seed = {
            code: SubscriptionPlanCode.FREE,
            displayName: 'Free',
            maxWorks: 1,
            allowedCadences: [WorkScheduleCadence.DAILY],
            monthlyPrice: '0.00',
            overagePricePerRun: '0.00',
            currency: 'usd',
            active: true,
        };

        const seeded = await Promise.all(Array.from({ length: 20 }, () => plans.upsert(seed)));
        const originalId = seeded[0].id;

        expect(new Set(seeded.map((plan) => plan.id))).toEqual(new Set([originalId]));
        expect(await dataSource.getRepository(SubscriptionPlan).count()).toBe(1);

        const updated = await plans.upsert({ ...seed, displayName: 'Free forever', maxWorks: 2 });
        expect(updated).toMatchObject({
            id: originalId,
            code: SubscriptionPlanCode.FREE,
            displayName: 'Free forever',
            maxWorks: 2,
        });
        expect(await dataSource.getRepository(SubscriptionPlan).count()).toBe(1);
    });
});
