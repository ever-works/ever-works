import { DataSource } from 'typeorm';
import { AddAgentScopeTargetIdForDurableSlugCas1780300000000 } from '../1780300000000-AddAgentScopeTargetIdForDurableSlugCas';

/**
 * Migration test for the durable Agent slug-CAS fix.
 *
 * Uses the same in-memory better-sqlite3 harness as
 * `AddUniqueIndexToUsername.spec.ts`. Sets up the OLD agents schema (the
 * `(userId, scope, missionId, ideaId, workId, slug)` NULL-distinct unique
 * index) — which, because SQL treats NULLs as DISTINCT, permits the very
 * duplicate rows the fix must dedup — then asserts up():
 *   - adds the non-null `scopeTargetId` column and backfills it from the FKs;
 *   - auto-renames duplicate (userId, scope, scopeTargetId, slug) buckets
 *     (oldest keeps the slug; later rows get a `-<id6>` suffix);
 *   - swaps the unique index to the durable `(…, scopeTargetId, slug)` form;
 *   - is idempotent; and down() restores the prior shape.
 */
describe('AddAgentScopeTargetIdForDurableSlugCas1780300000000', () => {
    let dataSource: DataSource;
    const migration = new AddAgentScopeTargetIdForDurableSlugCas1780300000000();

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();

        // OLD schema: scope FKs nullable, NULL-distinct composite unique index.
        await dataSource.query(
            `CREATE TABLE "agents" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "scope" varchar NOT NULL,
                "missionId" varchar,
                "ideaId" varchar,
                "workId" varchar,
                "slug" varchar NOT NULL,
                "createdAt" varchar NOT NULL
            )`,
        );
        await dataSource.query(
            `CREATE UNIQUE INDEX "uq_agents_user_scope_slug" ON "agents" ("userId", "scope", "missionId", "ideaId", "workId", "slug")`,
        );
    });

    afterEach(async () => {
        await dataSource.destroy();
    });

    function uuid(prefix: string): string {
        return `${prefix}aa-bbbb-cccc-dddd-eeeeeeeeeeee`.slice(0, 36);
    }

    async function insert(
        id: string,
        userId: string,
        scope: string,
        fks: { missionId?: string | null; ideaId?: string | null; workId?: string | null },
        slug: string,
        createdAt: string,
    ): Promise<void> {
        await dataSource.query(
            `INSERT INTO "agents" ("id", "userId", "scope", "missionId", "ideaId", "workId", "slug", "createdAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                userId,
                scope,
                fks.missionId ?? null,
                fks.ideaId ?? null,
                fks.workId ?? null,
                slug,
                createdAt,
            ],
        );
    }

    async function rowsById(): Promise<Record<string, { slug: string; scopeTargetId: string }>> {
        const rows: Array<{ id: string; slug: string; scopeTargetId: string }> =
            await dataSource.query(`SELECT "id", "slug", "scopeTargetId" FROM "agents"`);
        return Object.fromEntries(rows.map((r) => [r.id, { slug: r.slug, scopeTargetId: r.scopeTargetId }]));
    }

    async function indexSql(): Promise<string | null> {
        const rows: Array<{ sql: string | null }> = await dataSource.query(
            `SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_agents_user_scope_slug'`,
        );
        return rows.length ? rows[0].sql : null;
    }

    async function runUp(): Promise<void> {
        const runner = dataSource.createQueryRunner();
        await migration.up(runner);
        await runner.release();
    }

    it('adds + backfills scopeTargetId and installs the durable index on a clean DB', async () => {
        await insert(uuid('111111'), 'u1', 'tenant', {}, 'alpha', '2026-01-01');
        await insert(uuid('222222'), 'u1', 'work', { workId: 'w-9' }, 'beta', '2026-01-02');
        await insert(uuid('333333'), 'u1', 'mission', { missionId: 'm-7' }, 'gamma', '2026-01-03');

        await runUp();

        const rows = await rowsById();
        expect(rows[uuid('111111')].scopeTargetId).toBe(''); // tenant → empty, never NULL
        expect(rows[uuid('222222')].scopeTargetId).toBe('w-9');
        expect(rows[uuid('333333')].scopeTargetId).toBe('m-7');

        const sql = await indexSql();
        expect(sql).toContain('scopeTargetId');
        expect(sql).not.toContain('missionId'); // old nullable members gone
    });

    it('auto-renames duplicate tenant-scoped agents the old index could not catch', async () => {
        // Same (userId, tenant, slug); all FKs NULL → old index allowed both.
        const oldId = uuid('aaaaaa');
        const newId = uuid('bbbbbb');
        await insert(oldId, 'u1', 'tenant', {}, 'dup', '2026-01-01T00:00:00Z');
        await insert(newId, 'u1', 'tenant', {}, 'dup', '2026-02-01T00:00:00Z');

        await runUp();

        const rows = await rowsById();
        expect(rows[oldId].slug).toBe('dup'); // oldest keeps the canonical slug
        expect(rows[newId].slug).toBe('dup-bbbbbb'); // later row suffixed by id prefix
        expect(rows[oldId].scopeTargetId).toBe('');
        expect(rows[newId].scopeTargetId).toBe('');
        // The durable index now exists and the rows no longer collide on it.
        expect(await indexSql()).toContain('scopeTargetId');
    });

    it('does NOT rename rows that only collide on a nullable FK (distinct scope targets)', async () => {
        // Same slug but different workId → genuinely distinct, must both survive.
        await insert(uuid('aaaaaa'), 'u1', 'work', { workId: 'w-1' }, 'same', '2026-01-01');
        await insert(uuid('bbbbbb'), 'u1', 'work', { workId: 'w-2' }, 'same', '2026-01-02');

        await runUp();

        const rows = await rowsById();
        expect(rows[uuid('aaaaaa')].slug).toBe('same');
        expect(rows[uuid('bbbbbb')].slug).toBe('same');
        expect(rows[uuid('aaaaaa')].scopeTargetId).toBe('w-1');
        expect(rows[uuid('bbbbbb')].scopeTargetId).toBe('w-2');
    });

    it('is idempotent — running up() twice does not throw', async () => {
        await insert(uuid('111111'), 'u1', 'tenant', {}, 'x', '2026-01-01');
        await runUp();
        await expect(runUp()).resolves.toBeUndefined();
        expect(await indexSql()).toContain('scopeTargetId');
    });

    it('down() restores the prior NULL-distinct index and drops the column', async () => {
        await insert(uuid('111111'), 'u1', 'tenant', {}, 'x', '2026-01-01');
        await runUp();
        expect(await indexSql()).toContain('scopeTargetId');

        const down = dataSource.createQueryRunner();
        await migration.down(down);
        await down.release();

        const sql = await indexSql();
        expect(sql).toContain('missionId'); // old form back
        expect(sql).not.toContain('scopeTargetId');
        const cols: Array<{ name: string }> = await dataSource.query(`PRAGMA table_info("agents")`);
        expect(cols.some((c) => c.name === 'scopeTargetId')).toBe(false);
    });
});
