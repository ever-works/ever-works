import { MigrationInterface, QueryRunner, Table, TableColumn, TableIndex } from 'typeorm';

/**
 * Skills — invocation slugs + companion files.
 *
 * ## What
 *
 * 1. `skills.invocationSlug` (varchar(64) NULL) — the optional user-facing
 *    slash command (`/plan`) that resolves a skill from a chat message.
 *    Uniqueness is PER USER and enforced in `SkillsService` (409 naming the
 *    conflicting skill), so the index here is non-unique — it serves the
 *    `(userId, invocationSlug)` lookup on every slash-prefixed message.
 *
 * 2. `skill_files` — metadata rows for a skill's companion files (scripts /
 *    references / configs / assets). The BYTES live in the uploads spine
 *    (`user_uploads` + the active Storage plugin), keyed by `uploadId`
 *    (the upload's sha256); this table carries the skill-facing filename,
 *    kind, size and mime. `unique(skillId, filename)` makes a re-upload of
 *    the same name a 409, not a second row.
 *
 * ## Additive
 *
 * One nullable column + one new table. Nothing to backfill: no skill had a
 * slash command or files before this deploy.
 *
 * Built with TypeORM's portable Table/TableColumn API because CI and the
 * e2e stack run better-sqlite3 while production runs Postgres. Forward-only
 * with idempotent guards (house pattern, mirrors 1785000000000-CreateTermsAcceptance).
 */
export class AddSkillInvocationSlugAndSkillFiles1785010000000 implements MigrationInterface {
    name = 'AddSkillInvocationSlugAndSkillFiles1785010000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasColumn('skills', 'invocationSlug'))) {
            await queryRunner.addColumn(
                'skills',
                new TableColumn({
                    name: 'invocationSlug',
                    type: 'varchar',
                    length: '64',
                    isNullable: true,
                }),
            );
            await queryRunner.createIndex(
                'skills',
                new TableIndex({
                    name: 'idx_skills_user_invocation',
                    columnNames: ['userId', 'invocationSlug'],
                }),
            );
        }

        if (await queryRunner.hasTable('skill_files')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'skill_files',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'skillId', type: 'uuid' },
                    { name: 'userId', type: 'uuid' },
                    // sha256 content hash — the upload id in `user_uploads`.
                    { name: 'uploadId', type: 'varchar', length: '64' },
                    { name: 'filename', type: 'varchar', length: '255' },
                    // 'script' | 'reference' | 'asset' | 'config'
                    { name: 'kind', type: 'varchar', length: '16' },
                    { name: 'sizeBytes', type: 'int' },
                    { name: 'mime', type: 'varchar', length: '128' },
                    // EW-657 Tier C scope columns (NULL until org backfill).
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
                foreignKeys: [
                    {
                        columnNames: ['skillId'],
                        referencedTableName: 'skills',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                    {
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'skill_files',
            new TableIndex({
                name: 'uq_skill_files_skill_filename',
                columnNames: ['skillId', 'filename'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'skill_files',
            new TableIndex({
                name: 'idx_skill_files_skill',
                columnNames: ['skillId'],
            }),
        );
        await queryRunner.createIndex(
            'skill_files',
            new TableIndex({
                name: 'idx_skill_files_user',
                columnNames: ['userId'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('skill_files')) {
            await queryRunner.dropTable('skill_files');
        }
        if (await queryRunner.hasColumn('skills', 'invocationSlug')) {
            await queryRunner.dropIndex('skills', 'idx_skills_user_invocation');
            await queryRunner.dropColumn('skills', 'invocationSlug');
        }
    }
}
