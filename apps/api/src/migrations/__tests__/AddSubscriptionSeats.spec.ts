import { DataSource } from 'typeorm';
import { AddSubscriptionSeats1786970000000 } from '../1786970000000-AddSubscriptionSeats';

/**
 * Seats on the subscription row (billing spec §3.6 / FR-26) — migration test
 * on the house in-memory better-sqlite3 harness.
 *
 * The load-bearing assertion is that pre-existing rows read as NULL, not 0.
 * Readers treat NULL as "fall back to the plan's `seatsIncluded`"; a 0 would
 * read as "no seats allowed" and lock every existing paying customer out of
 * inviting anybody.
 */
describe('AddSubscriptionSeats1786970000000', () => {
    let dataSource: DataSource;
    const migration = new AddSubscriptionSeats1786970000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "user_subscriptions" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "planCode" varchar NOT NULL, "status" varchar NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "user_subscriptions" ("id", "userId", "planCode", "status") VALUES ('s1', 'u1', 'standard', 'active')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("user_subscriptions")`,
        );
        return rows.map((r) => r.name);
    }

    it('adds both columns and leaves existing rows NULL (never 0)', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        expect(await columnNames()).toEqual(
            expect.arrayContaining(['seats', 'providerSeatItemId']),
        );
        const rows = await dataSource.query(
            `SELECT "seats", "providerSeatItemId" FROM "user_subscriptions"`,
        );
        expect(rows).toEqual([{ seats: null, providerSeatItemId: null }]);
    });

    it('is idempotent, and down() removes both columns', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await migration.down(runner);
        await runner.release();

        const names = await columnNames();
        expect(names).not.toContain('seats');
        expect(names).not.toContain('providerSeatItemId');
    });
});
