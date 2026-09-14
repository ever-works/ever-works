import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AddSkillShelfReadinessAndTags1791110080000 } from '../1791110080000-AddSkillShelfReadinessAndTags';

/**
 * Migration test for the Skills shelf columns and the `skill_tags` table.
 *
 * Same in-memory better-sqlite3 harness as the sibling migration specs.
 * What matters:
 *
 *  - every pre-existing Skill reads `readiness = 'unknown'` (never `ready`),
 *    switched on, not in review;
 *  - existing `frontmatter.tags` are copied into `skill_tags`, normalised,
 *    deduped and capped at 12, and a malformed frontmatter contributes nothing;
 *  - `up()` is re-runnable and inserts no extra tag rows the second time;
 *  - `down()` removes exactly what `up()` added and no pre-existing column.
 */
describe('AddSkillShelfReadinessAndTags1791110080000', () => {
    let dataSource: DataSource;
    const migration = new AddSkillShelfReadinessAndTags1791110080000();

    const run = async (direction: 'up' | 'down') => {
        const runner = dataSource.createQueryRunner();
        await migration[direction](runner);
        await runner.release();
    };

    const insertSkill = (id: string, frontmatter: string) =>
        dataSource.query(
            `INSERT INTO "skills" ("id", "userId", "ownerType", "ownerId", "slug", "title", "description", "frontmatter", "instructionsMd", "contentHash", "organizationId")
             VALUES ('${id}', 'u1', 'tenant', 'u1', '${id}', 'T', 'd', '${frontmatter.replace(/'/g, "''")}', 'body', 'h', 'o1')`,
        );

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await dataSource.initialize();
        await dataSource.query(`CREATE TABLE "users" ("id" varchar PRIMARY KEY NOT NULL)`);
        await dataSource.query(`INSERT INTO "users" ("id") VALUES ('u1')`);
        await dataSource.query(`
            CREATE TABLE "skills" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "ownerType" varchar(16) NOT NULL,
                "ownerId" varchar NOT NULL,
                "slug" varchar(80) NOT NULL,
                "title" varchar(120) NOT NULL,
                "description" text NOT NULL,
                "frontmatter" text NOT NULL,
                "instructionsMd" text NOT NULL,
                "contentHash" varchar(64) NOT NULL,
                "version" varchar(16) NOT NULL DEFAULT ('1.0.0'),
                "tenantId" varchar,
                "organizationId" varchar
            )
        `);
        await insertSkill(
            's1',
            JSON.stringify({
                name: 's1',
                description: 'd',
                tags: [' Billing ', 'billing', 'Customer Success'],
            }),
        );
        await insertSkill(
            's2',
            JSON.stringify({
                name: 's2',
                description: 'd',
                tags: Array.from({ length: 15 }, (_, i) => `t${i}`),
            }),
        );
        await insertSkill('s3', JSON.stringify({ name: 's3', description: 'd' }));
        await insertSkill('s4', '{not json');
        await insertSkill('s5', JSON.stringify({ name: 's5', description: 'd', tags: 'billing' }));
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('lands every existing Skill as unknown, switched on and not in review', async () => {
        await run('up');
        const rows = await dataSource.query(
            `SELECT "readiness", "disabledAt", "readinessDetail", "readinessCheckedAt", "reviewState", "capturedFromRunId", "title" FROM "skills"`,
        );
        expect(rows).toHaveLength(5);
        for (const row of rows) {
            expect(row.readiness).toBe('unknown');
            expect(row.disabledAt).toBeNull();
            expect(row.readinessDetail).toBeNull();
            expect(row.readinessCheckedAt).toBeNull();
            expect(row.reviewState).toBeNull();
            expect(row.capturedFromRunId).toBeNull();
            expect(row.title).toBe('T');
        }
    });

    it('backfills normalised, deduped, capped tags with the owner scope', async () => {
        await run('up');
        const tags = await dataSource.query(
            `SELECT "skillId", "tag", "userId", "organizationId" FROM "skill_tags" ORDER BY "skillId", "tag"`,
        );
        const bySkill = (id: string) =>
            tags
                .filter((t: { skillId: string }) => t.skillId === id)
                .map((t: { tag: string }) => t.tag);
        expect(bySkill('s1')).toEqual(['billing', 'customer-success']);
        expect(bySkill('s2')).toHaveLength(12);
        expect(bySkill('s3')).toEqual([]);
        expect(bySkill('s4')).toEqual([]);
        expect(bySkill('s5')).toEqual([]);
        for (const row of tags) {
            expect(row.userId).toBe('u1');
            expect(row.organizationId).toBe('o1');
        }
    });

    it('creates the indexes, including the unique ones', async () => {
        await run('up');
        const runner = dataSource.createQueryRunner();
        const skills = await runner.getTable('skills');
        const tags = await runner.getTable('skill_tags');
        await runner.release();

        expect(skills?.indices.map((index) => index.name)).toEqual(
            expect.arrayContaining([
                'idx_skills_user_readiness',
                'idx_skills_readiness_checked',
                'uq_skills_captured_run',
            ]),
        );
        expect(tags?.indices.map((index) => index.name).sort()).toEqual([
            'idx_skill_tags_skill',
            'idx_skill_tags_user_tag',
            'uq_skill_tags_skill_tag',
        ]);
    });

    it('refuses a duplicate tag on one Skill and a second draft for one run', async () => {
        await run('up');
        await expect(
            dataSource.query(
                `INSERT INTO "skill_tags" ("id", "skillId", "userId", "tag") VALUES ('x', 's1', 'u1', 'billing')`,
            ),
        ).rejects.toThrow();

        await dataSource.query(
            `UPDATE "skills" SET "capturedFromRunId" = 'run-1' WHERE "id" = 's1'`,
        );
        await expect(
            dataSource.query(`UPDATE "skills" SET "capturedFromRunId" = 'run-1' WHERE "id" = 's2'`),
        ).rejects.toThrow();
        // Many Skills with no run are fine — the unique index is partial.
        const [{ n }] = await dataSource.query(
            `SELECT COUNT(*) AS n FROM "skills" WHERE "capturedFromRunId" IS NULL`,
        );
        expect(Number(n)).toBe(4);
    });

    it('is re-runnable and inserts no extra tag rows the second time', async () => {
        await run('up');
        const [{ n: first }] = await dataSource.query(`SELECT COUNT(*) AS n FROM "skill_tags"`);
        await expect(run('up')).resolves.toBeUndefined();
        const [{ n: second }] = await dataSource.query(`SELECT COUNT(*) AS n FROM "skill_tags"`);
        expect(Number(first)).toBe(14);
        expect(Number(second)).toBe(Number(first));
    });

    it('down() removes exactly what up() added', async () => {
        await run('up');
        await run('down');

        const runner = dataSource.createQueryRunner();
        expect(await runner.hasTable('skill_tags')).toBe(false);
        const skills = await runner.getTable('skills');
        await runner.release();
        expect(skills?.columns.map((column) => column.name).sort()).toEqual(
            [
                'contentHash',
                'description',
                'frontmatter',
                'id',
                'instructionsMd',
                'organizationId',
                'ownerId',
                'ownerType',
                'slug',
                'tenantId',
                'title',
                'userId',
                'version',
            ].sort(),
        );
        const [{ n }] = await dataSource.query(`SELECT COUNT(*) AS n FROM "skills"`);
        expect(Number(n)).toBe(5);
    });

    it('never drops or renames a pre-existing column in up()', () => {
        const source = readFileSync(
            join(__dirname, '..', '1791110080000-AddSkillShelfReadinessAndTags.ts'),
            'utf8',
        );
        const upBody = source.slice(
            source.indexOf('public async up('),
            source.indexOf('public async down('),
        );
        expect(upBody).not.toMatch(/dropColumn|DROP COLUMN|renameColumn|RENAME/i);
    });

    it('normalises tags exactly like the runtime normaliser', () => {
        expect(
            AddSkillShelfReadinessAndTags1791110080000.tagsOf({
                tags: ['  Go To Market ', 'go-to-market', 'x'.repeat(50), '!!!', 3],
            }),
        ).toEqual(['go-to-market', 'x'.repeat(40)]);
    });
});
