import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Shared view (AW-18, phase 1) — the `shared_views` table.
 *
 * Entity: `packages/agent/src/entities/shared-view.entity.ts`
 *
 * ONE table, one row per Workspace that has ever turned sharing on. It holds
 * what the share link publishes (sections, knowledge classes, crawler
 * posture), the token as `sha256` hash plus an encrypted re-copyable copy,
 * and the view counters. The published content itself is never stored: it
 * is projected live from the Workspace's Task board on every read.
 *
 * ## Shape
 *
 * - UNIQUE `organizationId` — at most one Shared view per Workspace.
 * - UNIQUE `tokenHash` — the public path's single indexed lookup.
 * - `idx_shared_views_tenant` — the Tier-A scope column.
 * - FK `organizationId` → `organizations.id` ON DELETE CASCADE, so deleting a
 *   Workspace deletes its link in the same transaction.
 * - FKs `ownerUserId` / `createdById` → `users.id` ON DELETE CASCADE: a link
 *   must not outlive the person who published it.
 * - `sections`, `knowledgeClasses` and `tokenEncrypted` are `text` because
 *   the entity maps them as `simple-json` (portable across Postgres and
 *   better-sqlite3); the service always writes them, so they carry no DB
 *   default.
 *
 * Forward-only + idempotent (`hasTable` / index-name / FK-name guards), and
 * portable `Table` DDL because production runs Postgres while CI runs
 * better-sqlite3. `down()` drops only the table `up()` created.
 */
export class CreateSharedViews1791180000000 implements MigrationInterface {
    name = 'CreateSharedViews1791180000000';

    private static readonly INDEXES = [
        new TableIndex({
            name: 'uq_shared_views_organization',
            columnNames: ['organizationId'],
            isUnique: true,
        }),
        new TableIndex({
            name: 'uq_shared_views_token_hash',
            columnNames: ['tokenHash'],
            isUnique: true,
        }),
        new TableIndex({ name: 'idx_shared_views_tenant', columnNames: ['tenantId'] }),
    ];

    private static readonly FOREIGN_KEYS = [
        new TableForeignKey({
            name: 'fk_shared_views_organization',
            columnNames: ['organizationId'],
            referencedTableName: 'organizations',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_shared_views_owner_user',
            columnNames: ['ownerUserId'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
        new TableForeignKey({
            name: 'fk_shared_views_created_by',
            columnNames: ['createdById'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
        }),
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        const isPostgres = queryRunner.connection.options.type === 'postgres';

        if (!(await queryRunner.hasTable('shared_views'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'shared_views',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: isPostgres ? 'uuid_generate_v4()' : undefined,
                        },
                        { name: 'organizationId', type: 'uuid' },
                        { name: 'tenantId', type: 'uuid' },
                        { name: 'ownerUserId', type: 'uuid' },
                        { name: 'tokenHash', type: 'varchar', length: '64' },
                        { name: 'tokenEncrypted', type: 'text' },
                        { name: 'status', type: 'varchar', length: '16', default: "'active'" },
                        { name: 'sections', type: 'text' },
                        { name: 'knowledgeClasses', type: 'text' },
                        { name: 'searchIndexable', type: 'boolean', default: false },
                        { name: 'viewCount', type: 'int', default: 0 },
                        { name: 'lastViewedAt', type: 'timestamp', isNullable: true },
                        { name: 'firstViewNotifiedAt', type: 'timestamp', isNullable: true },
                        { name: 'tokenRotatedAt', type: 'timestamp', isNullable: true },
                        { name: 'rotationCount', type: 'int', default: 0 },
                        { name: 'createdById', type: 'uuid' },
                        { name: 'createdAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                        { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    ],
                }),
                true,
            );
        }

        for (const index of CreateSharedViews1791180000000.INDEXES) {
            const table = await queryRunner.getTable('shared_views');
            if (table && !table.indices.some((existing) => existing.name === index.name)) {
                await queryRunner.createIndex('shared_views', index);
            }
        }

        for (const foreignKey of CreateSharedViews1791180000000.FOREIGN_KEYS) {
            const table = await queryRunner.getTable('shared_views');
            if (table && !table.foreignKeys.some((existing) => existing.name === foreignKey.name)) {
                await queryRunner.createForeignKey('shared_views', foreignKey);
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('shared_views')) {
            await queryRunner.dropTable('shared_views', true, true, true);
        }
    }
}
