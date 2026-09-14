import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * What's new (AW-14) — the `product_changelog_reads` table.
 *
 * Entity: `packages/agent/src/entities/product-changelog-read.entity.ts`
 *
 * ONE table, holding per-person read state for product changelog entries.
 * The entries themselves are not stored: they come from the changelog
 * content source that ships with the build (`apps/api/src/changelog/`), so
 * a deployment can never describe a feature its running build lacks, and a
 * rollback takes its entries with it.
 *
 * ## Why there is no backfill
 *
 * "Everything published before your account existed counts as read" (spec
 * FR-14) is answered by comparing an entry's publish date with
 * `users.createdAt` at query time. No rows are written for existing
 * accounts, and every one of them sees a correct count on the first request
 * after deploy.
 *
 * ## Shape
 *
 * - UNIQUE `(userId, entrySlug)` — the idempotency guarantee. Marking read
 *   inserts with ON CONFLICT DO NOTHING against it, so a repeat, or two tabs
 *   marking the same entry at once, leaves exactly one row.
 * - `idx_product_changelog_read_user` — every read is keyed by the person.
 * - FK `userId` → `users.id` ON DELETE CASCADE. `entrySlug` has no FK: it
 *   points into the build, not into a table.
 * - Deliberately no `tenantId` / `organizationId`: read state follows the
 *   person, never the active Organization (spec FR-13).
 *
 * Forward-only + idempotent (`hasTable` guard), and portable `Table` DDL
 * rather than raw SQL, because production runs Postgres while CI runs
 * better-sqlite3. `down()` drops only the table `up()` created.
 */
export class CreateProductChangelogReads1791140000000 implements MigrationInterface {
    name = 'CreateProductChangelogReads1791140000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('product_changelog_reads')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'product_changelog_reads',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'entrySlug', type: 'varchar', length: '64' },
                    { name: 'readAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'product_changelog_reads',
            new TableIndex({
                name: 'uq_product_changelog_read_user_entry',
                columnNames: ['userId', 'entrySlug'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'product_changelog_reads',
            new TableIndex({
                name: 'idx_product_changelog_read_user',
                columnNames: ['userId'],
            }),
        );

        await queryRunner.createForeignKey(
            'product_changelog_reads',
            new TableForeignKey({
                name: 'fk_product_changelog_read_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('product_changelog_reads')) {
            await queryRunner.dropTable('product_changelog_reads', true);
        }
    }
}
