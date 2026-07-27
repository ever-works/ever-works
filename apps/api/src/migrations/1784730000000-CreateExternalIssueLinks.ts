import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Event-ingest spine — creates the `external_issue_links` table, the
 * external tracker issue ↔ platform Task mapping.
 *
 * Entity: `packages/agent/src/entities/external-issue-link.entity.ts`
 *
 * **Schema notes:**
 *   - UNIQUE `(userId, source, externalIssueId)` — an external issue maps
 *     to at most ONE Task per owner. This is the load-bearing constraint:
 *     it makes "is this issue already linked?" a single indexed lookup on
 *     the ingest drain, and it makes re-linking an idempotent upsert
 *     instead of a duplicate row. Scoping the uniqueness by `userId` (not
 *     globally) is what lets two customers connect the same public
 *     repository without colliding — or seeing each other's Tasks.
 *   - The REVERSE direction is intentionally non-unique: one Task may
 *     mirror several issues (an epic plus its tracking issue), so
 *     `idx_external_issue_links_task` is a plain index.
 *   - `lastIngestedEventId` / `lastSeenAt` are freshness breadcrumbs
 *     stamped by the drain; the link is valid with both NULL.
 *   - Scope columns (`tenantId`, `organizationId`) are raw uuid
 *     references — no entity-level @ManyToOne (cycle avoidance per
 *     EW-654).
 *   - FK `userId` → `users.id` ON DELETE CASCADE and FK `taskId` →
 *     `tasks.id` ON DELETE CASCADE: a link is meaningless without either
 *     side, and a dangling link would silently re-point a future issue at
 *     a deleted Task.
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1784200000000-CreateIngestInstallBindings`.
 */
export class CreateExternalIssueLinks1784730000000 implements MigrationInterface {
    name = 'CreateExternalIssueLinks1784730000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('external_issue_links')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'external_issue_links',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'taskId', type: 'uuid' },
                    { name: 'source', type: 'varchar', length: '100' },
                    { name: 'externalIssueId', type: 'varchar', length: '200' },
                    { name: 'externalKey', type: 'varchar', length: '100', isNullable: true },
                    { name: 'title', type: 'varchar', length: '500', isNullable: true },
                    { name: 'url', type: 'varchar', length: '2048', isNullable: true },
                    { name: 'lastIngestedEventId', type: 'uuid', isNullable: true },
                    { name: 'lastSeenAt', type: 'timestamp', isNullable: true },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // One Task per external issue per owner — see the schema note.
        await queryRunner.createIndex(
            'external_issue_links',
            new TableIndex({
                name: 'uq_external_issue_links_identity',
                columnNames: ['userId', 'source', 'externalIssueId'],
                isUnique: true,
            }),
        );

        // "Which issues does this Task mirror?" — deliberately non-unique.
        await queryRunner.createIndex(
            'external_issue_links',
            new TableIndex({
                name: 'idx_external_issue_links_task',
                columnNames: ['taskId'],
            }),
        );

        await queryRunner.createForeignKey(
            'external_issue_links',
            new TableForeignKey({
                name: 'fk_external_issue_links_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createForeignKey(
            'external_issue_links',
            new TableForeignKey({
                name: 'fk_external_issue_links_task',
                columnNames: ['taskId'],
                referencedTableName: 'tasks',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('external_issue_links')) {
            await queryRunner.dropTable('external_issue_links', true);
        }
    }
}
