import { DataSource, Table } from 'typeorm';
import { GrandfatherInUseEmailAddressesVerified1795061540000 } from '../1795061540000-GrandfatherInUseEmailAddressesVerified';

/**
 * EW-P4-3 — addresses already in use are grandfathered as verified before the
 * send path starts refusing unverified senders; unused ones are not.
 * In-memory better-sqlite3 harness, like the sibling migration specs.
 */
describe('GrandfatherInUseEmailAddressesVerified1795061540000', () => {
    let dataSource: DataSource;
    const migration = new GrandfatherInUseEmailAddressesVerified1795061540000();

    async function create(withInboxes = true): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await runner.createTable(
            new Table({
                name: 'tenant_email_addresses',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'verified', type: 'boolean', default: false },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'agent_email_assignments',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'emailAddressId', type: 'varchar' },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'email_messages',
                columns: [
                    { name: 'id', type: 'varchar', isPrimary: true },
                    { name: 'emailAddressId', type: 'varchar' },
                    { name: 'direction', type: 'varchar', length: '16' },
                ],
            }),
        );
        if (withInboxes) {
            await runner.createTable(
                new Table({
                    name: 'agent_inboxes',
                    columns: [
                        { name: 'id', type: 'varchar', isPrimary: true },
                        { name: 'emailAddressId', type: 'varchar', isNullable: true },
                    ],
                }),
            );
        }
        const ids = ['assigned', 'sent', 'pinned', 'only-inbound-mail', 'unused', 'already'];
        for (const id of ids) {
            await runner.query(`INSERT INTO tenant_email_addresses (id, verified) VALUES (?, ?)`, [
                id,
                id === 'already' ? 1 : 0,
            ]);
        }
        await runner.query(`INSERT INTO agent_email_assignments VALUES (?, ?)`, ['a1', 'assigned']);
        await runner.query(`INSERT INTO email_messages VALUES (?, ?, ?)`, [
            'm1',
            'sent',
            'outbound',
        ]);
        await runner.query(`INSERT INTO email_messages VALUES (?, ?, ?)`, [
            'm2',
            'only-inbound-mail',
            'inbound',
        ]);
        if (withInboxes) {
            await runner.query(`INSERT INTO agent_inboxes VALUES (?, ?)`, ['i1', 'pinned']);
            await runner.query(`INSERT INTO agent_inboxes VALUES (?, ?)`, ['i2', null]);
        }
        await runner.release();
    }

    async function verifiedIds(): Promise<string[]> {
        const rows: Array<{ id: string }> = await dataSource.query(
            `SELECT id FROM tenant_email_addresses WHERE verified = 1 ORDER BY id`,
        );
        return rows.map((row) => row.id);
    }

    async function up(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

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

    it('verifies assigned, already-sending and pinned addresses only', async () => {
        await create();
        await up();
        expect(await verifiedIds()).toEqual(['already', 'assigned', 'pinned', 'sent']);
    });

    it('is idempotent', async () => {
        await create();
        await up();
        await expect(up()).resolves.toBeUndefined();
        expect(await verifiedIds()).toEqual(['already', 'assigned', 'pinned', 'sent']);
    });

    it('skips a source table that does not exist', async () => {
        await create(false);
        await up();
        expect(await verifiedIds()).toEqual(['already', 'assigned', 'sent']);
    });

    it('is a no-op without the addresses table, and down() never un-verifies', async () => {
        await expect(up()).resolves.toBeUndefined();
        await create();
        await up();
        await migration.down();
        expect(await verifiedIds()).toEqual(['already', 'assigned', 'pinned', 'sent']);
    });
});
