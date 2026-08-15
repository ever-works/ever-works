import { DataSource } from 'typeorm';
import { CreateInboxItems1786870000000 } from '../1786870000000-CreateInboxItems';

/**
 * Migration test for the `inbox_items` table.
 *
 * Runs on the in-memory better-sqlite3 harness the sibling specs use,
 * which is the point: production is Postgres and CI/e2e are sqlite, so a
 * migration written with raw `gen_random_uuid()` or a Postgres-only
 * INSERT would pass in prod and fail every CI run. The notification
 * event-type seeding is `hasTable`-guarded for exactly that reason —
 * this spec pins that `up()` survives with the table absent.
 *
 * Also pinned: NO scope XOR CHECK (an inbox item legitimately carries
 * both `workId` and `organizationId`), and no FKs on the cross-links —
 * an inbox item must outlive the run / escalation / proposal it
 * describes.
 */
describe('CreateInboxItems1786870000000', () => {
    let dataSource: DataSource;
    const migration = new CreateInboxItems1786870000000();

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

    it('creates the table with every expected column', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('inbox_items');
        expect(table).toBeDefined();
        for (const column of [
            'id',
            'userId',
            'kind',
            'title',
            'body',
            'options',
            'sourceType',
            'agentId',
            'agentRunId',
            'taskId',
            'workId',
            'escalationId',
            'proposalId',
            'status',
            'unread',
            'answeredAt',
            'answerText',
            'answerOptionId',
            'tenantId',
            'organizationId',
            'createdAt',
            'updatedAt',
        ]) {
            expect(table?.findColumnByName(column)).toBeDefined();
        }

        await runner.release();
    });

    it('creates the list index and both producer-dedup indexes', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        const table = await runner.getTable('inbox_items');
        const names = (table?.indices ?? []).map((index) => index.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'idx_inbox_items_user_status_unread',
                'idx_inbox_items_escalation',
                'idx_inbox_items_proposal',
            ]),
        );

        await runner.release();
    });

    it('is idempotent — a second up() does not throw', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        await runner.release();
    });

    // The raw inserts below supply createdAt/updatedAt explicitly: the
    // columns default to `now()`, which Postgres has and sqlite does not.
    // Harmless in practice — every real insert goes through TypeORM, whose
    // @CreateDateColumn supplies the value from the ORM side.
    it('accepts an item carrying BOTH workId and organizationId', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await expect(
            dataSource.query(
                `INSERT INTO "inbox_items"
                    ("id","userId","kind","title","body","sourceType","workId","organizationId","status","unread","createdAt","updatedAt")
                 VALUES ('i1','u1','question','Which DB?','Which DB?','agent-run','work-1','org-1','open',1,'2026-08-02','2026-08-02')`,
            ),
        ).resolves.not.toThrow();

        await runner.release();
    });

    it('accepts an item whose cross-links point at rows that do not exist', async () => {
        // No FKs by design: "what did the agent ask me last week?" stays a
        // valid question after the run, escalation or proposal is gone.
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);

        await expect(
            dataSource.query(
                `INSERT INTO "inbox_items"
                    ("id","userId","kind","title","body","sourceType","agentRunId","escalationId","proposalId","status","unread","createdAt","updatedAt")
                 VALUES ('i2','u1','escalation','Stuck','Stuck','escalation','run-gone','esc-gone','prop-gone','open',1,'2026-08-02','2026-08-02')`,
            ),
        ).resolves.not.toThrow();

        await runner.release();
    });

    it('down() drops the table', async () => {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await migration.down(runner);

        expect(await runner.hasTable('inbox_items')).toBe(false);

        await runner.release();
    });

    it('down() is safe when the table was never created', async () => {
        const runner = dataSource.createQueryRunner();
        await expect(migration.down(runner)).resolves.not.toThrow();
        await runner.release();
    });
});
