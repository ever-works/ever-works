import { DataSource } from 'typeorm';
import { CreateLicencePurchases1787600000000 } from '../1787600000000-CreateLicencePurchases';

describe('CreateLicencePurchases1787600000000', () => {
    let dataSource: DataSource;
    const migration = new CreateLicencePurchases1787600000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates an owner-scoped payment ledger with provider idempotency', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();

        await dataSource.query(
            `INSERT INTO "licence_purchases" ("id", "userId", "planCode", "provider", "providerPaymentId", "amountCents", "currency", "createdAt", "updatedAt")
             VALUES ('l1', 'u1', 'selfhosted_pro', 'stripe', 'pi_1', 9900, 'usd', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        );
        const rows = await dataSource.query(
            `SELECT "userId", "planCode", "providerPaymentId", "status" FROM "licence_purchases"`,
        );
        expect(rows).toEqual([
            {
                userId: 'u1',
                planCode: 'selfhosted_pro',
                providerPaymentId: 'pi_1',
                status: 'active',
            },
        ]);

        await expect(
            dataSource.query(
                `INSERT INTO "licence_purchases" ("id", "userId", "planCode", "provider", "providerPaymentId", "amountCents", "currency", "createdAt", "updatedAt")
                 VALUES ('l2', 'u1', 'selfhosted_pro', 'stripe', 'pi_1', 9900, 'usd', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            ),
        ).rejects.toThrow(/UNIQUE/i);
    });

    it('is idempotent and preserves financial records on down', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await migration.down(runner);
        await runner.release();

        await expect(
            dataSource.query(`SELECT COUNT(*) AS count FROM "licence_purchases"`),
        ).resolves.toEqual([{ count: 0 }]);
    });
});
