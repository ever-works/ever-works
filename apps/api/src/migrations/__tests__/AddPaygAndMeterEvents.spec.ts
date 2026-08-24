import { DataSource } from 'typeorm';
import { AddPaygAndMeterEvents1786960000000 } from '../1786960000000-AddPaygAndMeterEvents';

/**
 * Pay-as-you-go columns + meter events + enforcement seeds (billing spec
 * §3.5 / §3.7) — migration test on the house in-memory better-sqlite3
 * harness.
 *
 * Load-bearing assertions:
 *  - every pre-existing billing profile reads as "pay-as-you-go OFF"
 *    (`paygEnabled` default false, latch 0) — nothing gets opted in by a
 *    schema change;
 *  - `credit_meter_events` exists with the UNIQUE identifier index (the
 *    idempotency the settlement path and the provider share);
 *  - `credit-limited = 1` is seeded for the three cloud tiers and an
 *    operator-tuned existing row is left alone;
 *  - up() is idempotent, down() removes what up() added.
 */
describe('AddPaygAndMeterEvents1786960000000', () => {
    let dataSource: DataSource;
    const migration = new AddPaygAndMeterEvents1786960000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "billing_profiles" ("id" varchar PRIMARY KEY NOT NULL, "userId" varchar NOT NULL, "provider" varchar NOT NULL, "providerCustomerId" varchar NOT NULL)`,
        );
        await dataSource.query(
            `INSERT INTO "billing_profiles" ("id", "userId", "provider", "providerCustomerId") VALUES ('p1', 'u1', 'stripe', 'cus_1')`,
        );
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(`
            CREATE TABLE "plan_entitlements" (
                "id" varchar PRIMARY KEY NOT NULL,
                "planId" varchar(64) NOT NULL,
                "key" varchar(64) NOT NULL,
                "valueInt" integer,
                "valueText" varchar(128)
            )
        `);
        // An operator already exempted the free plan — the seed must not overwrite it.
        await dataSource.query(
            `INSERT INTO "plan_entitlements" ("id", "planId", "key", "valueInt") VALUES ('e1', 'free', 'credit-limited', 0)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the payg columns with OFF defaults and creates credit_meter_events with its unique identifier', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const rows = await dataSource.query(
            `SELECT "paygEnabled", "paygCapNotifiedPercent", "paygMonthlyCapCredits" FROM "billing_profiles"`,
        );
        expect(rows).toEqual([
            { paygEnabled: 0, paygCapNotifiedPercent: 0, paygMonthlyCapCredits: null },
        ]);

        await dataSource.query(
            `INSERT INTO "credit_meter_events" ("id", "userId", "runId", "identifier", "credits", "writtenOffCredits", "periodStart", "periodEnd", "status", "attempts", "createdAt")
             VALUES ('m1', 'u1', 'r1', 'run:r1', 10, 0, '2026-09-01', '2026-10-01', 'pending', 0, '2026-09-10')`,
        );
        await expect(
            dataSource.query(
                `INSERT INTO "credit_meter_events" ("id", "userId", "runId", "identifier", "credits", "writtenOffCredits", "periodStart", "periodEnd", "status", "attempts", "createdAt")
                 VALUES ('m2', 'u1', 'r1', 'run:r1', 10, 0, '2026-09-01', '2026-10-01', 'pending', 0, '2026-09-10')`,
            ),
        ).rejects.toThrow(/UNIQUE/i);
    });

    it('seeds credit-limited=1 for the cloud tiers, leaving the tuned free row alone', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const rows: Array<{ planId: string; valueInt: number }> = await dataSource.query(
            `SELECT "planId", "valueInt" FROM "plan_entitlements" WHERE "key" = 'credit-limited' ORDER BY "planId"`,
        );
        expect(rows).toEqual([
            { planId: 'free', valueInt: 0 },
            { planId: 'premium', valueInt: 1 },
            { planId: 'standard', valueInt: 1 },
        ]);
    });

    it('is idempotent and down() removes the table and columns', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await migration.down(runner);
        await runner.release();

        const tables = await dataSource.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='credit_meter_events'`,
        );
        expect(tables).toEqual([]);
        const cols: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("billing_profiles")`,
        );
        expect(cols.map((c) => c.name)).not.toContain('paygEnabled');
    });
});
