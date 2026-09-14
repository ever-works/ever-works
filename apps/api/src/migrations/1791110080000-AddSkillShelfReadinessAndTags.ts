import { randomUUID } from 'crypto';
import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
} from 'typeorm';

/**
 * Skills shelf, phase 1 — six columns on `skills` and the `skill_tags` table.
 *
 * Entities:
 *   `packages/agent/src/entities/skill.entity.ts`     (the six columns)
 *   `packages/agent/src/entities/skill-tag.entity.ts` (the new table)
 *
 * ## `skills` — the off switch, the cached verdict, the review state
 *
 * `disabledAt` is the workspace-level off switch (NULL = on). `readiness`
 * lands `NOT NULL DEFAULT 'unknown'` and is deliberately NOT backfilled to
 * `'ready'`: claiming a Skill works before anything checked it is the exact
 * failure the shelf exists to remove, so every existing Skill reads
 * "Couldn't check" until the hourly sweep or its next write computes a real
 * verdict. `readinessDetail` holds identifiers only (tool names, credential
 * KEYS, connection names), never a value. `reviewState` and
 * `capturedFromRunId` are the landing place for a Skill drafted from a run;
 * the partial unique index makes "one draft per run" a database guarantee.
 * `capturedFromRunId` has no FK — deleting a run must not delete a Skill.
 *
 * ## `skill_tags` — the queryable copy of `frontmatter.tags`
 *
 * One row per (Skill, tag), normalised (lower-case `[a-z0-9-]`, 40 chars,
 * 12 per Skill). FKs to `skills` and `users` CASCADE. The backfill below
 * reads every existing Skill's frontmatter in pages and inserts its tags with
 * a conflict-ignoring insert, so a second `up()` adds nothing. The normaliser
 * is inlined rather than imported: a migration is a frozen snapshot and must
 * keep producing the same rows even if the runtime normaliser changes later.
 *
 * Forward-only + idempotent (`hasTable` / `findColumnByName` / index-name
 * guards), portable `Table`/`TableColumn` DDL because production runs
 * Postgres while CI runs better-sqlite3. `down()` drops exactly what `up()`
 * added, in reverse, and touches no pre-existing column.
 */
export class AddSkillShelfReadinessAndTags1791110080000 implements MigrationInterface {
    name = 'AddSkillShelfReadinessAndTags1791110080000';

    private static readonly BACKFILL_PAGE = 500;
    private static readonly TAG_MAX_LENGTH = 40;
    private static readonly TAGS_PER_SKILL_MAX = 12;

    private static readonly SKILL_COLUMNS = [
        new TableColumn({ name: 'disabledAt', type: 'timestamp', isNullable: true }),
        new TableColumn({
            name: 'readiness',
            type: 'varchar',
            length: '24',
            default: "'unknown'",
        }),
        new TableColumn({ name: 'readinessDetail', type: 'text', isNullable: true }),
        new TableColumn({ name: 'readinessCheckedAt', type: 'timestamp', isNullable: true }),
        new TableColumn({ name: 'reviewState', type: 'varchar', length: '16', isNullable: true }),
        new TableColumn({ name: 'capturedFromRunId', type: 'uuid', isNullable: true }),
    ];

    private static readonly SKILL_INDEXES = [
        new TableIndex({
            name: 'idx_skills_user_readiness',
            columnNames: ['userId', 'readiness'],
        }),
        new TableIndex({
            name: 'idx_skills_readiness_checked',
            columnNames: ['readinessCheckedAt'],
        }),
        new TableIndex({
            name: 'uq_skills_captured_run',
            columnNames: ['capturedFromRunId'],
            isUnique: true,
            where: '"capturedFromRunId" IS NOT NULL',
        }),
    ];

    private static readonly TAG_INDEXES = [
        new TableIndex({
            name: 'uq_skill_tags_skill_tag',
            columnNames: ['skillId', 'tag'],
            isUnique: true,
        }),
        new TableIndex({ name: 'idx_skill_tags_user_tag', columnNames: ['userId', 'tag'] }),
        new TableIndex({ name: 'idx_skill_tags_skill', columnNames: ['skillId'] }),
    ];

