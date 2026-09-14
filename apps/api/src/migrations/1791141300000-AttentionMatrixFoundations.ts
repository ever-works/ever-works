import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Attention controls (AW-13) — the schema the notification matrix stands on.
 *
 * Entities: `packages/agent/src/entities/notification.entity.ts`,
 * `packages/agent/src/entities/notification-channel-delivery-log.entity.ts`,
 * `packages/agent/src/entities/user-notification-subscription.entity.ts` and
 * `packages/agent/src/entities/user-notification-preference.entity.ts`.
 *
 * ## `notifications.isSilent`
 *
 * When a user turns in-app off for an event, the notification is still
 * written (the in-app record is the floor and is never taken away), but it no
 * longer interrupts: it is left out of the unread count and the default list.
 * `isSilent` is that one fact. NOT NULL DEFAULT false, so every existing row
 * reads "interrupting" — exactly how it was delivered.
 * `idx_notifications_user_silent_read` keeps the unread count on an index now
 * that it filters on the flag too.
 *
 * ## `notification_channel_delivery_log` — room for built-in targets
 *
 * Email to the account's own address is a built-in delivery target, like
 * in-app: it has no `notification_channels` row. Its attempts are recorded in
 * the same log as chat deliveries so an operator sees everything that was and
 * was not delivered in one place.
 *
 * - `channelId` becomes nullable. Existing rows are untouched and the FK to
 *   `notification_channels` stays.
 * - `builtInChannel` (varchar 16, nullable) names the built-in target.
 *   Exactly one of `channelId` / `builtInChannel` is set by the writer.
 * - `userId` (uuid, nullable, no FK) — Tier C denormalization matching the
 *   `tenantId` / `organizationId` columns already on this table, so deliveries
 *   can be counted per user. `idx_ncdl_user_created` serves that count.
 *
 * ## `user_notification_subscriptions.origin` — which choices the matrix made
 *
 * The notification matrix takes a stored per-event choice literally: an empty
 * list means "nothing" and a list without in-app keeps the notification out
 * of the bell. Rows stored before this migration, and rows written through
 * the API or the chat assistant, never meant that: an empty list fell back to
 * the organisation / event defaults and every notification reached the bell.
 * `origin` (varchar 16, nullable) tells the two apart: the matrix write path
 * stores `'matrix'`; every other write stores NULL. Every existing row reads
 * NULL, so it behaves exactly as it did.
 *
 * ## `user_notification_preferences.urgentBypassesQuietHours`
 *
 * AW-13 marks more events urgent. Quiet hours a person chose must keep
 * deferring every event they deferred before, so letting the newly urgent
 * events through is the person's own opt-in, stored with the quiet-hours
 * window. NOT NULL DEFAULT false: every existing row reads "not opted in".
 *
 * ## What this migration deliberately does NOT do
 *
 * - No registry data: the core event catalogue is upserted on every boot by
 *   `NotificationEventTypeBootstrap` from
 *   `packages/agent/src/notifications/core-event-catalogue.ts`, in every
 *   environment, so a second copy of the rows here could only drift.
 * - No subscription backfill and nothing written to `users`: budget-alert
 *   email stays governed live by `users.emailBudgetAlerts`. No row of
 *   `user_notification_subscriptions` or `user_notification_preferences` is
 *   written; the two columns above are added with values that leave every
 *   existing row meaning what it meant.
 * - No DROP, no rename, no NOT NULL added to a populated column.
 *
 * Portable `TableColumn` / `TableIndex` DDL with existence guards, because
 * production runs Postgres while CI and the e2e stack run better-sqlite3;
 * re-running converges. `down()` reverses only what `up()` added, and only
 * restores NOT NULL on `channelId` when no built-in rows would violate it.
 */
export class AttentionMatrixFoundations1791141300000 implements MigrationInterface {
    name = 'AttentionMatrixFoundations1791141300000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const notifications = await queryRunner.getTable('notifications');
        if (notifications) {
            if (!notifications.findColumnByName('isSilent')) {
                await queryRunner.addColumn(
                    'notifications',
                    new TableColumn({
                        name: 'isSilent',
                        type: 'boolean',
                        isNullable: false,
                        default: false,
                    }),
                );
            }
            const refreshed = await queryRunner.getTable('notifications');
            if (!refreshed?.indices.some((i) => i.name === 'idx_notifications_user_silent_read')) {
                await queryRunner.createIndex(
                    'notifications',
                    new TableIndex({
                        name: 'idx_notifications_user_silent_read',
                        columnNames: ['userId', 'isSilent', 'isRead'],
                    }),
                );
            }
        }

