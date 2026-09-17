import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Workspace backup (AW-22, slot 00) — the `workspace_backups` table.
 *
 * Entity: `packages/agent/src/entities/workspace-backup.entity.ts`
 *
 * ONE table, holding one row per attempt to produce a complete archive of
 * one workspace. Nothing else in the schema changes: a backup READS the
 * fifteen domains it exports and writes only here, so the export/import/
 * config-repo-sync path that ships today is untouched by this migration.
 *
 * ## Why there is no backfill
 *
 * "You have not taken a backup yet" is the correct answer for every
 * existing workspace, and it is what an empty table says. Synthesising rows
 * for the stateless exports people have already run would claim archives
 * that do not exist and cannot be downloaded.
 *
 * ## Shape
 *
 * - `idx_workspace_backups_scope` on `(userId, organizationId, requestedAt)`
 *   — the history read, which is always "this workspace, newest first".
 * - `idx_workspace_backups_sweep` on `(status, expiresAt)` — the hourly
 *   sweeper's three passes (expire artefacts, fail stalls, prune records).
 * - `uq_workspace_backups_active` — a PARTIAL unique index enforcing spec
 *   FR-3 (one backup queued or running per workspace) at the database, so
 *   two tabs pressing Create cannot race past an application check. It is
 *   raw SQL guarded on Postgres for two reasons: `WHERE` clauses on indexes
 *   are not portable through TypeORM's `TableIndex`, and a non-partial
 *   equivalent would reject the SECOND backup a workspace ever took. The
 *   better-sqlite3 test driver therefore relies on the service's
 *   compare-and-set, which is the same code path Postgres takes before it
 *   ever reaches the index. `work_budgets` made the same call for the same
 *   reason.
 * - `COALESCE(organizationId, <nil uuid>)` in the index expression, because
 *   Postgres treats NULLs as distinct — without it the un-organized
 *   workspace could start unlimited concurrent backups.
 * - FK `userId` → `users.id` ON DELETE CASCADE: deleting the account takes
 *   its backup records with it. The archive bytes are removed separately by
 *   the sweeper, which reads `storageKey` before the row disappears.
 *
 * Forward-only and idempotent (`hasTable` guard), and portable `Table` DDL
 * rather than raw SQL for everything except the partial index, because
 * production runs Postgres while CI runs better-sqlite3. Timestamp defaults
 * are `CURRENT_TIMESTAMP` rather than `now()` for the same reason — `now()`
 * is a Postgres function and every insert under the better-sqlite3 test
 * driver would fail on it. `down()` drops only the table `up()` created.
 */
export class CreateWorkspaceBackups1791220000000 implements MigrationInterface {
    name = 'CreateWorkspaceBackups1791220000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('workspace_backups')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'workspace_backups',
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
                    { name: 'status', type: 'varchar', length: '24' },
                    { name: 'failureReason', type: 'varchar', length: '32', isNullable: true },
                    { name: 'failureDetail', type: 'text', isNullable: true },
                    { name: 'includeFullHistory', type: 'boolean', default: false },
                    { name: 'formatVersion', type: 'varchar', length: '16' },
                    { name: 'buildRef', type: 'varchar', length: '64', isNullable: true },
                    { name: 'requestedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                    { name: 'startedAt', type: 'timestamp', isNullable: true },
                    { name: 'finishedAt', type: 'timestamp', isNullable: true },
                    { name: 'lastHeartbeatAt', type: 'timestamp', isNullable: true },
                    { name: 'progressPercent', type: 'int', default: 0 },
                    { name: 'currentDomain', type: 'varchar', length: '48', isNullable: true },
                    { name: 'domainsCompleted', type: 'int', default: 0 },
                    { name: 'domainsTotal', type: 'int', default: 15 },
                    { name: 'manifestSummary', type: 'text', isNullable: true },
                    { name: 'storageBackend', type: 'varchar', length: '32', isNullable: true },
                    { name: 'storageKey', type: 'varchar', length: '512', isNullable: true },
                    { name: 'sizeBytes', type: 'bigint', isNullable: true },
                    { name: 'sha256', type: 'varchar', length: '64', isNullable: true },
                    { name: 'fileCount', type: 'int', default: 0 },
                    { name: 'omittedFileCount', type: 'int', default: 0 },
                    { name: 'expiresAt', type: 'timestamp', isNullable: true },
                    { name: 'artifactDeletedAt', type: 'timestamp', isNullable: true },
                    { name: 'downloadCount', type: 'int', default: 0 },
                    { name: 'lastDownloadedAt', type: 'timestamp', isNullable: true },
                    { name: 'runtimeRunId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'credentialVersion', type: 'int', isNullable: true },
                    { name: 'updatedAt', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'workspace_backups',
            new TableIndex({
                name: 'idx_workspace_backups_scope',
                columnNames: ['userId', 'organizationId', 'requestedAt'],
            }),
        );

        await queryRunner.createIndex(
            'workspace_backups',
            new TableIndex({
                name: 'idx_workspace_backups_sweep',
                columnNames: ['status', 'expiresAt'],
            }),
        );

        await queryRunner.createForeignKey(
            'workspace_backups',
            new TableForeignKey({
                name: 'fk_workspace_backups_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        if (queryRunner.connection.options.type === 'postgres') {
            await queryRunner.query(
                `CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_backups_active" ` +
                    `ON "workspace_backups" ("userId", COALESCE("organizationId", '00000000-0000-0000-0000-000000000000'::uuid)) ` +
                    `WHERE "status" IN ('queued', 'running')`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('workspace_backups')) {
            await queryRunner.dropTable('workspace_backups', true);
        }
    }
}
