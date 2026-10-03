import { DataSource } from 'typeorm';
import { CreateStripeRelayDeadLetters1791251000000 } from '../1791251000000-CreateStripeRelayDeadLetters';

describe('CreateStripeRelayDeadLetters1791251000000', () => {
    let dataSource: DataSource;
    const migration = new CreateStripeRelayDeadLetters1791251000000();

    const insert = (id: string, eventId: string) =>
        dataSource.query(
            `INSERT INTO "stripe_relay_dead_letters" ("id", "eventId", "eventType", "workId", "disposition", "reason", "payload", "firstFailedAt", "lastFailedAt", "createdAt", "updatedAt")
             VALUES ('${id}', '${eventId}', 'invoice.payment_succeeded', 'work-1', 'retry', 'site_404', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates one row per Stripe event with open/attempt defaults', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        await insert('d1', 'evt_1');
        const rows = await dataSource.query(
            `SELECT "eventId", "status", "attempts", "livemode", "resolution", "resolvedAt", "siteStatus" FROM "stripe_relay_dead_letters"`,
        );
        expect(rows).toEqual([
            {
                eventId: 'evt_1',
                status: 'open',
                attempts: 1,
                livemode: 0,
                resolution: null,
                resolvedAt: null,
                siteStatus: null,
            },
        ]);

        // The UNIQUE index is what keeps Stripe's retries on ONE row.
        await expect(insert('d2', 'evt_1')).rejects.toThrow(/UNIQUE/i);
    });

    it('declares the lookup and alert indexes', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        const table = await runner.getTable('stripe_relay_dead_letters');
        await runner.release();

        const indices = (table?.indices ?? []).map((index) => ({
            name: index.name,
            columns: index.columnNames,
            unique: index.isUnique,
        }));
        expect(indices).toEqual(
            expect.arrayContaining([
                {
                    name: 'idx_stripe_relay_dead_letters_event',
                    columns: ['eventId'],
                    unique: true,
                },
                {
                    name: 'idx_stripe_relay_dead_letters_status_failed',
                    columns: ['status', 'lastFailedAt'],
                    unique: false,
                },
            ]),
        );
    });

    it('is idempotent and keeps the rows on down', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await insert('d1', 'evt_1');
        await migration.down(runner);
        await runner.release();

        await expect(
            dataSource.query(`SELECT COUNT(*) AS count FROM "stripe_relay_dead_letters"`),
        ).resolves.toEqual([{ count: 1 }]);
    });
});
