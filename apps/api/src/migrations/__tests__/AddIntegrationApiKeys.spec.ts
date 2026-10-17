import { DataSource } from 'typeorm';
import { AddIntegrationApiKeys1795060100000 } from '../1795060100000-AddIntegrationApiKeys';

/**
 * EW-P1-2 — `api_keys` integration columns + `task_chat_messages` attribution.
 *
 * Runs on the in-memory better-sqlite3 harness its siblings use (CI and the
 * e2e stack are sqlite; production is Postgres). The Postgres and MySQL
 * spellings of the one raw statement (`authorType` widening) are pinned
 * separately below, the way 1792070000000 pins its per-driver index DDL.
 *
 * Pinned here:
 *  - every new column exists after up() and is NULL on pre-existing rows;
 *  - an integration row with scopes, pins and rotation fields inserts;
 *  - the two indexes exist, and the pre-existing unique hashedKey index survives;
 *  - `task_chat_messages` gains `externalAuthor` and accepts `'integration'`;
 *  - down() deletes integration keys only, resets integration chat authors,
 *    and removes everything up() added;
 *  - up() and down() are idempotent.
 */
describe('AddIntegrationApiKeys1795060100000', () => {
    let dataSource: DataSource;
    const migration = new AddIntegrationApiKeys1795060100000();
    const NEW_COLUMNS = [
        'scopes',
        'organizationIds',
        'integrationKind',
        'description',
        'previousHashedKey',
        'previousKeyGraceUntil',
        'rotatedAt',
    ];

    const createTables = async () => {
        await dataSource.query(`
            CREATE TABLE "api_keys" (
                "id" varchar PRIMARY KEY,
                "userId" varchar NOT NULL,
                "name" varchar(100) NOT NULL,
                "hashedKey" varchar NOT NULL,
                "prefix" varchar(12) NOT NULL,
                "expiresAt" bigint,
                "lastUsedAt" bigint,
                "isActive" boolean NOT NULL DEFAULT 1,
                "kind" varchar(32) NOT NULL DEFAULT 'personal',
                "boundJobId" uuid,
                "boundNodeId" uuid,
                "boundRunId" uuid,
                "tenantId" uuid,
                "organizationId" uuid,
                "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await dataSource.query(
            `CREATE UNIQUE INDEX "idx_api_keys_hashed_key" ON "api_keys" ("hashedKey")`,
        );
        await dataSource.query(`
            CREATE TABLE "tasks" (
                "id" varchar PRIMARY KEY,
                "userId" varchar NOT NULL,
                "createdByType" varchar(16) NOT NULL,
                "createdById" varchar NOT NULL
            )
        `);
        await dataSource.query(`
            CREATE TABLE "task_chat_messages" (
                "id" varchar PRIMARY KEY,
                "taskId" varchar NOT NULL,
                "authorType" varchar(8) NOT NULL,
                "authorId" varchar NOT NULL,
                "body" text NOT NULL,
                "createdAt" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
    };

    const columns = async (table: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );
    const indexes = async (table: string): Promise<string[]> =>
        ((await dataSource.query(`PRAGMA index_list("${table}")`)) as Array<{ name: string }>).map(
            (row) => row.name,
        );

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        try {
            await migration[direction](runner);
        } finally {
            await runner.release();
        }
    };

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await createTables();
        await dataSource.query(
            `INSERT INTO "api_keys" ("id","userId","name","hashedKey","prefix") VALUES ('k1','u1','Mine','h1','ew_live_abcd')`,
        );
        await dataSource.query(
            `INSERT INTO "task_chat_messages" ("id","taskId","authorType","authorId","body") VALUES ('m1','t1','user','u1','hi')`,
        );
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('adds the integration columns and indexes; existing rows read NULL', async () => {
        await run('up');
        const cols = await columns('api_keys');
        for (const name of NEW_COLUMNS) expect(cols).toContain(name);
        const idx = await indexes('api_keys');
        expect(idx).toEqual(
            expect.arrayContaining([
                'idx_api_keys_previous_hashed_key',
                'idx_api_keys_tenant_kind',
                'idx_api_keys_hashed_key',
            ]),
        );
        const [row] = await dataSource.query(
            `SELECT "kind","scopes","organizationIds","integrationKind","previousHashedKey" FROM "api_keys" WHERE "id"='k1'`,
        );
        expect(row).toEqual({
            kind: 'personal',
            scopes: null,
            organizationIds: null,
            integrationKind: null,
            previousHashedKey: null,
        });
    });

    it('stores an integration key with scopes, pins and rotation fields', async () => {
        await run('up');
        await dataSource.query(
            `INSERT INTO "api_keys" ("id","userId","name","hashedKey","prefix","kind","scopes","organizationIds","integrationKind","description","previousHashedKey","previousKeyGraceUntil","rotatedAt","tenantId")
             VALUES ('k2','u1','Ever Gauzy','h2','ew_int_abcd','integration','["tasks:write"]','["o1"]','ever-gauzy','note','h-old',1800000000000,1790000000000,'t1')`,
        );
        const [row] = await dataSource.query(`SELECT * FROM "api_keys" WHERE "id"='k2'`);
        expect(row).toMatchObject({
            kind: 'integration',
            scopes: '["tasks:write"]',
            organizationIds: '["o1"]',
            integrationKind: 'ever-gauzy',
            previousHashedKey: 'h-old',
        });
    });

    it('adds externalAuthor to task chat and accepts an integration author', async () => {
        await run('up');
        expect(await columns('task_chat_messages')).toContain('externalAuthor');
        await dataSource.query(
            `INSERT INTO "task_chat_messages" ("id","taskId","authorType","authorId","body","externalAuthor")
             VALUES ('m2','t1','integration','key-1','from gauzy','{"name":"Jane","source":"gauzy"}')`,
        );
        const [row] = await dataSource.query(
            `SELECT "authorType","externalAuthor" FROM "task_chat_messages" WHERE "id"='m2'`,
        );
        expect(row).toEqual({
            authorType: 'integration',
            externalAuthor: '{"name":"Jane","source":"gauzy"}',
        });
    });

    it('is idempotent', async () => {
        await run('up');
        await run('up');
        expect((await columns('api_keys')).filter((c) => c === 'scopes')).toHaveLength(1);
        await run('down');
        await run('down');
        expect(await columns('api_keys')).not.toContain('scopes');
    });

    it('down() removes integration keys and the added columns, keeps personal keys, resets integration authors', async () => {
        await run('up');
        await dataSource.query(
            `INSERT INTO "api_keys" ("id","userId","name","hashedKey","prefix","kind") VALUES ('k3','u1','Int','h3','ew_int_abcd','integration')`,
        );
        await dataSource.query(
            `INSERT INTO "tasks" ("id","userId","createdByType","createdById") VALUES ('t1','owner-1','integration','k3'), ('t2','u2','user','u2')`,
        );
        await dataSource.query(
            `INSERT INTO "task_chat_messages" ("id","taskId","authorType","authorId","body") VALUES ('m3','t1','integration','k3','x')`,
        );
        await run('down');
        // Integration authorship goes back to a real person — the Task owner,
        // which is who an integration without act-as writes as — before the key
        // rows disappear, so no history points at a deleted key.
        expect(
            await dataSource.query(
                `SELECT "id","createdByType","createdById" FROM "tasks" ORDER BY "id"`,
            ),
        ).toEqual([
            { id: 't1', createdByType: 'user', createdById: 'owner-1' },
            { id: 't2', createdByType: 'user', createdById: 'u2' },
        ]);
        const [m3row] = await dataSource.query(
            `SELECT "authorType","authorId" FROM "task_chat_messages" WHERE "id"='m3'`,
        );
        expect(m3row).toEqual({ authorType: 'user', authorId: 'owner-1' });
        const ids = (await dataSource.query(`SELECT "id" FROM "api_keys" ORDER BY "id"`)).map(
            (r: { id: string }) => r.id,
        );
        expect(ids).toEqual(['k1']);
        const cols = await columns('api_keys');
        for (const name of NEW_COLUMNS) expect(cols).not.toContain(name);
        expect(await indexes('api_keys')).not.toContain('idx_api_keys_previous_hashed_key');
        expect(await columns('task_chat_messages')).not.toContain('externalAuthor');
        const [m3] = await dataSource.query(
            `SELECT "authorType" FROM "task_chat_messages" WHERE "id"='m3'`,
        );
        expect(m3.authorType).toBe('user');
    });

    it('spells the authorType widening per driver (Postgres, MySQL; nothing on sqlite)', () => {
        const C = AddIntegrationApiKeys1795060100000;
        expect(C.widenAuthorTypeStatement('postgres', 16)).toBe(
            'ALTER TABLE "task_chat_messages" ALTER COLUMN "authorType" TYPE varchar(16)',
        );
        expect(C.widenAuthorTypeStatement('mysql', 16)).toBe(
            'ALTER TABLE `task_chat_messages` MODIFY `authorType` varchar(16) NOT NULL',
        );
        expect(C.widenAuthorTypeStatement('mariadb', 8)).toBe(
            'ALTER TABLE `task_chat_messages` MODIFY `authorType` varchar(8) NOT NULL',
        );
        expect(C.widenAuthorTypeStatement('better-sqlite3', 16)).toBeNull();
    });
});
