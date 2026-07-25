import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Event-ingest spine (Wave 6) — creates the `ingested_events` table
 * backing the generic connector pipeline: normalized external events
 * (`IngestedEventEnvelope`) land here via dedupe-insert, then the
 * `event-ingest-tick` cron drains unprocessed rows into the Activity
 * log + agent Memory with `sourceUrl` provenance.
 *
 * Entity: `packages/agent/src/entities/ingested-event.entity.ts`
 *
 * **Schema notes:**
 *   - `dedupeKey` (varchar(64), UNIQUE) — sha256 over
 *     `(userId, source, sourceEventId)`; makes connector re-delivery
 *     (webhook retries, overlapping pull windows, backfill) a no-op.
 *   - `payload` (text) — the entity's `simple-json` column; serialized
 *     size is capped at 32 KB upstream (DTO + service).
 *   - `processedAt` NULL = awaiting fan-out; the partial-scan index on
 *     it backs the cron's oldest-first batch read.
 *   - Scope columns (`organizationId`) are raw uuid references — no
 *     entity-level @ManyToOne (cycle avoidance per EW-654).
 *   - FK `userId` → `users.id` ON DELETE CASCADE (an ingested event is
 *     meaningless without its owner); FK `workId` → `works.id`
 *     ON DELETE SET NULL (deleting a Work must not delete the event —
 *     it just loses its Work routing).
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1782100000000-CreateInboundTriggers`.
 */
export class CreateIngestedEvents1783200000000 implements MigrationInterface {
    name = 'CreateIngestedEvents1783200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ingested_events')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'ingested_events',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'workId', type: 'uuid', isNullable: true },
                    { name: 'source', type: 'varchar', length: '100' },
                    { name: 'sourceEventId', type: 'varchar', length: '200' },
                    { name: 'kind', type: 'varchar', length: '100' },
                    { name: 'occurredAt', type: 'timestamp' },
                    { name: 'actorName', type: 'varchar', length: '200', isNullable: true },
                    { name: 'subjectType', type: 'varchar', length: '100', isNullable: true },
                    { name: 'subjectExternalId', type: 'varchar', length: '200', isNullable: true },
                    { name: 'title', type: 'varchar', length: '500', isNullable: true },
                    { name: 'sourceUrl', type: 'varchar', length: '2048', isNullable: true },
                    { name: 'payload', type: 'text' },
                    { name: 'processedAt', type: 'timestamp', isNullable: true },
                    { name: 'dedupeKey', type: 'varchar', length: '64' },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // Dedupe identity — connector re-delivery must be a no-op.
        await queryRunner.createIndex(
            'ingested_events',
            new TableIndex({
                name: 'idx_ingested_events_dedupe',
                columnNames: ['dedupeKey'],
                isUnique: true,
            }),
        );

        // Owner-scoped recency reads (list_recent_events chat tool +
        // future feed surfaces).
        await queryRunner.createIndex(
            'ingested_events',
            new TableIndex({
                name: 'idx_ingested_events_user_created',
                columnNames: ['userId', 'createdAt'],
            }),
        );

        // The event-ingest-tick cron scans WHERE processedAt IS NULL.
        await queryRunner.createIndex(
            'ingested_events',
            new TableIndex({
                name: 'idx_ingested_events_unprocessed',
                columnNames: ['processedAt'],
            }),
        );

        await queryRunner.createForeignKey(
            'ingested_events',
            new TableForeignKey({
                name: 'fk_ingested_events_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        // Deleting a Work must not delete its ingested events — they
        // just lose the Work routing and stay owner-scoped.
        await queryRunner.createForeignKey(
            'ingested_events',
            new TableForeignKey({
                name: 'fk_ingested_events_work',
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('ingested_events')) {
            await queryRunner.dropTable('ingested_events', true);
        }
    }
}
