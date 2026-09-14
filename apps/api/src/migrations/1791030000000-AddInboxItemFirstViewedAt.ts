import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * My Decisions — `inbox_items.firstViewedAt`.
 *
 * Entity: `packages/agent/src/entities/inbox-item.entity.ts`.
 *
 * The Inbox is where an owner answers the questions, approvals and
 * escalations their agents raise, and My Decisions is that same Inbox
 * read as a ranked queue. The one fact the queue needs that the row does
 * not already carry is WHEN a human first looked at a decision: `unread`
 * says whether, never when, and `answeredAt` is the other end of the
 * interval. With `createdAt`, `firstViewedAt` and `answeredAt` the owner
 * can see how long work waited to be noticed versus how long it waited to
 * be decided.
 *
 * Stamped once by `InboxService` (first read flip or the answer), through
 * a `WHERE firstViewedAt IS NULL` update, so it is never moved again.
 *
 * Additive and nullable, no index: it is read with the row, never filtered
 * on. Every existing item reads NULL ("not recorded"), which is honest
 * history — the column did not exist when those were opened. Forward-only
 * with a guard so a partially applied database converges; portable
 * `TableColumn` DDL because CI and the e2e stack run better-sqlite3 while
 * production runs Postgres.
 */
export class AddInboxItemFirstViewedAt1791030000000 implements MigrationInterface {
    name = 'AddInboxItemFirstViewedAt1791030000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const items = await queryRunner.getTable('inbox_items');
        if (items && !items.findColumnByName('firstViewedAt')) {
            await queryRunner.addColumn(
                'inbox_items',
                new TableColumn({ name: 'firstViewedAt', type: 'timestamp', isNullable: true }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const items = await queryRunner.getTable('inbox_items');
        if (items?.findColumnByName('firstViewedAt')) {
            await queryRunner.dropColumn('inbox_items', 'firstViewedAt');
        }
    }
}
