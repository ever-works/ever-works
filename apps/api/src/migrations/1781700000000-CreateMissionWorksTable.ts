import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Domain-model evolution PR-2 (docs/specs/features/domain-model-evolution):
 * creates `mission_works` — the explicit Mission↔Work M:N relation with a
 * typed `relation` kind (created|improves|operates|markets|researches|retires),
 * unique per (missionId, workId, relation), CASCADE with either endpoint or
 * the owning user. Missions never own Works: this table is the ONLY link.
 *
 * Backfill: seeds `relation = 'created'` rows via the historical transitive
 * chain — `work_proposals.missionId` (Idea spawned by the Mission) joined to
 * `work_proposals.acceptedWorkId` (the Work the Idea produced/linked). Joins
 * against missions + works to skip dangling ids; ON CONFLICT no-ops re-runs.
 *
 * down(): drops the table only.
 */
export class CreateMissionWorksTable1781700000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('mission_works'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'mission_works',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'missionId', type: 'uuid', isNullable: false },
                        { name: 'workId', type: 'uuid', isNullable: false },
                        { name: 'userId', type: 'uuid', isNullable: false },
                        { name: 'relation', type: 'varchar', length: '16', isNullable: false },
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
            await queryRunner.createForeignKey(
                'mission_works',
                new TableForeignKey({
                    columnNames: ['missionId'],
                    referencedTableName: 'missions',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'mission_works',
                new TableForeignKey({
                    columnNames: ['workId'],
                    referencedTableName: 'works',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
            await queryRunner.createForeignKey(
                'mission_works',
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
            'mission_works',
            'uq_mission_work_relation',
            ['missionId', 'workId', 'relation'],
            true,
        );
        await this.ensureIndex(
            queryRunner,
            'mission_works',
            'idx_mission_works_work',
            ['workId'],
            false,
        );

        // Backfill — the Mission → Idea → Work chain becomes explicit
        // 'created' relations (review §17 Phase 2b).
        await queryRunner.query(`
            INSERT INTO mission_works ("missionId", "workId", "userId", "relation", "tenantId", "organizationId")
            SELECT wp."missionId", wp."acceptedWorkId", wp."userId", 'created', wp."tenantId", wp."organizationId"
            FROM work_proposals wp
            INNER JOIN missions m ON m.id = wp."missionId"
            INNER JOIN works w ON w.id = wp."acceptedWorkId"
            WHERE wp."missionId" IS NOT NULL
              AND wp."acceptedWorkId" IS NOT NULL
            ON CONFLICT ("missionId", "workId", "relation") DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('mission_works')) {
            await queryRunner.dropTable('mission_works', true);
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
