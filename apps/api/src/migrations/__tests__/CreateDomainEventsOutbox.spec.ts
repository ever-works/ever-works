import { DataSource } from 'typeorm';
import { CreateDomainEventsOutbox1795052100000 } from '../1795052100000-CreateDomainEventsOutbox';

/**
 * Migration test for the domain event outbox (EW-P1-1).
 *
 * In-memory better-sqlite3, asserting the PHYSICAL schema through `PRAGMA`
 * (the query runner's own metadata can be desynchronised by raw DDL). The
 * five versioned tables are created with just enough columns to receive the
 * `version` column; one existing row per table proves the backfill to 1.
 */
describe('CreateDomainEventsOutbox1795052100000', () => {
    let dataSource: DataSource;
    const migration = new CreateDomainEventsOutbox1795052100000();
    const VERSIONED = ['tasks', 'teams', 'agents', 'works', 'organizations'];

    const columns = async (
        table: string,
    ): Promise<
        Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
        }>
    > => dataSource.query(`PRAGMA table_info("${table}")`);
    const indexes = async (
        table: string,
    ): Promise<Array<{ name: string; unique: number; partial: number }>> =>
        dataSource.query(`PRAGMA index_list("${table}")`);
    const tableNames = async (): Promise<string[]> =>
        (
            (await dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table'`,
            )) as Array<{
                name: string;
            }>
        ).map((row) => row.name);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        for (const table of VERSIONED) {
            await dataSource.query(
                `CREATE TABLE "${table}" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar)`,
            );
            await dataSource.query(
                `INSERT INTO "${table}" ("id", "name") VALUES ('row-1', 'existing')`,
            );
        }
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('creates the outbox with an autoincrement outboxSeq and a nullable, unique feed position', async () => {
        await migration.up(dataSource.createQueryRunner());

        const cols = await columns('domain_events');
        const byName = new Map(cols.map((column) => [column.name, column]));
        expect(byName.get('outboxSeq')?.type.toLowerCase()).toBe('integer');
        expect(byName.get('outboxSeq')?.pk).toBe(1);
        expect(byName.get('seq')).toMatchObject({ notnull: 0 });
        for (const required of [
            'id',
            'type',
            'aggregateType',
            'aggregateId',
            'actorType',
            'actorId',
            'data',
        ]) {
            expect(byName.get(required)?.notnull).toBe(1);
        }
        for (const optional of [
            'tenantId',
            'organizationId',
            'visibility',
            'originTag',
            'dispatchedAt',
        ]) {
            expect(byName.get(optional)?.notnull).toBe(0);
        }

        const sql = (
            (await dataSource.query(
                `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'domain_events'`,
            )) as Array<{ sql: string }>
        )[0].sql;
        expect(sql).toMatch(/"outboxSeq" integer PRIMARY KEY AUTOINCREMENT/i);
    });

    it('creates every outbox index, with the undispatched scan partial', async () => {
        await migration.up(dataSource.createQueryRunner());
        const list = await indexes('domain_events');
        const byName = new Map(list.map((index) => [index.name, index]));
        expect(byName.get('uq_domain_events_id')?.unique).toBe(1);
        expect(byName.get('uq_domain_events_seq')?.unique).toBe(1);
        for (const name of [
            'idx_domain_events_tenant_seq',
            'idx_domain_events_org_seq',
            'idx_domain_events_aggregate_seq',
        ]) {
            expect(byName.has(name)).toBe(true);
        }
        expect(byName.get('idx_domain_events_undispatched')?.partial).toBe(1);
    });

    it('allocates increasing outboxSeq values and lets several undispatched rows share a null seq', async () => {
        await migration.up(dataSource.createQueryRunner());
        for (const id of ['evt_A', 'evt_B']) {
            await dataSource.query(
                `INSERT INTO "domain_events" ("id", "type", "aggregateType", "aggregateId", "actorType", "actorId",
                 "changedFields", "data", "previous", "occurredAt")
                 VALUES (?, 'task.updated', 'task', 't1', 'user', 'u1', '[]', '{}', '{}', '2026-10-15 18:00:00')`,
                [id],
            );
        }
        const rows = (await dataSource.query(
            `SELECT "outboxSeq", "seq", "version", "aggregateVersion" FROM "domain_events" ORDER BY "outboxSeq"`,
        )) as Array<{
            outboxSeq: number;
            seq: number | null;
            version: number;
            aggregateVersion: number;
        }>;
        expect(rows.map((row) => row.outboxSeq)).toEqual([1, 2]);
        expect(
            rows.every(
                (row) => row.seq === null && row.version === 1 && row.aggregateVersion === 1,
            ),
        ).toBe(true);
        // Control: two DIFFERENT dispatched rows cannot share a position.
        await dataSource.query(`UPDATE "domain_events" SET "seq" = 7 WHERE "outboxSeq" = 1`);
        await expect(
            dataSource.query(`UPDATE "domain_events" SET "seq" = 7 WHERE "outboxSeq" = 2`),
        ).rejects.toThrow(/UNIQUE/);
    });

    it('seeds the one relay-state row and creates the plugin cursor table', async () => {
        await migration.up(dataSource.createQueryRunner());
        const state = await dataSource.query(
            `SELECT "id", "holder", "lastSeq", "retentionFloorSeq" FROM "domain_event_relay_state"`,
        );
        expect(state).toEqual([{ id: 'relay', holder: null, lastSeq: 0, retentionFloorSeq: 0 }]);
        const cursorIndexes = await indexes('plugin_event_cursors');
        expect(
            cursorIndexes.find((index) => index.name === 'uq_plugin_event_cursors_plugin_tenant')
                ?.unique,
        ).toBe(1);
    });

    it('adds version NOT NULL DEFAULT 1 to the five P1 aggregates and backfills existing rows', async () => {
        await migration.up(dataSource.createQueryRunner());
        for (const table of VERSIONED) {
            const version = (await columns(table)).find((column) => column.name === 'version');
            expect(version).toMatchObject({ notnull: 1, dflt_value: '1' });
            expect(await dataSource.query(`SELECT "version", "name" FROM "${table}"`)).toEqual([
                { version: 1, name: 'existing' },
            ]);
        }
    });

    it('is idempotent: a second up() converges instead of throwing and does not duplicate the seed', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        expect(
            await dataSource.query(`SELECT COUNT(*) AS n FROM "domain_event_relay_state"`),
        ).toEqual([{ n: 1 }]);
        expect((await columns('tasks')).filter((column) => column.name === 'version')).toHaveLength(
            1,
        );
    });

    it('down() removes the three tables and the five version columns, keeping the aggregates rows', async () => {
        await migration.up(dataSource.createQueryRunner());
        await migration.down(dataSource.createQueryRunner());
        const tables = await tableNames();
        for (const table of ['domain_events', 'domain_event_relay_state', 'plugin_event_cursors']) {
            expect(tables).not.toContain(table);
        }
        for (const table of VERSIONED) {
            expect((await columns(table)).map((column) => column.name)).not.toContain('version');
            expect(await dataSource.query(`SELECT "name" FROM "${table}"`)).toEqual([
                { name: 'existing' },
            ]);
        }
    });

    it('down() is safe where up() never ran', async () => {
        await expect(migration.down(dataSource.createQueryRunner())).resolves.toBeUndefined();
    });
});
