import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Adds the `ingestEventId` column + partial unique index to the
 * `activity_log` table for EW-120 push-based event ingestion.
 *
 * The deployed directory site POSTs user-facing events
 * (signups, item submissions, reports) to
 * `POST /api/activity-log/ingest`. Each request carries a client-generated
 * `eventId` (UUID); the partial unique index on `(workId, ingestEventId)`
 * makes the endpoint safely idempotent: retries from the website land on
 * the same row instead of creating duplicates.
 *
 * Forward-only, additive. The column is nullable so existing rows remain
 * valid; the index is partial so it only applies to ingested events.
 */
export class AddActivityLogIngestEventId1778677529777 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'activity_log',
            new TableColumn({
                name: 'ingestEventId',
                type: 'varchar',
                length: '64',
                isNullable: true,
            }),
        );
        await queryRunner.createIndex(
            'activity_log',
            new TableIndex({
                name: 'idx_activity_log_work_ingest_event',
                columnNames: ['workId', 'ingestEventId'],
                isUnique: true,
                where: '"ingestEventId" IS NOT NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropIndex('activity_log', 'idx_activity_log_work_ingest_event');
        await queryRunner.dropColumn('activity_log', 'ingestEventId');
    }
}
