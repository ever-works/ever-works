import { DataSource } from 'typeorm';
import { AddUserSubscriptionTrialEndsAt1795020000000 } from '../1795020000000-AddUserSubscriptionTrialEndsAt';

/**
 * `user_subscriptions.trialEndsAt` — migration test on the house in-memory better-sqlite3 harness.
 * Load-bearing: existing rows read NULL, so their allowance anchor (`createdAt`) does not move.
 */
describe('AddUserSubscriptionTrialEndsAt1795020000000', () => {
    let dataSource: DataSource;
    const migration = new AddUserSubscriptionTrialEndsAt1795020000000();

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

    const columns = async (): Promise<string[]> =>
        (await dataSource.query(`PRAGMA table_info("user_subscriptions")`)).map(
            (r: { name: string }) => r.name,
        );

    it('adds the column and leaves existing rows NULL', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
        expect(await columns()).toContain('trialEndsAt');
        expect(await dataSource.query(`SELECT "trialEndsAt" FROM "user_subscriptions"`)).toEqual([
            { trialEndsAt: null },
        ]);
    });

    it('is idempotent, and down() removes it', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner);
        await migration.down(runner);
        await runner.release();
        expect(await columns()).not.toContain('trialEndsAt');
    });
});