    private static readonly TAG_FKS = [
        new TableForeignKey({
            name: 'fk_skill_tags_skill',
            columnNames: ['skillId'],
            referencedTableName: 'skills',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_skill_tags_user',
            columnNames: ['userId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const skills = await queryRunner.getTable('skills');
        if (skills) {
            for (const column of AddSkillShelfReadinessAndTags1791110080000.SKILL_COLUMNS) {
                const current = await queryRunner.getTable('skills');
                if (!current?.findColumnByName(column.name)) {
                    await queryRunner.addColumn('skills', column);
                }
            }
            await this.ensureIndexes(
                queryRunner,
                'skills',
                AddSkillShelfReadinessAndTags1791110080000.SKILL_INDEXES,
            );
        }

        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('skill_tags'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'skill_tags',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'skillId', type: 'uuid' },
                        { name: 'userId', type: 'uuid' },
                        { name: 'tag', type: 'varchar', length: '40' },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        await this.ensureIndexes(
            queryRunner,
            'skill_tags',
            AddSkillShelfReadinessAndTags1791110080000.TAG_INDEXES,
        );
        if (skills) {
            await this.ensureForeignKeys(
                queryRunner,
                'skill_tags',
                AddSkillShelfReadinessAndTags1791110080000.TAG_FKS,
            );
            await this.backfillTags(queryRunner);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('skill_tags')) {
            await queryRunner.dropTable('skill_tags', true, true, true);
        }
        for (const index of [
            ...AddSkillShelfReadinessAndTags1791110080000.SKILL_INDEXES,
        ].reverse()) {
            const table = await queryRunner.getTable('skills');
            if (table?.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.dropIndex('skills', index.name as string);
            }
        }
        // `dropColumn` (not raw SQL) and a fresh `getTable` per drop: the
        // query runner rebuilds the table on drivers that cannot drop a
        // column in place, and each rebuild replaces the Table object.
        for (const column of [
            ...AddSkillShelfReadinessAndTags1791110080000.SKILL_COLUMNS,
        ].reverse()) {
            const table = await queryRunner.getTable('skills');
            const existing = table?.findColumnByName(column.name);
            if (existing) {
                await queryRunner.dropColumn('skills', existing);
            }
        }
    }

    /**
     * Copy every existing Skill's `frontmatter.tags` into `skill_tags`.
     * Paged by id so a large table never loads at once; conflict-ignoring
     * insert so re-running inserts nothing new. A frontmatter that is not
     * valid JSON, or whose `tags` is not an array, contributes no rows.
     */
    private async backfillTags(queryRunner: QueryRunner): Promise<void> {
        const page = AddSkillShelfReadinessAndTags1791110080000.BACKFILL_PAGE;
        let lastId: string | null = null;
        for (;;) {
            const qb = queryRunner.manager
                .createQueryBuilder()
                // Quoted identifiers: the table has no entity metadata here,
                // so nothing would quote the camelCase names for Postgres.
                .select('"s"."id"', 'id')
                .addSelect('"s"."userId"', 'userId')
                .addSelect('"s"."frontmatter"', 'frontmatter')
                .addSelect('"s"."tenantId"', 'tenantId')
                .addSelect('"s"."organizationId"', 'organizationId')
                .from('skills', 's')
                .orderBy('"s"."id"', 'ASC')
                .limit(page);
            if (lastId) qb.where('"s"."id" > :lastId', { lastId });
            const rows: Array<{
                id: string;
                userId: string;
                frontmatter: unknown;
                tenantId: string | null;
                organizationId: string | null;
            }> = await qb.getRawMany();
            if (rows.length === 0) break;

            const values: Array<Record<string, unknown>> = [];
            for (const row of rows) {
                for (const tag of AddSkillShelfReadinessAndTags1791110080000.tagsOf(
                    row.frontmatter,
                )) {
                    values.push({
                        id: randomUUID(),
                        skillId: row.id,
                        userId: row.userId,
                        tag,
                        tenantId: row.tenantId ?? null,
                        organizationId: row.organizationId ?? null,
                    });
                }
            }
            if (values.length > 0) {
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into('skill_tags', [
                        'id',
                        'skillId',
                        'userId',
                        'tag',
                        'tenantId',
                        'organizationId',
                    ])
                    .values(values)
                    .orIgnore()
                    .execute();
            }

            lastId = rows[rows.length - 1].id;
            if (rows.length < page) break;
        }
    }

    /** Frozen copy of the shelf's tag normaliser (see the file header). */
    static tagsOf(frontmatter: unknown): string[] {
        let parsed: unknown = frontmatter;
        if (typeof frontmatter === 'string') {
            try {
                parsed = JSON.parse(frontmatter);
            } catch {
                return [];
            }
        }
        if (!parsed || typeof parsed !== 'object') return [];
        const raw = (parsed as { tags?: unknown }).tags;
        if (!Array.isArray(raw)) return [];
        const out: string[] = [];
        for (const entry of raw) {
            if (typeof entry !== 'string') continue;
            const tag = entry
                .trim()
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9-]/g, '')
                .replace(/-{2,}/g, '-')
                .replace(/^-+/, '')
                .slice(0, AddSkillShelfReadinessAndTags1791110080000.TAG_MAX_LENGTH)
                .replace(/-+$/, '');
            if (!tag || out.includes(tag)) continue;
            out.push(tag);
            if (out.length === AddSkillShelfReadinessAndTags1791110080000.TAGS_PER_SKILL_MAX) break;
        }
        return out;
    }

    private async ensureIndexes(
        queryRunner: QueryRunner,
        tableName: string,
        indexes: readonly TableIndex[],
    ): Promise<void> {
        for (const index of indexes) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex(tableName, index);
            }
        }
    }

    private async ensureForeignKeys(
        queryRunner: QueryRunner,
        tableName: string,
        foreignKeys: readonly TableForeignKey[],
    ): Promise<void> {
        for (const foreignKey of foreignKeys) {
            const table = await queryRunner.getTable(tableName);
            if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
                await queryRunner.createForeignKey(tableName, foreignKey);
            }
        }
    }
}