        const log = await queryRunner.getTable('notification_channel_delivery_log');
        if (log) {
            const channelId = log.findColumnByName('channelId');
            if (channelId && !channelId.isNullable) {
                const relaxed = channelId.clone();
                relaxed.isNullable = true;
                await queryRunner.changeColumn(
                    'notification_channel_delivery_log',
                    channelId,
                    relaxed,
                );
            }
            const afterChange = await queryRunner.getTable('notification_channel_delivery_log');
            if (!afterChange?.findColumnByName('builtInChannel')) {
                await queryRunner.addColumn(
                    'notification_channel_delivery_log',
                    new TableColumn({
                        name: 'builtInChannel',
                        type: 'varchar',
                        length: '16',
                        isNullable: true,
                    }),
                );
            }
            if (!afterChange?.findColumnByName('userId')) {
                await queryRunner.addColumn(
                    'notification_channel_delivery_log',
                    new TableColumn({ name: 'userId', type: 'uuid', isNullable: true }),
                );
            }
            const withColumns = await queryRunner.getTable('notification_channel_delivery_log');
            if (!withColumns?.indices.some((i) => i.name === 'idx_ncdl_user_created')) {
                await queryRunner.createIndex(
                    'notification_channel_delivery_log',
                    new TableIndex({
                        name: 'idx_ncdl_user_created',
                        columnNames: ['userId', 'createdAt'],
                    }),
                );
            }
        }

        const subscriptions = await queryRunner.getTable('user_notification_subscriptions');
        if (subscriptions && !subscriptions.findColumnByName('origin')) {
            await queryRunner.addColumn(
                'user_notification_subscriptions',
                new TableColumn({
                    name: 'origin',
                    type: 'varchar',
                    length: '16',
                    isNullable: true,
                }),
            );
        }

        const preferences = await queryRunner.getTable('user_notification_preferences');
        if (preferences && !preferences.findColumnByName('urgentBypassesQuietHours')) {
            await queryRunner.addColumn(
                'user_notification_preferences',
                new TableColumn({
                    name: 'urgentBypassesQuietHours',
                    type: 'boolean',
                    isNullable: false,
                    default: false,
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Dropping these two columns deletes no row and moves every person to
        // the behaviour they had before AW-13: every stored choice falls back
        // to the defaults when empty and reaches the bell, and quiet hours
        // defer every event they deferred before.
        const preferences = await queryRunner.getTable('user_notification_preferences');
        if (preferences?.findColumnByName('urgentBypassesQuietHours')) {
            await queryRunner.dropColumn(
                'user_notification_preferences',
                'urgentBypassesQuietHours',
            );
        }
        const subscriptions = await queryRunner.getTable('user_notification_subscriptions');
        if (subscriptions?.findColumnByName('origin')) {
            await queryRunner.dropColumn('user_notification_subscriptions', 'origin');
        }

        const log = await queryRunner.getTable('notification_channel_delivery_log');
        if (log) {
            if (log.indices.some((i) => i.name === 'idx_ncdl_user_created')) {
                await queryRunner.dropIndex(
                    'notification_channel_delivery_log',
                    'idx_ncdl_user_created',
                );
            }
            const current = await queryRunner.getTable('notification_channel_delivery_log');
            if (current?.findColumnByName('userId')) {
                await queryRunner.dropColumn('notification_channel_delivery_log', 'userId');
            }
            // Built-in delivery rows have no channel. While any exist,
            // `channelId` stays nullable and `builtInChannel` stays, so those
            // rows keep saying what they were; nothing is deleted.
            const rows: Array<{ count: number | string }> = await queryRunner.query(
                `SELECT COUNT(*) AS "count" FROM "notification_channel_delivery_log" WHERE "channelId" IS NULL`,
            );
            if (Number(rows[0]?.count ?? 0) === 0) {
                const withoutUser = await queryRunner.getTable('notification_channel_delivery_log');
                const column = withoutUser?.findColumnByName('channelId');
                if (column?.isNullable) {
                    const strict = column.clone();
                    strict.isNullable = false;
                    await queryRunner.changeColumn(
                        'notification_channel_delivery_log',
                        column,
                        strict,
                    );
                }
                const last = await queryRunner.getTable('notification_channel_delivery_log');
                if (last?.findColumnByName('builtInChannel')) {
                    await queryRunner.dropColumn(
                        'notification_channel_delivery_log',
                        'builtInChannel',
                    );
                }
            }
        }

        const notifications = await queryRunner.getTable('notifications');
        if (notifications) {
            if (
                notifications.indices.some((i) => i.name === 'idx_notifications_user_silent_read')
            ) {
                await queryRunner.dropIndex('notifications', 'idx_notifications_user_silent_read');
            }
            const current = await queryRunner.getTable('notifications');
            if (current?.findColumnByName('isSilent')) {
                await queryRunner.dropColumn('notifications', 'isSilent');
            }
        }
    }
}
