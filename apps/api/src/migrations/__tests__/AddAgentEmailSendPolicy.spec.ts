import { DataSource, Table, TableColumn } from 'typeorm';
import { AddAgentEmailSendPolicy1791050000000 } from '../1791050000000-AddAgentEmailSendPolicy';

/**
 * Agent email (AW-05, P1) — approve-before-send + send ceilings schema.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs,
 * asserting the PHYSICAL schema. The backfill is the part that matters
 * most: every pre-existing message must read as the history it is (`sent`
 * or `received`), never as an unapproved draft.
 */
describe('AddAgentEmailSendPolicy1791050000000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentEmailSendPolicy1791050000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        const runner = dataSource.createQueryRunner();
        for (const name of ['users', 'agents', 'tenant_email_addresses']) {
            await runner.createTable(
                new Table({ name, columns: [{ name: 'id', type: 'uuid', isPrimary: true }] }),
            );
        }
        await runner.createTable(
            new Table({
                name: 'organizations',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'digest_settings', type: 'text', isNullable: true },
                ],
            }),
        );
        await runner.createTable(
            new Table({
                name: 'email_messages',
                columns: [
                    { name: 'id', type: 'uuid', isPrimary: true },
                    { name: 'userId', type: 'uuid' },
                    { name: 'agentId', type: 'uuid', isNullable: true },
                    { name: 'direction', type: 'varchar', length: '16' },
                    { name: 'subject', type: 'varchar', length: '998' },
                    { name: 'sentAt', type: 'timestamp', isNullable: true },
                    { name: 'deliveryStatus', type: 'varchar', length: '16', isNullable: true },
                ],
            }),
        );
        await runner.query(
            `INSERT INTO email_messages (id, "userId", "agentId", direction, subject, "deliveryStatus") VALUES (?, ?, ?, ?, ?, ?)`,
            ['m-out', 'user-1', 'agent-1', 'outbound', 'Quarterly numbers', 'accepted'],
        );
        await runner.query(
            `INSERT INTO email_messages (id, "userId", "agentId", direction, subject, "deliveryStatus") VALUES (?, ?, ?, ?, ?, ?)`,
            ['m-in', 'user-1', 'agent-1', 'inbound', 'Re: Quarterly numbers', 'delivered'],
        );
        await runner.query(`INSERT INTO organizations (id) VALUES (?)`, ['org-1']);
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

    async function columns(table: string): Promise<Record<string, { notnull: number }>> {
        const rows: Array<{ name: string; notnull: number }> = await dataSource.query(
            `PRAGMA table_info("${table}")`,
        );
        return Object.fromEntries(rows.map((row) => [row.name, { notnull: row.notnull }]));
    }

    it('creates agent_inboxes with every column the entity declares', async () => {
        await runUp();
        const inbox = await columns('agent_inboxes');
        expect(Object.keys(inbox).sort()).toEqual(
            [
                'agentId',
                'burstSendCap',
                'capPausedUntil',
                'createdAt',
                'dailySendCap',
                'emailAddressId',
                'id',
                'mode',
                'organizationId',
                'recipientBurstCap',
                'recipientsPerMessageCap',
                'state',
                'tenantId',
                'updatedAt',
                'userId',
            ].sort(),
        );
        // Every ceiling is nullable: NULL is "inherit", which is not "none".
        for (const cap of ['dailySendCap', 'burstSendCap', 'recipientBurstCap']) {
            expect(inbox[cap].notnull).toBe(0);
        }
        expect(inbox.userId.notnull).toBe(1);
        expect(inbox.agentId.notnull).toBe(1);
    });

    it('allows exactly one inbox per Agent and starts a row in draft review', async () => {
        await runUp();
        await dataSource.query(`INSERT INTO users (id) VALUES (?)`, ['user-1']);
        await dataSource.query(`INSERT INTO agents (id) VALUES (?), (?)`, ['agent-1', 'agent-2']);
        const insert = (id: string, agentId: string) =>
            dataSource.query(
                `INSERT INTO agent_inboxes (id, "userId", "agentId", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, 0)`,
                [id, 'user-1', agentId],
            );
        await insert('i-1', 'agent-1');
        await expect(insert('i-2', 'agent-1')).rejects.toThrow(/UNIQUE/i);
        await expect(insert('i-3', 'agent-2')).resolves.toBeDefined();

        const [row] = await dataSource.query(
            `SELECT mode, state, "dailySendCap" FROM agent_inboxes WHERE id = ?`,
            ['i-1'],
        );
        expect(row).toEqual({ mode: 'draft-review', state: 'active', dailySendCap: null });
    });

    it('backfills every existing message as the history it is', async () => {
        await runUp();
        const rows: Array<{ id: string; status: string; approvedById: string | null }> =
            await dataSource.query(
                `SELECT id, status, "approvedById" FROM email_messages ORDER BY id`,
            );
        expect(rows).toEqual([
            { id: 'm-in', status: 'received', approvedById: null },
            { id: 'm-out', status: 'sent', approvedById: null },
        ]);
    });

    it('finishes a backfill a previous attempt left half-done (status column already present)', async () => {
        // A first attempt added the column and stopped before backfilling.
        const runner = dataSource.createQueryRunner();
        await runner.addColumn(
            'email_messages',
            new TableColumn({ name: 'status', type: 'varchar', length: '16', isNullable: true }),
        );
        await runner.query(`UPDATE email_messages SET status = 'sent' WHERE id = ?`, ['m-out']);
        await runner.release();

        await runUp();

        const rows: Array<{ id: string; status: string | null }> = await dataSource.query(
            `SELECT id, status FROM email_messages ORDER BY id`,
        );
        expect(rows).toEqual([
            { id: 'm-in', status: 'received' },
            { id: 'm-out', status: 'sent' },
        ]);
    });

    it('never rewrites a lifecycle state a message already has', async () => {
        await runUp();
        await dataSource.query(`UPDATE email_messages SET status = 'draft' WHERE id = ?`, [
            'm-out',
        ]);
        await runUp();
        const [row] = await dataSource.query(`SELECT status FROM email_messages WHERE id = ?`, [
            'm-out',
        ]);
        expect(row).toEqual({ status: 'draft' });
    });

    it('indexes the send-ceiling windows', async () => {
        await runUp();
        const indices: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("email_messages")`,
        );
        const names = indices.map((index) => index.name);
        expect(names).toContain('idx_email_messages_agent_direction_sent');
        expect(names).toContain('idx_email_messages_user_direction_sent');
    });

    it('adds the organization policy column as nullable (inherit) and leaves rows untouched', async () => {
        await runUp();
        const orgs = await columns('organizations');
        expect(orgs.email_send_policy.notnull).toBe(0);
        expect(
            await dataSource.query(`SELECT email_send_policy FROM organizations WHERE id = ?`, [
                'org-1',
            ]),
        ).toEqual([{ email_send_policy: null }]);
    });

    it('is idempotent on re-run and reversible', async () => {
        await runUp();
        await runUp();
        expect(Object.keys(await columns('email_messages'))).toContain('status');

        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();

        expect(Object.keys(await columns('agent_inboxes'))).toHaveLength(0);
        const after = await columns('email_messages');
        for (const column of [
            'status',
            'approvalId',
            'approvedById',
            'approvedAt',
            'failureReason',
        ]) {
            expect(after[column]).toBeUndefined();
        }
        expect((await columns('organizations')).email_send_policy).toBeUndefined();
        // Pre-existing data survives the round trip.
        expect(await dataSource.query(`SELECT count(*) AS n FROM email_messages`)).toEqual([
            { n: 2 },
        ]);

        const again = dataSource.createQueryRunner();
        await expect(migration.down(again)).resolves.toBeUndefined();
        await again.release();
    });

    it('still creates the inbox table when the email tables do not exist yet', async () => {
        const runner = dataSource.createQueryRunner();
        await runner.dropTable('email_messages');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await runner.release();
        expect(Object.keys(await columns('agent_inboxes')).length).toBeGreaterThan(0);
    });
});
