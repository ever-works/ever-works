import { DataSource } from 'typeorm';
import { ModelAccount } from '@src/entities/model-account.entity';
import { ENTITIES } from '../_entities-inventory';
import { ModelAccountRepository } from './model-account.repository';

/**
 * Model accounts (AW-16) — the periodic health check's "what is due" read,
 * executed against a real (in-memory better-sqlite3) database: the explicit
 * NULLS FIRST order must be valid SQL on this driver too, and a small limit
 * must still reach accounts that were never checked ahead of overdue ones.
 */
describe('ModelAccountRepository.listDueForCheck (integration)', () => {
    let dataSource: DataSource;
    let accounts: ModelAccountRepository;

    const USER = '11111111-1111-4111-8111-111111111111';
    const NOW = new Date('2026-09-14T12:00:00.000Z');
    const CUTOFF = new Date(NOW.getTime() - 6 * 3600_000);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        accounts = new ModelAccountRepository(dataSource.getRepository(ModelAccount));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(ModelAccount).clear();
    });

    let seq = 0;
    function seed(label: string, lastCheckedAt: Date | null, enabled = true) {
        seq += 1;
        const repository = dataSource.getRepository(ModelAccount);
        return repository.save(
            repository.create({
                userId: USER,
                workspaceKey: `user:${USER}`,
                providerPluginId: 'provider-a',
                label,
                position: seq,
                enabled,
                lastCheckedAt,
            }),
        );
    }

    it('returns never-checked accounts before overdue ones when the limit is tight', async () => {
        await seed('overdue oldest', new Date(NOW.getTime() - 48 * 3600_000));
        await seed('overdue', new Date(NOW.getTime() - 24 * 3600_000));
        await seed('never checked', null);
        await seed('fresh', new Date(NOW.getTime() - 3600_000));
        await seed('paused, never checked', null, false);

        const firstTwo = await accounts.listDueForCheck(CUTOFF, 2);
        expect(firstTwo.map((row) => row.label)).toEqual(['never checked', 'overdue oldest']);

        const all = await accounts.listDueForCheck(CUTOFF, 10);
        expect(all.map((row) => row.label)).toEqual(['never checked', 'overdue oldest', 'overdue']);
    });
});
