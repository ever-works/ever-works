import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Meetings v1 (Wave 8, feature a) — creates the `meetings` table
 * backing org-wide + per-Work meetings with transcript capture:
 * meetings land from the `zoom.recording` envelope processor (cloud
 * recordings pulled by the zoom-connector event source), the
 * `/api/meetings` CRUD surface, or manual/import creation; transcript
 * ingest attaches the text, the best-effort AI `summary`, a Memory
 * observation and a `meeting.transcript` envelope (whose drain writes
 * the Activity entry with `sourceUrl` provenance).
 *
 * Entity: `packages/agent/src/entities/meeting.entity.ts`
 * Service: `packages/agent/src/meetings/meetings.service.ts`
 *
 * **Schema notes:**
 *   - `dedupeKey` (varchar(64), UNIQUE, NULLABLE) — sha256 over
 *     `(userId, source, externalId)`; makes provider re-delivery
 *     (overlapping pull windows, backfill) a no-op. NULL for manual
 *     meetings (no external identity) — those never dedupe, and every
 *     supported driver allows multiple NULLs under a unique index.
 *   - `participants` (text) — the entity's `simple-json` roster.
 *   - `transcriptText` / `summary` (text, nullable) — capped upstream
 *     (service + DTO).
 *   - Scope columns (`organizationId`) are raw uuid references — no
 *     entity-level @ManyToOne (cycle avoidance per EW-654).
 *   - FK `userId` → `users.id` ON DELETE CASCADE (a meeting is
 *     meaningless without its owner); FK `workId` → `works.id`
 *     ON DELETE SET NULL (deleting a Work must not delete the meeting —
 *     it just loses its Work routing and stays org-level).
 *
 * Forward-only + idempotent (`hasTable` guard) — same shape as
 * `1783200000000-CreateIngestedEvents`.
 */
export class CreateMeetings1783800000000 implements MigrationInterface {
    name = 'CreateMeetings1783800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('meetings')) {
            return;
        }

        await queryRunner.createTable(
            new Table({
                name: 'meetings',
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
                    { name: 'title', type: 'varchar', length: '500' },
                    { name: 'startedAt', type: 'timestamp' },
                    { name: 'endedAt', type: 'timestamp', isNullable: true },
                    { name: 'source', type: 'varchar', length: '32' },
                    { name: 'externalId', type: 'varchar', length: '200', isNullable: true },
                    { name: 'participants', type: 'text' },
                    { name: 'transcriptText', type: 'text', isNullable: true },
                    { name: 'summary', type: 'text', isNullable: true },
                    { name: 'sourceUrl', type: 'varchar', length: '2048', isNullable: true },
                    { name: 'dedupeKey', type: 'varchar', length: '64', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        // Dedupe identity — provider re-delivery must be a no-op.
        await queryRunner.createIndex(
            'meetings',
            new TableIndex({
                name: 'idx_meetings_dedupe',
                columnNames: ['dedupeKey'],
                isUnique: true,
            }),
        );

        // Owner-scoped recency reads (org-wide Meetings view, chat tools).
        await queryRunner.createIndex(
            'meetings',
            new TableIndex({
                name: 'idx_meetings_user_started',
                columnNames: ['userId', 'startedAt'],
            }),
        );

        // Per-Work Meetings tab reads.
        await queryRunner.createIndex(
            'meetings',
            new TableIndex({
                name: 'idx_meetings_work',
                columnNames: ['workId'],
            }),
        );

        await queryRunner.createForeignKey(
            'meetings',
            new TableForeignKey({
                name: 'fk_meetings_user',
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        // Deleting a Work must not delete its meetings — they just lose
        // the Work routing and stay owner/org-scoped.
        await queryRunner.createForeignKey(
            'meetings',
            new TableForeignKey({
                name: 'fk_meetings_work',
                columnNames: ['workId'],
                referencedTableName: 'works',
                referencedColumnNames: ['id'],
                onDelete: 'SET NULL',
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('meetings')) {
            await queryRunner.dropTable('meetings', true);
        }
    }
}
