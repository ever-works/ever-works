import { DataSource } from 'typeorm';
import { ModelAccount } from '@src/entities/model-account.entity';
import { PluginUsageCapability, PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';
import { ENTITIES } from '../_entities-inventory';
import { ModelAccountRepository } from './model-account.repository';
import { PluginUsageRepository } from './plugin-usage.repository';

/**
 * Model accounts (AW-16) — the two reads run-cost settlement uses to exempt
 * spend a workspace's own Model Account served, executed against a real
 * (in-memory better-sqlite3) database: the `metadata` JSON column must be read
 * back as an object on this driver too, and the ownership lookup must return
 * the workspace and provider without reading credentials.
 */
describe('Model Account spend reads (integration)', () => {
    let dataSource: DataSource;
    let usage: PluginUsageRepository;
    let accounts: ModelAccountRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const RUN = '44444444-4444-4444-8444-444444444444';
    const OTHER_RUN = '55555555-5555-4555-8555-555555555555';
    const ACCOUNT_A = '66666666-6666-4666-8666-666666666666';
    const ACCOUNT_B = '77777777-7777-4777-8777-777777777777';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        // Read specs: no query under test joins to a parent table (see
        // costs-aggregations.integration.spec.ts for the same reasoning).
        await dataSource.query('PRAGMA foreign_keys = OFF');
        usage = new PluginUsageRepository(dataSource.getRepository(PluginUsageEvent));
        accounts = new ModelAccountRepository(dataSource.getRepository(ModelAccount));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(PluginUsageEvent).clear();
        await dataSource.getRepository(ModelAccount).clear();
    });

    function seedEvent(overrides: Partial<PluginUsageEvent>): Promise<PluginUsageEvent> {
        const repository = dataSource.getRepository(PluginUsageEvent);
        return repository.save(
            repository.create({
                userId: USER,
                workId: WORK,
                pluginId: 'openrouter',
                capability: PluginUsageCapability.AI,
                units: 1,
                costCents: 0,
                currency: 'usd',
                runId: RUN,
                occurredAt: new Date('2026-09-10T12:00:00.000Z'),
                ...overrides,
            } as Partial<PluginUsageEvent>),
        );
    }

    it('sums a run’s costed rows per (plugin, Model Account) and ignores everything else', async () => {
        await seedEvent({ costCents: 10, metadata: { modelAccountId: ACCOUNT_A } });
        await seedEvent({ costCents: 15, metadata: { modelAccountId: ACCOUNT_A, operation: 'x' } });
        await seedEvent({ costCents: 7, metadata: { modelAccountId: ACCOUNT_B } });
        await seedEvent({
            pluginId: 'anthropic',
            costCents: 4,
            metadata: { modelAccountId: ACCOUNT_A },
        });
        // Platform-credential call, zero-cost account call, another run.
        await seedEvent({ costCents: 99, metadata: { operation: 'askJson' } });
        await seedEvent({ costCents: 50, metadata: null });
        await seedEvent({ costCents: 0, metadata: { modelAccountId: ACCOUNT_B } });
        await seedEvent({
            runId: OTHER_RUN,
            costCents: 30,
            metadata: { modelAccountId: ACCOUNT_A },
        });

        const rows = await usage.getRunCostByModelAccount(RUN);

        expect(
            rows.sort((a, b) =>
                `${a.pluginId}${a.modelAccountId}`.localeCompare(
                    `${b.pluginId}${b.modelAccountId}`,
                ),
            ),
        ).toEqual([
            { pluginId: 'anthropic', modelAccountId: ACCOUNT_A, costCents: 4 },
            { pluginId: 'openrouter', modelAccountId: ACCOUNT_A, costCents: 25 },
            { pluginId: 'openrouter', modelAccountId: ACCOUNT_B, costCents: 7 },
        ]);
        // The per-plugin rollup settlement already used is unchanged by this.
        expect(await usage.getRunCostByPlugin(RUN)).toEqual(
            expect.arrayContaining([
                { pluginId: 'openrouter', costCents: 181 },
                { pluginId: 'anthropic', costCents: 4 },
            ]),
        );
    });

    it('returns the workspace and provider of each existing account id, dropping unknown and malformed ids', async () => {
        const repository = dataSource.getRepository(ModelAccount);
        await repository.save(
            repository.create({
                id: ACCOUNT_A,
                userId: USER,
                workspaceKey: `user:${USER}`,
                providerPluginId: 'openrouter',
                label: 'Main',
                position: 1,
            }),
        );

        const found = await accounts.findOwnershipByIds([ACCOUNT_A, ACCOUNT_B, 'not-a-uuid']);

        expect(found).toEqual([
            { id: ACCOUNT_A, workspaceKey: `user:${USER}`, providerPluginId: 'openrouter' },
        ]);
        await expect(accounts.findOwnershipByIds([])).resolves.toEqual([]);
        await expect(accounts.findOwnershipByIds(['not-a-uuid'])).resolves.toEqual([]);
    });
});
