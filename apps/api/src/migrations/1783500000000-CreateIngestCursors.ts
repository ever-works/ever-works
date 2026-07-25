import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Event-ingest pull path (Wave 8) — creates the `ingest_cursors` table
 * backing the event-source pull half of the `event-ingest-tick` cron:
 * one row per (user, event-source plugin) holding the completed-sweep
 * `watermark` (handed to `pullEvents` as `since`), the plugin's opaque
 * continuation `cursor` when a sweep ran out of its per-tick page
 * budget, and `sweepStartedAt` so the watermark advances to when that
 * sweep BEGAN on completion (overlap is free — the ingest pipeline
 * dedupes on `(source, sourceEventId)`).
 *
 * Entity: `packages/agent/src/entities/ingest-cursor.entity.ts`
 * Service: `packages/agent/src/ingest/event-source-pull.service.ts`
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1783200000000-CreateIngestedEvents`.
 */
export class CreateIngestCursors1783500000000 implements MigrationInterface {
    name = 'CreateIngestCursors1783500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ingest_cursors')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'ingest_cursors',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'pluginId', type: 'varchar', length: '100' },
                    { name: 'cursor', type: 'text', isNullable: true },
                    { name: 'watermark', type: 'timestamp', isNullable: true },
                    { name: 'sweepStartedAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // One pull state per (user, plugin) — upserts key on this.
        await queryRunner.createIndex(
            'ingest_cursors',
            new TableIndex({
                name: 'idx_ingest_cursors_user_plugin',
                columnNames: ['userId', 'pluginId'],
                isUnique: true,
            }),
        );

        // Pull state is meaningless without its owner.
        await queryRunner.createForeignKey(
            'ingest_cursors',
            new TableForeignKey({
                name: 'fk_ingest_cursors_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ingest_cursors')) {
            await queryRunner.dropTable('ingest_cursors', true);
        }
    }
}
