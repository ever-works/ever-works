import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

/**
 * Webhooks v2 (EW-P1-5, integration contract v1 B.5 —
 * `docs/specs/features/webhook-delivery.md` "Webhooks v2").
 *
 * `webhook_subscriptions` gains the v2 columns:
 *
 * | column                    | type          | notes                                              |
 * | ------------------------- | ------------- | -------------------------------------------------- |
 * | `version`                 | int, default 1| 1 = legacy work/deploy events, 2 = domain events   |
 * | `ownerType`               | varchar(32)   | `user` (default) or `integration_key`              |
 * | `ownerId`                 | uuid, null    | owning user or `api_keys.id` (v2 only)             |
 * | `events`                  | text, null    | simple-json catalog types / `<domain>.*` patterns  |
 * | `organizationIds`         | text, null    | simple-json organization ids                       |
 * | `excludeOriginTags`       | text, null    | simple-json origin tags to skip (loop guard)       |
 * | `startAfterSeq`           | bigint, null  | feed head at creation: only later events are sent  |
 * | `description`             | varchar(500)  | free text                                          |
 * | `previousSecretEncrypted` | text, null    | rotation grace: the previous secret, encrypted     |
 * | `previousSecretExpiresAt` | bigint (ms)   | when the previous secret stops signing             |
 *
 * `webhook_deliveries` gains `eventId varchar(32)` (the domain event a v2
 * fan-out delivery carries) and the unique index
 * `uq_webhook_deliveries_subscription_event (subscriptionId, eventId)`, which
 * makes the at-least-once fan-out idempotent. Existing rows keep `eventId`
 * NULL, and NULLs never collide on Postgres, MySQL or SQLite.
 *
 * Every existing subscription becomes `version = 1`, `ownerType = 'user'` and
 * keeps behaving exactly as before. Additive and idempotent (each step is
 * guarded); `down` drops what `up` added.
 */
export class AddWebhookSubscriptionsV21795080100000 implements MigrationInterface {
    name = 'AddWebhookSubscriptionsV21795080100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const subscriptionColumns: TableColumn[] = [
            new TableColumn({ name: 'version', type: 'int', default: 1 }),
            new TableColumn({
                name: 'ownerType',
                type: 'varchar',
                length: '32',
                default: "'user'",
            }),
            new TableColumn({ name: 'ownerId', type: 'uuid', isNullable: true }),
            new TableColumn({ name: 'events', type: 'text', isNullable: true }),
            new TableColumn({ name: 'organizationIds', type: 'text', isNullable: true }),
            new TableColumn({ name: 'excludeOriginTags', type: 'text', isNullable: true }),
            new TableColumn({ name: 'startAfterSeq', type: 'bigint', isNullable: true }),
            new TableColumn({
                name: 'description',
                type: 'varchar',
                length: '500',
                isNullable: true,
            }),
            new TableColumn({ name: 'previousSecretEncrypted', type: 'text', isNullable: true }),
            new TableColumn({ name: 'previousSecretExpiresAt', type: 'bigint', isNullable: true }),
        ];
        if (await queryRunner.hasTable('webhook_subscriptions')) {
            for (const column of subscriptionColumns) {
                if (!(await queryRunner.hasColumn('webhook_subscriptions', column.name))) {
                    await queryRunner.addColumn('webhook_subscriptions', column);
                }
            }
            const subscriptions = await queryRunner.getTable('webhook_subscriptions');
            if (
                subscriptions &&
                !subscriptions.indices.some(
                    (index) => index.name === 'idx_webhook_subscriptions_version_status',
                )
            ) {
                await queryRunner.createIndex(
                    'webhook_subscriptions',
                    new TableIndex({
                        name: 'idx_webhook_subscriptions_version_status',
                        columnNames: ['version', 'status'],
                    }),
                );
            }
        }

        if (await queryRunner.hasTable('webhook_deliveries')) {
            if (!(await queryRunner.hasColumn('webhook_deliveries', 'eventId'))) {
                await queryRunner.addColumn(
                    'webhook_deliveries',
                    new TableColumn({
                        name: 'eventId',
                        type: 'varchar',
                        length: '32',
                        isNullable: true,
                    }),
                );
            }
            const deliveries = await queryRunner.getTable('webhook_deliveries');
            if (
                deliveries &&
                !deliveries.indices.some(
                    (index) => index.name === 'uq_webhook_deliveries_subscription_event',
                )
            ) {
                await queryRunner.createIndex(
                    'webhook_deliveries',
                    new TableIndex({
                        name: 'uq_webhook_deliveries_subscription_event',
                        columnNames: ['subscriptionId', 'eventId'],
                        isUnique: true,
                    }),
                );
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('webhook_deliveries')) {
            const deliveries = await queryRunner.getTable('webhook_deliveries');
            if (
                deliveries?.indices.some(
                    (index) => index.name === 'uq_webhook_deliveries_subscription_event',
                )
            ) {
                await queryRunner.dropIndex(
                    'webhook_deliveries',
                    'uq_webhook_deliveries_subscription_event',
                );
            }
            if (await queryRunner.hasColumn('webhook_deliveries', 'eventId')) {
                await queryRunner.dropColumn('webhook_deliveries', 'eventId');
            }
        }
        if (await queryRunner.hasTable('webhook_subscriptions')) {
            const subscriptions = await queryRunner.getTable('webhook_subscriptions');
            if (
                subscriptions?.indices.some(
                    (index) => index.name === 'idx_webhook_subscriptions_version_status',
                )
            ) {
                await queryRunner.dropIndex(
                    'webhook_subscriptions',
                    'idx_webhook_subscriptions_version_status',
                );
            }
            for (const name of [
                'previousSecretExpiresAt',
                'previousSecretEncrypted',
                'description',
                'startAfterSeq',
                'excludeOriginTags',
                'organizationIds',
                'events',
                'ownerId',
                'ownerType',
                'version',
            ]) {
                if (await queryRunner.hasColumn('webhook_subscriptions', name)) {
                    await queryRunner.dropColumn('webhook_subscriptions', name);
                }
            }
        }
    }
}
