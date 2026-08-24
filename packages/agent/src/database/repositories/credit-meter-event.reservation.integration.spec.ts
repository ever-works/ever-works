import { DataSource, Repository } from 'typeorm';
import { BillingProfile } from '@src/entities/billing-profile.entity';
import { CreditMeterEvent, CreditMeterEventStatus } from '@src/entities/credit-meter-event.entity';
import { CreditMeterEventRepository } from './credit-meter-event.repository';

describe('CreditMeterEventRepository — cap reservation (integration)', () => {
    let dataSource: DataSource;
    let repository: CreditMeterEventRepository;
    let events: Repository<CreditMeterEvent>;
    let profiles: Repository<BillingProfile>;

    const USER = '11111111-1111-4111-8111-111111111111';
    const START = new Date('2026-09-01T00:00:00.000Z');
    const END = new Date('2026-10-01T00:00:00.000Z');

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [BillingProfile, CreditMeterEvent],
            synchronize: true,
        });
        await dataSource.initialize();
        events = dataSource.getRepository(CreditMeterEvent);
        profiles = dataSource.getRepository(BillingProfile);
        repository = new CreditMeterEventRepository(events);
    });

    afterAll(async () => dataSource.destroy());

    beforeEach(async () => {
        await events.clear();
        await profiles.clear();
        await profiles.save(
            profiles.create({
                userId: USER,
                provider: 'stripe',
                providerCustomerId: 'cus_1',
                autoRechargeEnabled: false,
                autoRechargeFailureCount: 0,
                cancelAtPeriodEnd: false,
                paygEnabled: true,
                paygCapNotifiedPercent: 0,
            }),
        );
        await repository.insertIdempotent({
            userId: USER,
            runId: '22222222-2222-4222-8222-222222222222',
            identifier: 'run:seed',
            credits: 450,
            writtenOffCredits: 0,
            periodStart: START,
            periodEnd: END,
        });
    });

    it('reserves only the remaining aggregate headroom and reports the overflow as written off', async () => {
        const reserve = (repository as any).reserveIdempotentWithinCap?.bind(repository);
        const result = await reserve?.({
            write: {
                userId: USER,
                runId: '33333333-3333-4333-8333-333333333333',
                identifier: 'run:next',
                periodStart: START,
                periodEnd: END,
            },
            requestedCredits: 100,
            capCredits: 500,
        });

        expect(result).toMatchObject({
            status: 'created',
            usedCreditsAfter: 500,
            event: {
                credits: 50,
                writtenOffCredits: 50,
                status: CreditMeterEventStatus.PENDING,
            },
        });
        expect(await repository.sumCreditsForPeriod(USER, START, END)).toBe(500);
    });

    it('creates no billable event after the cap is exhausted', async () => {
        await events.save(
            events.create({
                userId: USER,
                runId: '33333333-3333-4333-8333-333333333333',
                identifier: 'run:fill',
                credits: 50,
                writtenOffCredits: 0,
                periodStart: START,
                periodEnd: END,
                status: CreditMeterEventStatus.PENDING,
                attempts: 0,
            }),
        );
        const reserve = (repository as any).reserveIdempotentWithinCap?.bind(repository);

        await expect(
            reserve?.({
                write: {
                    userId: USER,
                    runId: '44444444-4444-4444-8444-444444444444',
                    identifier: 'run:blocked',
                    periodStart: START,
                    periodEnd: END,
                },
                requestedCredits: 25,
                capCredits: 500,
            }),
        ).resolves.toEqual({
            status: 'cap-exhausted',
            billedCredits: 0,
            writtenOffCredits: 25,
            usedCreditsAfter: 500,
            event: null,
        });
        expect(await events.findOneBy({ identifier: 'run:blocked' })).toBeNull();
    });
});
