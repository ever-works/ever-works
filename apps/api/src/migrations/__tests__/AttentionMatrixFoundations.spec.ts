import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataSource, Table, TableForeignKey } from 'typeorm';
import { AttentionMatrixFoundations1791141300000 } from '../1791141300000-AttentionMatrixFoundations';

/**
 * Same in-memory better-sqlite3 harness as the sibling migration specs. What
 * matters: existing notifications read as interrupting, existing delivery log
 * rows survive with their channel, a built-in delivery can be recorded
 * without one, re-running is a no-op, `down()` never deletes a row, and the
 * migration contains nothing destructive.
 */
describe('AttentionMatrixFoundations1791141300000', () => {
    let dataSource: DataSource;
    const migration = new AttentionMatrixFoundations1791141300000();

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
                name: 'notifications',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'varchar' },
                    { name: 'title', type: 'varchar', length: '200' },
                    { name: 'isRead', type: 'boolean', default: false },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'notification_channels',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'notification_channel_delivery_log',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'channelId', type: 'uuid' },
                    { name: 'messageRef', type: 'varchar', length: '120' },
                    { name: 'status', type: 'varchar', length: '16' },
                    { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
        );
        await runner.createForeignKey(
            'notification_channel_delivery_log',
            new TableForeignKey({
                columnNames: ['channelId'],
                referencedTableName: 'notification_channels',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
        await runner.query(
            `INSERT INTO notifications (id, "userId", title, "isRead") VALUES (?, ?, ?, ?)`,
            ['n-1', 'user-1', 'Agent needs a decision', 0],
        );
        await runner.query(`INSERT INTO notification_channels (id, "userId") VALUES (?, ?)`, [
            'ch-1',
            'user-1',
        ]);
        await runner.query(
            `INSERT INTO notification_channel_delivery_log (id, "channelId", "messageRef", status) VALUES (?, ?, ?, ?)`,
            ['log-1', 'ch-1', 'ref-1', 'delivered'],
        );
        await runner.release();
    });

    afterEach(async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
    });

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function runDown(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    }

    async function table(name: string) {
        const runner = dataSource.createQueryRunner();
        const t = await runner.getTable(name);
        await runner.release();
        return t;
    }

    it('adds isSilent defaulting to false, so every existing notification still interrupts', async () => {
        await runUp();
        const notifications = await table('notifications');
        expect(notifications?.findColumnByName('isSilent')).toMatchObject({ isNullable: false });
        expect(
            notifications?.indices.some((i) => i.name === 'idx_notifications_user_silent_read'),
        ).toBe(true);
        const [row] = await dataSource.query(`SELECT "isSilent" FROM notifications WHERE id = ?`, [
            'n-1',
        ]);
        expect(Boolean(row.isSilent)).toBe(false);
    });

    it('widens the delivery log for built-in targets and keeps existing rows and the channel link', async () => {
        await runUp();
        const log = await table('notification_channel_delivery_log');
        expect(log?.findColumnByName('channelId')).toMatchObject({ isNullable: true });
        expect(log?.findColumnByName('builtInChannel')).toMatchObject({ isNullable: true });
        expect(log?.findColumnByName('userId')).toMatchObject({ isNullable: true });
        expect(log?.indices.some((i) => i.name === 'idx_ncdl_user_created')).toBe(true);
        expect(
            log?.foreignKeys.some((fk) => fk.referencedTableName === 'notification_channels'),
        ).toBe(true);

        expect(
            await dataSource.query(
                `SELECT id, "channelId" FROM notification_channel_delivery_log WHERE id = ?`,
                ['log-1'],
            ),
        ).toEqual([{ id: 'log-1', channelId: 'ch-1' }]);

        await dataSource.query(
            `INSERT INTO notification_channel_delivery_log (id, "channelId", "builtInChannel", "userId", "messageRef", status) VALUES (?, NULL, ?, ?, ?, ?)`,
            ['log-2', 'email', 'user-1', 'ref-2', 'delivered'],
        );
        const [builtIn] = await dataSource.query(
            `SELECT "channelId", "builtInChannel" FROM notification_channel_delivery_log WHERE id = ?`,
            ['log-2'],
        );
        expect(builtIn).toEqual({ channelId: null, builtInChannel: 'email' });
    });

    it('is idempotent on re-run', async () => {
        await runUp();
        await runUp();
        const log = await table('notification_channel_delivery_log');
        expect(log?.columns.filter((c) => c.name === 'userId')).toHaveLength(1);
        const notifications = await table('notifications');
        expect(notifications?.columns.filter((c) => c.name === 'isSilent')).toHaveLength(1);
    });

    it('reverses cleanly when no built-in delivery was recorded', async () => {
        await runUp();
        await runDown();
        const log = await table('notification_channel_delivery_log');
        expect(log?.findColumnByName('channelId')).toMatchObject({ isNullable: false });
        expect(log?.findColumnByName('builtInChannel')).toBeUndefined();
        expect(log?.findColumnByName('userId')).toBeUndefined();
        expect((await table('notifications'))?.findColumnByName('isSilent')).toBeUndefined();
        await runDown();
    });

    it('never deletes a built-in delivery row on the way down', async () => {
        await runUp();
        await dataSource.query(
            `INSERT INTO notification_channel_delivery_log (id, "channelId", "builtInChannel", "messageRef", status) VALUES (?, NULL, ?, ?, ?)`,
            ['log-3', 'email', 'ref-3', 'failed'],
        );
        await runDown();
        const log = await table('notification_channel_delivery_log');
        expect(log?.findColumnByName('channelId')).toMatchObject({ isNullable: true });
        expect(log?.findColumnByName('builtInChannel')).toBeDefined();
        expect(
            await dataSource.query(
                `SELECT id FROM notification_channel_delivery_log WHERE id = ?`,
                ['log-3'],
            ),
        ).toEqual([{ id: 'log-3' }]);
    });

    it('contains no destructive statement against pre-existing columns and writes nothing to users', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', '1791141300000-AttentionMatrixFoundations.ts'),
            'utf8',
        );
        const upBody = source.slice(
            source.indexOf('public async up('),
            source.indexOf('public async down('),
        );
        expect(upBody).not.toMatch(/dropColumn|dropTable|DROP\s/i);
        expect(upBody).not.toMatch(/renameColumn|renameTable/);
        expect(source).not.toMatch(/UPDATE\s+"?users"?/i);
        expect(source).not.toMatch(/INSERT\s+INTO\s+"?user_notification_subscriptions"?/i);
    });
});
