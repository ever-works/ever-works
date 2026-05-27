import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Adds three Mission/Idea/Agent → Upload edge tables. Mirrors the
 * `task_attachments` table from the 1779978013000 CreateTasksTables
 * migration so the surfaces stay symmetric.
 *
 * For each table:
 *   - `id` uuid PK (generated)
 *   - `<parent>Id` uuid NOT NULL, FK to the parent table with
 *     ON DELETE CASCADE so cleaning up the Mission / Idea / Agent
 *     also clears its attachment edges
 *   - `uploadId` varchar(64) NOT NULL — SHA-256 content hash returned
 *     as `id` by POST /api/uploads/file. Stored as varchar(64) rather
 *     than uuid because sha256 isn't UUID-shaped (Codex + Greptile P1
 *     on PR #1044). No DB-level FK — the upload pipeline can GC the
 *     storage object independently; service-layer validates the hash
 *     shape on insert.
 *   - `createdAt` timestamp NOT NULL default now()
 *   - unique index on (`<parent>Id`, `uploadId`) — same Upload can
 *     only be attached to the same parent once
 *   - secondary index on `uploadId` for the "what's referencing this
 *     upload?" query
 *
 * Idempotent: each `CREATE TABLE` is guarded by `hasTable`, each index
 * by name lookup. Re-runs are no-ops.
 */
export class CreateMissionIdeaAgentAttachmentTables1779991000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.createAttachmentTable(queryRunner, {
            tableName: 'mission_attachments',
            parentTable: 'missions',
            parentColumn: 'missionId',
            uniqueIndexName: 'uq_mission_attachment',
            uploadIndexName: 'idx_mission_attachment_upload',
        });
        await this.createAttachmentTable(queryRunner, {
            tableName: 'work_proposal_attachments',
            parentTable: 'work_proposals',
            parentColumn: 'workProposalId',
            uniqueIndexName: 'uq_work_proposal_attachment',
            uploadIndexName: 'idx_work_proposal_attachment_upload',
        });
        await this.createAttachmentTable(queryRunner, {
            tableName: 'agent_attachments',
            parentTable: 'agents',
            parentColumn: 'agentId',
            uniqueIndexName: 'uq_agent_attachment',
            uploadIndexName: 'idx_agent_attachment_upload',
        });
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverse order for cleanliness; each drop is idempotent via
        // `hasTable` check.
        for (const name of [
            'agent_attachments',
            'work_proposal_attachments',
            'mission_attachments',
        ]) {
            if (await queryRunner.hasTable(name)) {
                await queryRunner.dropTable(name, true);
            }
        }
    }

    private async createAttachmentTable(
        queryRunner: QueryRunner,
        opts: {
            tableName: string;
            parentTable: string;
            parentColumn: string; // FK column name on this table
            uniqueIndexName: string;
            uploadIndexName: string;
        },
    ): Promise<void> {
        const { tableName, parentTable, parentColumn, uniqueIndexName, uploadIndexName } = opts;

        if (!(await queryRunner.hasTable(tableName))) {
            await queryRunner.createTable(
                new Table({
                    name: tableName,
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            isGenerated: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: parentColumn, type: 'uuid', isNullable: false },
                        // SHA-256 content hash — varchar(64) not uuid.
                        // See header comment for the Codex/Greptile P1.
                        { name: 'uploadId', type: 'varchar', length: '64', isNullable: false },
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
            // Create the FK separately so the migration is friendlier to
            // schema diffing (TypeORM names the inline-declared FK
            // unpredictably otherwise).
            await queryRunner.createForeignKey(
                tableName,
                new TableForeignKey({
                    columnNames: [parentColumn],
                    referencedTableName: parentTable,
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        await this.ensureIndex(
            queryRunner,
            tableName,
            uniqueIndexName,
            [parentColumn, 'uploadId'],
            true,
        );
        await this.ensureIndex(queryRunner, tableName, uploadIndexName, ['uploadId'], false);
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
            // Same defensive shape used by the tasks migration: if the
            // index already exists with the right columns + uniqueness,
            // leave it. Otherwise drop and recreate — keeps in-dev
            // re-runs honest.
            const sameColumns =
                existing.columnNames.length === columnNames.length &&
                existing.columnNames.every((c, i) => c === columnNames[i]) &&
                (existing.isUnique ?? false) === isUnique;
            if (sameColumns) return;
            await queryRunner.dropIndex(tableName, indexName);
        }
        await queryRunner.createIndex(
            tableName,
            new TableIndex({
                name: indexName,
                columnNames,
                isUnique,
            }),
        );
    }
}
