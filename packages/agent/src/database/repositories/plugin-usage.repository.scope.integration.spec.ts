import { DataSource } from 'typeorm';
import { PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { ENTITIES } from '../_entities-inventory';
import { PluginUsageRepository } from './plugin-usage.repository';

/**
 * Home (AW-19) — the spend headline follows the active workspace scope, while
 * budget enforcement and the account-wide surfaces keep summing every scope.
 * Both halves are pinned here against better-sqlite3 so the ownership
 * predicate is the real SQL.
 */
describe('PluginUsageRepository — scoped spend (integration)', () => {
    let dataSource: DataSource;
    let usage: PluginUsageRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';
    const TENANT = '99999999-9999-4999-8999-999999999999';
    const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const WORK = '33333333-3333-4333-8333-333333333333';

    const FROM = new Date('2026-09-01T00:00:00.000Z');
    const TO = new Date('2026-09-08T00:00:00.000Z');
    const INSIDE = new Date('2026-09-05T12:00:00.000Z');

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        usage = new PluginUsageRepository(dataSource.getRepository(PluginUsageEvent));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(PluginUsageEvent).clear();
    });

    function seed(costCents: number, overrides: Partial<PluginUsageEvent> = {}) {
        const repository = dataSource.getRepository(PluginUsageEvent);
        return repository.save(
            repository.create({
                workId: WORK,
                userId: USER,
                pluginId: 'provider',
                capability: 'ai',
                units: 1,
                costCents,
                currency: 'usd',
                tenantId: TENANT,
                organizationId: null,
                occurredAt: INSIDE,
                ...overrides,
            } as Partial<PluginUsageEvent>),
        );
    }

    async function seedThreeScopes() {
        await seed(100, { organizationId: ORG_A });
        await seed(250, { organizationId: ORG_A });
        await seed(40, { organizationId: ORG_B });
        await seed(7, { organizationId: null });
        await seed(1000, { userId: OTHER_USER, organizationId: ORG_A });
        await seed(500, {
            organizationId: ORG_A,
            occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        });
    }

    it('sums only the Organization that is active', async () => {
        await seedThreeScopes();

        await expect(
            usage.getTotalSpendCentsForUser(USER, FROM, TO, undefined, {
                tenantId: TENANT,
                organizationId: ORG_A,
            }),
        ).resolves.toBe(350);
        await expect(
            usage.getTotalSpendCentsForUser(USER, FROM, TO, undefined, {
                tenantId: TENANT,
                organizationId: ORG_B,
            }),
        ).resolves.toBe(40);
    });

    it('sums only personal usage in personal scope', async () => {
        await seedThreeScopes();

        await expect(
            usage.getTotalSpendCentsForUser(USER, FROM, TO, undefined, {
                tenantId: TENANT,
                organizationId: null,
            }),
        ).resolves.toBe(7);
    });

    it('keeps the unchanged user-wide total when no scope is given', async () => {
        await seedThreeScopes();

        await expect(usage.getTotalSpendCentsForUser(USER, FROM, TO)).resolves.toBe(397);
        await expect(usage.getTotalSpendCentsForUser(USER, FROM, TO, 'usd')).resolves.toBe(397);
    });

    it('reports an Organization with no usage as zero, not as missing', async () => {
        await seed(100, { organizationId: ORG_A });

        await expect(
            usage.getTotalSpendCentsForUser(USER, FROM, TO, undefined, {
                tenantId: TENANT,
                organizationId: ORG_B,
            }),
        ).resolves.toBe(0);
    });

    it('knows whether the account has ever recorded usage, in any scope', async () => {
        await expect(usage.hasAnyUsageForUser(USER)).resolves.toBe(false);

        await seed(0, { organizationId: ORG_B, occurredAt: new Date('2025-01-01T00:00:00.000Z') });

        await expect(usage.hasAnyUsageForUser(USER)).resolves.toBe(true);
        await expect(usage.hasAnyUsageForUser(OTHER_USER)).resolves.toBe(false);
    });
});
