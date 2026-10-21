import { DataSource } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { Task } from '@ever-works/agent/entities';
import { AddTaskOrigin1795169100000 } from '../1795169100000-AddTaskOrigin';

/**
 * Works-security (2026-10-18) — `tasks.origin`, the server-written provenance
 * the App change guard's provisioning exemption reads instead of a label.
 *
 * Asserted against the PHYSICAL sqlite schema and against the ENTITY metadata
 * built from the `ENTITIES` inventory: dev and stage `synchronize` from the
 * entities while production runs this file, so both must agree.
 */
describe('1795169100000-AddTaskOrigin', () => {
    let dataSource: DataSource;
    const migration = new AddTaskOrigin1795169100000();

    const columns = async (): Promise<Array<{ name: string; notnull: number; dflt_value: string | null }>> =>
        dataSource.query(`PRAGMA table_info("tasks")`);

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`
            CREATE TABLE "tasks" (
                "id" varchar PRIMARY KEY NOT NULL,
                "title" varchar(200) NOT NULL,
                "labels" text
            )
        `);
        // A pre-existing row carrying the old label: it must NOT be backfilled.
        await dataSource.query(
            `INSERT INTO "tasks" ("id", "title", "labels") VALUES ('t1', 'Provision: make app build and run', '["app-provision"]')`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    it('adds a nullable origin column and backfills nothing (fail closed)', async () => {
        await migration.up(dataSource.createQueryRunner());
        const origin = (await columns()).find((column) => column.name === 'origin');
        expect(origin?.notnull).toBe(0);
        expect(origin?.dflt_value).toBeNull();
        expect(await dataSource.query(`SELECT "origin" FROM "tasks"`)).toEqual([{ origin: null }]);
    });

    it('adds exactly what the Task entity declares', async () => {
        const metadataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: false,
        });
        await metadataSource.initialize();
        try {
            const column = metadataSource.getMetadata(Task).columns.find((c) => c.databaseName === 'origin');
            expect(column?.isNullable).toBe(true);
            expect(String(column?.length)).toBe('32');
        } finally {
            await metadataSource.destroy();
        }
    });

    it('converges when re-run and reverts cleanly', async () => {
        await migration.up(dataSource.createQueryRunner());
        await expect(migration.up(dataSource.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(dataSource.createQueryRunner());
        expect((await columns()).some((column) => column.name === 'origin')).toBe(false);
        expect(await dataSource.query(`SELECT "id" FROM "tasks"`)).toEqual([{ id: 't1' }]);
    });
});
