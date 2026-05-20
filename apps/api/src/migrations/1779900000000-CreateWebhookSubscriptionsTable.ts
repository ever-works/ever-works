import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * 1a — Create the `webhook_subscriptions` table backing the outbound
 * webhook subscriptions API (`/api/webhooks`).
 *
 * The TypeORM entity (`packages/agent/src/entities/webhook-subscription.entity.ts`)
 * was introduced in an earlier PR but never had a migration created
 * for it, so the table did not exist at runtime. This migration is
 * forward-only + idempotent (no-op if the table already exists) and
 * matches the shape declared by `@Entity('webhook_subscriptions')`.
 *
 * Columns:
 *  - id (uuid PK)
 *  - accountId (uuid, indexed) — owning user
 *  - workId (uuid nullable, indexed) — optional Work scope (NULL = global)
 *  - url (varchar 2048) — destination
 *  - secretEncrypted (text) — HMAC-SHA256 signing secret, AES-256-GCM
 *    envelope-encrypted (`enc::v1::...` format)
 *  - status (varchar 32) — 'active' | 'paused' | 'failed'
 *  - consecutiveFailures (int) — bumped by the delivery worker
 *  - lastDeliveryAt (timestamp nullable)
 *  - createdAt / updatedAt (timestamps)
 */
export class CreateWebhookSubscriptionsTable_1779900000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = await queryRunner.hasTable('webhook_subscriptions');
        if (exists) return;

        await queryRunner.createTable(
            new Table({
                name: 'webhook_subscriptions',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'accountId', type: 'uuid', isNullable: false },
                    { name: 'workId', type: 'uuid', isNullable: true },
                    { name: 'url', type: 'varchar', length: '2048', isNullable: false },
                    { name: 'secretEncrypted', type: 'text', isNullable: false },
                    {
                        name: 'status',
                        type: 'varchar',
                        length: '32',
                        isNullable: false,
                        default: "'active'",
                    },
                    {
                        name: 'consecutiveFailures',
                        type: 'int',
                        isNullable: false,
                        default: 0,
                    },
                    { name: 'lastDeliveryAt', type: 'timestamp', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            // ifNotExists
            true,
        );

        await queryRunner.createIndex(
            'webhook_subscriptions',
            new TableIndex({
                name: 'IDX_webhook_subscriptions_accountId',
                columnNames: ['accountId'],
            }),
        );
        await queryRunner.createIndex(
            'webhook_subscriptions',
            new TableIndex({
                name: 'IDX_webhook_subscriptions_workId',
                columnNames: ['workId'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('webhook_subscriptions')) {
            await queryRunner.dropTable('webhook_subscriptions');
        }
    }
}
