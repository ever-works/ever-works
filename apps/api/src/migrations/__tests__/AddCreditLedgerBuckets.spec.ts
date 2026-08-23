import { DataSource } from 'typeorm';
import { AddCreditLedgerBuckets1786950000000 } from '../1786950000000-AddCreditLedgerBuckets';

/**
 * Credit-ledger buckets + expiry (billing spec §3.2) — migration test on
 * an in-memory better-sqlite3 DataSource (house harness).
 *
 * The load-bearing assertions:
 *  - every pre-existing POSITIVE row becomes a bucket whose
 *    `remainingCredits` reflects what the historical debits already
 *    consumed, replayed FIFO per user (a debit in another user's ledger
 *    never touches this user's buckets);
 *  - debits stay `remainingCredits = NULL`; nothing gets an `expiresAt`;
 *  - the paid tiers receive an explicit `daily-free-credits` row and an
 *    operator-tuned existing row is left alone;
 *  - `up()` is idempotent (second run neither throws nor re-backfills);
 *  - `down()` removes what `up()` added.
 */
describe('AddCreditLedgerBuckets1786950000000', () => {
    let dataSource: DataSource;
    const migration = new AddCreditLedgerBuckets1786950000000();

    const insert = (id: string, userId: string, amount: number, createdAt: string) =>
        dataSource.query(
            `INSERT INTO "credit_ledger_entries" ("id", "userId", "kind", "amountCredits", "balanceAfter", "createdAt")
             VALUES ('${id}', '${userId}', '${amount > 0 ? 'purchase' : 'consumption'}', ${amount}, 0, '${createdAt}')`,
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "credit_ledger_entries" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "kind" varchar(16) NOT NULL,
                "amountCredits" integer NOT NULL,
                "balanceAfter" integer NOT NULL,
                "idempotencyKey" varchar(128),
                "createdAt" datetime NOT NULL
            )
        `);
        await dataSource.query(`
            CREATE TABLE "plan_entitlements" (
                "id" varchar PRIMARY KEY NOT NULL,
                "planId" varchar(64) NOT NULL,
                "key" varchar(64) NOT NULL,
                "valueInt" integer,
                "valueText" varchar(128)
            )
        `);
        // user A: +100, +50, -120, -10 → buckets 0 and 20 remaining.
        await insert('a1', 'A', 100, '2026-07-01 10:00:00');
        await insert('a2', 'A', 50, '2026-07-02 10:00:00');
        await insert('a3', 'A', -120, '2026-07-03 10:00:00');
        await insert('a4', 'A', -10, '2026-07-04 10:00:00');
        // user B: +30 untouched.
        await insert('b1', 'B', 30, '2026-07-01 10:00:00');
        // free plan already seeded by 1783400000000; an operator tuned it.
        await dataSource.query(
            `INSERT INTO "plan_entitlements" ("id", "planId", "key", "valueInt") VALUES ('e1', 'free', 'daily-free-credits', 40)`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("credit_ledger_entries")`,
        );
        return rows.map((r) => r.name);
    }

    async function remaining(): Promise<Record<string, number | null>> {
        const rows: Array<{ id: string; remainingCredits: number | null }> = await dataSource.query(
            `SELECT "id", "remainingCredits" FROM "credit_ledger_entries" ORDER BY "id"`,
        );
        return Object.fromEntries(rows.map((r) => [r.id, r.remainingCredits]));
    }

    it('adds the columns + index and backfills buckets by replaying debits FIFO per user', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        expect(await columnNames()).toEqual(
            expect.arrayContaining(['remainingCredits', 'expiresAt']),
        );
        const indexes: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("credit_ledger_entries")`,
        );
        expect(indexes.map((i) => i.name)).toContain('idx_credit_ledger_user_expires');

        expect(await remaining()).toEqual({
            a1: 0, // fully consumed by the 120 debit
            a2: 20, // 50 − 20 (rest of the 120) − 10
            a3: null,
            a4: null,
            b1: 30, // other user: untouched
        });
        const expiries = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "credit_ledger_entries" WHERE "expiresAt" IS NOT NULL`,
        );
        expect(Number(expiries[0].n)).toBe(0);
    });

    it('seeds daily-free-credits for standard/premium and leaves the tuned free row alone', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        const rows: Array<{ planId: string; valueInt: number }> = await dataSource.query(
            `SELECT "planId", "valueInt" FROM "plan_entitlements" WHERE "key" = 'daily-free-credits' ORDER BY "planId"`,
        );
        expect(rows).toEqual([
            { planId: 'free', valueInt: 40 },
            { planId: 'premium', valueInt: 50 },
            { planId: 'standard', valueInt: 50 },
        ]);
    });

    it('is idempotent: a second up() neither throws nor re-runs the backfill', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        // Simulate a later write that consumed more from a2 after the
        // first application; a naive re-backfill would reset it to 50.
        await dataSource.query(
            `UPDATE "credit_ledger_entries" SET "remainingCredits" = 5 WHERE "id" = 'a2'`,
        );
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await runner.release();

        expect((await remaining()).a2).toBe(5);
        const seeds = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "plan_entitlements" WHERE "key" = 'daily-free-credits'`,
        );
        expect(Number(seeds[0].n)).toBe(3);
    });

    it('down() removes the index and both columns', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);
        await runner.release();

        const names = await columnNames();
        expect(names).not.toContain('remainingCredits');
        expect(names).not.toContain('expiresAt');
    });
});
