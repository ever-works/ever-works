import { DataSource } from 'typeorm';
import { AddPlanHostingSeatsAndCredits1786940000000 } from '../1786940000000-AddPlanHostingSeatsAndCredits';

describe('AddPlanHostingSeatsAndCredits1786940000000', () => {
    let dataSource: DataSource;
    const migration = new AddPlanHostingSeatsAndCredits1786940000000();

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

    async function createBaseTable(): Promise<void> {
        await dataSource.query(
            `CREATE TABLE "subscription_plans" ("id" varchar PRIMARY KEY NOT NULL, "code" varchar NOT NULL UNIQUE)`,
        );
        await dataSource.query(
            `INSERT INTO "subscription_plans" ("id", "code") VALUES ('plan-1', 'free')`,
        );
    }

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("subscription_plans")`,
        );
        return rows.map((row) => row.name);
    }

    it('fails loudly when its prerequisite subscription_plans table is absent', async () => {
        const runner = dataSource.createQueryRunner();

        await expect(migration.up(runner)).rejects.toThrow(
            'Cannot add plan hosting, seats, and credits: prerequisite table "subscription_plans" does not exist',
        );

        await runner.release();
    });

    it('adds all six columns with backward-compatible defaults for existing plans', async () => {
        await createBaseTable();
        const runner = dataSource.createQueryRunner();

        await migration.up(runner);
        await runner.release();

        expect(await columnNames()).toEqual(
            expect.arrayContaining([
                'hosting',
                'annualPrice',
                'lifetimePrice',
                'seatsIncluded',
                'seatMonthlyPrice',
                'monthlyCredits',
            ]),
        );
        const [existing] = await dataSource.query(
            `SELECT "hosting", "annualPrice", "lifetimePrice", "seatsIncluded", "seatMonthlyPrice", "monthlyCredits" FROM "subscription_plans" WHERE "id" = 'plan-1'`,
        );
        expect(existing).toEqual({
            hosting: 'cloud',
            annualPrice: 0,
            lifetimePrice: null,
            seatsIncluded: null,
            seatMonthlyPrice: null,
            monthlyCredits: 0,
        });
    });

    it('is idempotent when all guarded columns already exist', async () => {
        await createBaseTable();
        const runner = dataSource.createQueryRunner();

        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await runner.release();

        expect((await columnNames()).filter((name) => name === 'hosting')).toHaveLength(1);
        expect((await columnNames()).filter((name) => name === 'monthlyCredits')).toHaveLength(1);
    });

    it('keeps down tolerant and removes every added column', async () => {
        await createBaseTable();
        const runner = dataSource.createQueryRunner();

        await migration.up(runner);
        await migration.down(runner);
        await runner.release();

        expect(await columnNames()).toEqual(['id', 'code']);

        const emptyRunner = dataSource.createQueryRunner();
        await dataSource.query(`DROP TABLE "subscription_plans"`);
        await expect(migration.down(emptyRunner)).resolves.toBeUndefined();
        await emptyRunner.release();
    });
});
