import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Memory Files — the `memory_folders` table backing the Files area of
 * /memory: user-defined folders that organize files from BOTH upload
 * spines (`user_uploads` + `work_knowledge_uploads`) without moving any
 * bytes.
 *
 * Shape notes:
 *  - `path` is the MATERIALIZED absolute path (`/a/b`), unique per
 *    `userId` and maintained by `MemoryFoldersService` (subtree rewrite
 *    on rename/move). It exists so subtree queries are one `LIKE`.
 *  - `parentId` is a raw uuid adjacency column — deliberately NO
 *    self-referencing FK: the service deletes whole subtrees in one
 *    statement and a self-FK would force child-before-parent ordering
 *    for zero safety gain (orphan prevention is the service's subtree
 *    invariant, checked in its unit tests).
 *  - `ownerAgentId` NULL = Global folder (visible to every agent); set =
 *    private to that one agent. Raw uuid, no FK — agents are Tier B rows
 *    and the folder must survive an agent's deletion as a plain Global
 *    folder (the read path treats a dangling id as "owner gone").
 *  - `syncRepo` is `text` (TypeORM `simple-json`) holding repo
 *    COORDINATES only ({repoUrl, owner, repo, branch, dirPrefix}) —
 *    never credentials; the git facade resolves tokens at sync time.
 *  - Tier C scope columns (`tenantId`/`organizationId`) are stamped by
 *    `ScopeStampingSubscriber`; NO scope XOR CHECK (the stamping
 *    subscriber populates organizationId on ordinary rows — see the
 *    1784820000000-CreateWorkflows note for the incident this avoids).
 *
 * Portable DDL (Table/TableIndex/TableForeignKey — prod postgres, CI
 * better-sqlite3), forward-safe with an idempotent guard, house pattern.
 */
export class CreateMemoryFolders1786830000000 implements MigrationInterface {
    name = 'CreateMemoryFolders1786830000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('memory_folders')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'memory_folders',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'name', type: 'varchar', length: '120' },
                    { name: 'parentId', type: 'uuid', isNullable: true },
                    { name: 'path', type: 'varchar', length: '512' },
                    { name: 'ownerAgentId', type: 'uuid', isNullable: true },
                    // simple-json ⇒ text on every supported driver.
                    { name: 'syncRepo', type: 'text', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'memory_folders',
            new TableIndex({
                name: 'uq_memory_folders_user_path',
                columnNames: ['userId', 'path'],
                isUnique: true,
            }),
        );
        await queryRunner.createIndex(
            'memory_folders',
            new TableIndex({
                name: 'idx_memory_folders_user_parent',
                columnNames: ['userId', 'parentId'],
            }),
        );

        // Guarded on the users table existing so a fresh database whose
        // earlier migrations have not run yet cannot explode here.
        if (await queryRunner.hasTable('users')) {
            await queryRunner.createForeignKey(
                'memory_folders',
                new TableForeignKey({
                    name: 'fk_memory_folders_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Reverting discards the user's folder ORGANIZATION (the tree),
        // but never any file: uploads reference folders via nullable
        // folderId columns that the companion migration removes/nulls.
        if (await queryRunner.hasTable('memory_folders')) {
            await queryRunner.dropTable('memory_folders');
        }
    }
}
