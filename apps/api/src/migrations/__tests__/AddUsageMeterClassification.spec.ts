import { DataSource } from 'typeorm';
import { AddUsageMeterClassification1791170000000 } from '../1791170000000-AddUsageMeterClassification';

/**
 * AW-17 P1 — migration test for the meter classification columns on
 * `plugin_usage_events`, run against an in-memory better-sqlite3 DataSource
 * (same harness as `CreateReleasePromotions.spec.ts`).
 *
 * Load-bearing assertions:
 *  - the seven columns and three indexes exist after `up()`;
 *  - `meter` is NOT backfilled (history is never guessed into a meter);
 *  - `missionId` IS backfilled from the row's Task, and only from the Task;
 *  - a second `up()` — and an `up()` over a partially applied earlier attempt —
 *    converges without error and changes nothing;
 *  - an index whose name exists over the wrong columns, or the right columns
 *    in the wrong order, is rebuilt — the guard checks columns, not the name;
 *  - `down()` removes exactly what `up()` added.
 */
describe('AddUsageMeterClassification1791170000000', () => {
    let dataSource: DataSource;
    const migration = new AddUsageMeterClassification1791170000000();

    const NEW_COLUMNS = [
        'meter',
        'payer',
        'outcome',
        'creditsCharged',
        'priceKey',
        'priceVersion',
        'missionId',
    ];
    const NEW_INDEXES = [
        'idx_plugin_usage_meter_user_occurred',
        'idx_plugin_usage_pricekey_user_occurred',
        'idx_plugin_usage_mission_occurred',
    ];

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(
            `CREATE TABLE "tasks" ("id" varchar PRIMARY KEY NOT NULL, "missionId" varchar)`,
        );
        await dataSource.query(
            `INSERT INTO "tasks" ("id", "missionId") VALUES ('t-mission', 'm-1'), ('t-loose', NULL)`,
        );
        // An agent row with a DIFFERENT Mission — the backfill must never read it.
        await dataSource.query(
            `CREATE TABLE "agents" ("id" varchar PRIMARY KEY NOT NULL, "missionId" varchar)`,
        );
        await dataSource.query(
            `INSERT INTO "agents" ("id", "missionId") VALUES ('a-1', 'm-other')`,
        );
        await dataSource.query(`
            CREATE TABLE "plugin_usage_events" (
                "id" varchar PRIMARY KEY NOT NULL,
                "workId" varchar NOT NULL,
                "userId" varchar NOT NULL,
                "pluginId" varchar(128) NOT NULL,
                "capability" varchar(32) NOT NULL,
                "units" integer NOT NULL DEFAULT 1,
                "costCents" integer NOT NULL DEFAULT 0,
                "agentId" varchar,
                "taskId" varchar,
                "runId" varchar,
                "occurredAt" datetime NOT NULL DEFAULT (datetime('now'))
            )`);
        await dataSource.query(`
            INSERT INTO "plugin_usage_events"
                ("id", "workId", "userId", "pluginId", "capability", "agentId", "taskId")
            VALUES
                ('e-mission', 'w-1', 'u-1', 'search-a', 'search', 'a-1', 't-mission'),
                ('e-loose',   'w-1', 'u-1', 'search-a', 'search', 'a-1', 't-loose'),
                ('e-notask',  'w-1', 'u-1', 'search-a', 'search', 'a-1', NULL),
                ('e-gone',    'w-1', 'u-1', 'search-a', 'search', 'a-1', 't-deleted')`);
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    async function up(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    async function down(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.down(runner);
        await runner.release();
    }

    async function columnNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA table_info("plugin_usage_events")`,
        );
        return rows.map((row) => row.name);
    }

    async function indexNames(): Promise<string[]> {
        const rows: Array<{ name: string }> = await dataSource.query(
            `PRAGMA index_list("plugin_usage_events")`,
        );
        return rows.map((row) => row.name);
    }

    async function indexColumns(name: string): Promise<string[]> {
        const rows: Array<{ seqno: number; name: string }> = await dataSource.query(
            `PRAGMA index_info("${name}")`,
        );
        return [...rows].sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
    }

    async function missionOf(id: string): Promise<string | null> {
        const [row] = await dataSource.query(
            `SELECT "missionId" FROM "plugin_usage_events" WHERE "id" = ?`,
            [id],
        );
        return row?.missionId ?? null;
    }

    it('adds the seven columns and the three indexes', async () => {
        await up();

        expect(await columnNames()).toEqual(expect.arrayContaining(NEW_COLUMNS));
        expect(await indexNames()).toEqual(expect.arrayContaining(NEW_INDEXES));
    });

    it('does not back-classify any existing row into a meter', async () => {
        await up();

        const rows: Array<{ meter: string | null; creditsCharged: number }> =
            await dataSource.query(`SELECT "meter", "creditsCharged" FROM "plugin_usage_events"`);
        expect(rows).toHaveLength(4);
        expect(rows.every((row) => row.meter === null)).toBe(true);
        expect(rows.every((row) => Number(row.creditsCharged) === 0)).toBe(true);
    });

    it("backfills missionId from the row's Task only — never from the Agent", async () => {
        await up();

        expect(await missionOf('e-mission')).toBe('m-1');
        expect(await missionOf('e-loose')).toBeNull();
        expect(await missionOf('e-notask')).toBeNull();
        expect(await missionOf('e-gone')).toBeNull();
    });

    it('is re-runnable: a second up() changes nothing', async () => {
        await up();
        await dataSource.query(
            `UPDATE "plugin_usage_events" SET "missionId" = 'm-kept' WHERE "id" = 'e-mission'`,
        );

        await expect(up()).resolves.toBeUndefined();

        // The IS NULL guard leaves an already-attributed row alone.
        expect(await missionOf('e-mission')).toBe('m-kept');
        expect((await columnNames()).filter((name) => name === 'meter')).toHaveLength(1);
    });

    it('converges on a database where an earlier attempt added only some columns', async () => {
        await dataSource.query(`ALTER TABLE "plugin_usage_events" ADD COLUMN "meter" varchar(16)`);
        await dataSource.query(
            `CREATE INDEX "idx_plugin_usage_mission_occurred" ON "plugin_usage_events" ("taskId")`,
        );

        await expect(up()).resolves.toBeUndefined();

        expect(await columnNames()).toEqual(expect.arrayContaining(NEW_COLUMNS));
        expect(await indexNames()).toEqual(expect.arrayContaining(NEW_INDEXES));
        // The name was taken by an index over the wrong column. A name-only
        // guard keeps it; the Mission reads need (missionId, occurredAt).
        expect(await indexColumns('idx_plugin_usage_mission_occurred')).toEqual([
            'missionId',
            'occurredAt',
        ]);
    });

    it('rebuilds an index of the right name whose columns are in the wrong order', async () => {
        await dataSource.query(
            `ALTER TABLE "plugin_usage_events" ADD COLUMN "priceKey" varchar(64)`,
        );
        await dataSource.query(
            `CREATE INDEX "idx_plugin_usage_pricekey_user_occurred" ON "plugin_usage_events" ("priceKey", "userId", "occurredAt")`,
        );

        await expect(up()).resolves.toBeUndefined();

        expect(await indexColumns('idx_plugin_usage_pricekey_user_occurred')).toEqual([
            'userId',
            'priceKey',
            'occurredAt',
        ]);
    });

    it('creates every index with its declared columns and leaves a correct one untouched', async () => {
        await up();

        expect(await indexColumns('idx_plugin_usage_meter_user_occurred')).toEqual([
            'userId',
            'meter',
            'occurredAt',
        ]);
        expect(await indexColumns('idx_plugin_usage_pricekey_user_occurred')).toEqual([
            'userId',
            'priceKey',
            'occurredAt',
        ]);
        expect(await indexColumns('idx_plugin_usage_mission_occurred')).toEqual([
            'missionId',
            'occurredAt',
        ]);

        // A second run over correct indexes drops nothing.
        const runner = dataSource.createQueryRunner();
        const query = jest.spyOn(runner, 'query');
        await migration.up(runner);
        await runner.release();
        const dropped = query.mock.calls.filter(([sql]) => /DROP INDEX/i.test(String(sql)));
        expect(dropped).toHaveLength(0);
    });

    it('down() removes exactly the columns and indexes up() added', async () => {
        await up();
        await down();

        const columns = await columnNames();
        for (const column of NEW_COLUMNS) {
            expect(columns).not.toContain(column);
        }
        expect(columns).toEqual(expect.arrayContaining(['taskId', 'runId', 'costCents']));
        const indexes = await indexNames();
        for (const index of NEW_INDEXES) {
            expect(indexes).not.toContain(index);
        }
    });

    it('is a no-op when the usage table does not exist', async () => {
        await dataSource.query(`DROP TABLE "plugin_usage_events"`);
        await expect(up()).resolves.toBeUndefined();
    });
});
