import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Domain-model evolution PR-1 (docs/architecture/domain-model-review.md §23.1
 * + ADR-009 ruling "1 Idea → 0..N Works"):
 *
 * 1. Creates `idea_works` — the authoritative Idea↔Work provenance link
 *    (kind: 'built' | 'linked' | 'rebuilt', append-only, unique per
 *    (ideaId, workId), CASCADE with either endpoint or the owning user).
 *
 * 2. Backfill A — seeds one `idea_works` row per existing
 *    `work_proposals.acceptedWorkId` link, `kind = 'linked'` (the
 *    conservative default from review §17 Phase 2c: pre-existing links
 *    cannot be reliably classified as built-vs-linked, so none are
 *    invented). The join against `works` skips dangling pointers left by
 *    Work deletions (`acceptedWorkId` is ON DELETE SET NULL, but belt +
 *    suspenders for rows mutated mid-migration).
 *
 * 3. Backfill B — repairs the dead reverse pointer found by the review
 *    (verified finding P1): stamps `works.acceptedFromIdeaId` from the
 *    Idea-side `acceptedWorkId` wherever it is still NULL. Only NULL rows
 *    are touched (a Work keeps at most one source Idea, first-writer-wins).
 *
 * Idempotent: table create is `hasTable`-guarded, indexes checked by name,
 * Backfill A uses ON CONFLICT DO NOTHING against the unique index,
 * Backfill B filters on `"acceptedFromIdeaId" IS NULL`. Re-runs are no-ops.
 *
 * down(): drops the table only. Backfill B's stamped `acceptedFromIdeaId`
 * values are left in place — the column pre-exists this migration
 * (1779978008000) and stamped values are correct data, not schema.
 */
export class CreateIdeaWorksTable1781600000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('idea_works'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'idea_works',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'ideaId', type: 'uuid', isNullable: false },
                        { name: 'workId', type: 'uuid', isNullable: false },
                        { name: 'userId', type: 'uuid', isNullable: false },
                        { name: 'kind', type: 'varchar', length: '16', isNullable: false },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        {
                            name: 'createdAt',
                            type: 'timestamp',
                            default: 'now()',
                            isNullable: false,
                        },
                    ],
                }),
                true,
            );
            // FKs created separately for predictable naming (same pattern as
            // 1779991006500-CreateMissionIdeaAgentAttachmentTables).
            await queryRunner.createForeignKey(
                'idea_works',
                new TableForeignKey({
                    columnNames: ['ideaId'],
                    referencedTableName: 'work_proposals',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'idea_works',
                new TableForeignKey({
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'idea_works',
                new TableForeignKey({
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        await this.ensureIndex(
            queryRunner,
            'idea_works',
            'uq_idea_work',
            ['ideaId', 'workId'],
            true,
        );
        await this.ensureIndex(queryRunner, 'idea_works', 'idx_idea_works_work', ['workId'], false);

        // Backfill A — seed provenance rows from the existing single-link
        // pointer. Conservative kind='linked' (review §17 Phase 2c).
        await queryRunner.query(`
            INSERT INTO idea_works ("ideaId", "workId", "userId", "kind", "tenantId", "organizationId")
            SELECT wp.id, wp."acceptedWorkId", wp."userId", 'linked', wp."tenantId", wp."organizationId"
            FROM work_proposals wp
            INNER JOIN works w ON w.id = wp."acceptedWorkId"
            WHERE wp."acceptedWorkId" IS NOT NULL
            ON CONFLICT ("ideaId", "workId") DO NOTHING
        `);

        // Backfill B — stamp the dead reverse pointer (review finding P1).
        // Only rows still NULL are touched, and when several Ideas point at
        // the same Work (a re-linked Work), the OLDEST Idea wins
        // deterministically (DISTINCT ON + generatedAt ASC) — the earliest
        // link is the Work's true origin (Greptile P2 on PR #1689).
        await queryRunner.query(`
            UPDATE works w
            SET "acceptedFromIdeaId" = origin.id
            FROM (
                SELECT DISTINCT ON ("acceptedWorkId") id, "acceptedWorkId"
                FROM work_proposals
                WHERE "acceptedWorkId" IS NOT NULL
                ORDER BY "acceptedWorkId", "generatedAt" ASC, id ASC
            ) origin
            WHERE origin."acceptedWorkId" = w.id
              AND w."acceptedFromIdeaId" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('idea_works')) {
            await queryRunner.dropTable('idea_works', true);
        }
    }

    private async ensureIndex(
        queryRunner: QueryRunner,
        tableName: string,
        indexName: string,
        columnNames: string[],
        isUnique: boolean,
    ): Promise<void> {
        const table = await queryRunner.getTable(tableName);
        const existing = table?.indices.find((idx) => idx.name === indexName);
        if (existing) {
            const same =
                existing.columnNames.length === columnNames.length &&
                existing.columnNames.every((c, i) => c === columnNames[i]) &&
                (existing.isUnique ?? false) === isUnique;
            if (same) return;
            await queryRunner.dropIndex(tableName, indexName);
        }
        await queryRunner.createIndex(
            tableName,
            new TableIndex({ name: indexName, columnNames, isUnique }),
        );
    }
}
