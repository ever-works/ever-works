import { DataSource } from 'typeorm';
import { AddBillingSubscriptionLifecycleColumns1784720000000 } from '../1784720000000-AddBillingSubscriptionLifecycleColumns';

/**
 * Subscription lifecycle columns (audit B07/B08) — migration test on an
 * in-memory better-sqlite3 DataSource (same harness as
 * `AddRunSteeringColumns.spec.ts`).
 *
 * The load-bearing assertion is the `cancelAtPeriodEnd` DEFAULT: every
 * pre-existing billing profile must read as "no cancellation pending".
 * A NULL there would make the Billing page offer `Resume` on an account
 * that never asked to cancel.
 */
describe('AddBillingSubscriptionLifecycleColumns1784720000000 (audit B07/B08)', () => {
    let dataSource: DataSource;
    const migration = new AddBillingSubscriptionLifecycleColumns1784720000000();

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
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("billing_profiles")`,
        );
        return rows.map((r) => r.name);
    }

    it('adds the five lifecycle columns', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        expect(await columnNames()).toEqual(
            expect.arrayContaining([
                'providerSubscriptionId',
                'subscriptionStatus',
                'cancelAtPeriodEnd',
                'currentPeriodEnd',
                'subscriptionCanceledAt',
            ]),
        );
    });

    it('⭐ every pre-existing profile reads as "no subscription, nothing pending"', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        await dataSource.query(
            `INSERT INTO "billing_profiles" ("id", "userId", "provider", "providerCustomerId") VALUES ('bp-1', 'u1', 'stripe', 'cus_1')`,
        );
        const [row] = await dataSource.query(
            `SELECT "providerSubscriptionId", "subscriptionStatus", "cancelAtPeriodEnd", "currentPeriodEnd" FROM "billing_profiles" WHERE "id" = 'bp-1'`,
        );

        expect(row.providerSubscriptionId).toBeNull();
        // NULL status is read by the service as `none` — a free account,
        // not a broken one.
        expect(row.subscriptionStatus).toBeNull();
        expect(row.currentPeriodEnd).toBeNull();
        // sqlite renders booleans as 0/1; both drivers must read "not pending".
        expect(Boolean(row.cancelAtPeriodEnd)).toBe(false);
    });

    it('is idempotent — running up() twice does not throw or duplicate columns', async () => {
        const r1 = dataSource.createQueryRunner();
        await migration.up(r1);
        await r1.release();

        const r2 = dataSource.createQueryRunner();
        await expect(migration.up(r2)).resolves.toBeUndefined();
        await r2.release();

        const cols = await columnNames();
        expect(cols.filter((c) => c === 'cancelAtPeriodEnd')).toHaveLength(1);
        expect(cols.filter((c) => c === 'subscriptionStatus')).toHaveLength(1);
    });

    it('down() drops all five columns', async () => {
        const up = dataSource.createQueryRunner();
        await migration.up(up);
        await up.release();

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();

        const cols = await columnNames();
        for (const col of [
            'providerSubscriptionId',
            'subscriptionStatus',
            'cancelAtPeriodEnd',
            'currentPeriodEnd',
            'subscriptionCanceledAt',
        ]) {
            expect(cols).not.toContain(col);
        }
    });
});
