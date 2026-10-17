import { DataSource, Table } from 'typeorm';
import { AddTenantEmailAddressVerificationSentAt1795061550000 } from '../1795061550000-AddTenantEmailAddressVerificationSentAt';

/**
 * EW-P4-3 — `tenant_email_addresses.verificationSentAt`. In-memory
 * better-sqlite3 harness, asserting the PHYSICAL schema through `PRAGMA`.
 */
describe('AddTenantEmailAddressVerificationSentAt1795061550000', () => {
    let dataSource: DataSource;
    const migration = new AddTenantEmailAddressVerificationSentAt1795061550000();

    const columns = async (): Promise<
        Array<{ name: string; notnull: number; dflt_value: unknown }>
    > => dataSource.query(`PRAGMA table_info("tenant_email_addresses")`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'tenant_email_addresses',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'address', type: 'varchar', length: '254' },
                    { name: 'verified', type: 'boolean', default: false },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO tenant_email_addresses (id, "userId", address) VALUES (?, ?, ?)`,
            ['addr-1', 'user-1', 'nova@x.test'],
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function run(step: 'up' | 'down'): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration[step](runner);
        await runner.release();
    }

    it('adds a nullable, default-free verificationSentAt; existing rows read NULL (never sent)', async () => {
        await run('up');
        const column = (await columns()).find((c) => c.name === 'verificationSentAt');
        expect(column).toBeDefined();
        expect(column?.notnull).toBe(0);
        expect(column?.dflt_value).toBeNull();
        expect(
            await dataSource.query(`SELECT "verificationSentAt" FROM tenant_email_addresses`),
        ).toEqual([{ verificationSentAt: null }]);
    });

    it('is idempotent and down() removes the column but keeps the rows', async () => {
        await run('up');
        await expect(run('up')).resolves.toBeUndefined();
        expect((await columns()).filter((c) => c.name === 'verificationSentAt')).toHaveLength(1);
        await run('down');
        expect((await columns()).map((c) => c.name)).not.toContain('verificationSentAt');
        expect(await dataSource.query(`SELECT id FROM tenant_email_addresses`)).toEqual([
            { id: 'addr-1' },
        ]);
    });

    it('is a no-op without the table', async () => {
        await dataSource.query(`DROP TABLE tenant_email_addresses`);
        await expect(run('up')).resolves.toBeUndefined();
        await expect(run('down')).resolves.toBeUndefined();
    });
});
