import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * EW-684 PR-D — Composio Triggers.
 *
 * Creates the `composio_trigger_subscriptions` table, which stores one
 * row per user-installed Composio trigger (the webhook event surface —
 * `GMAIL_NEW_EMAIL`, `SLACK_NEW_MESSAGE`, …). Each row carries a
 * server-generated HMAC secret used to verify `x-composio-signature`
 * on inbound webhook deliveries.
 *
 * Forward-only, idempotent (`ifNotExists`). Tier C-shaped: nullable
 * tenant/org FKs, no entity-level @ManyToOne for those (cycle
 * avoidance per EW-654).
 */
export class AddComposioTriggerSubscriptions1780100000000 implements MigrationInterface {
    name = 'AddComposioTriggerSubscriptions1780100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'composio_trigger_subscriptions',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'userId', type: 'uuid' },
                    { name: 'toolkitSlug', type: 'varchar', length: '64' },
                    { name: 'triggerSlug', type: 'varchar', length: '128' },
                    { name: 'composioTriggerId', type: 'varchar', length: '64' },
                    { name: 'composioConnectedAccountId', type: 'varchar', length: '64' },
                    { name: 'webhookSecret', type: 'varchar', length: '128' },
                    { name: 'config', type: 'text', isNullable: true },
                    { name: 'enabled', type: 'boolean', default: true },
                    { name: 'lastFiredAt', type: 'bigint', isNullable: true },
                    { name: 'deliveriesReceived', type: 'integer', default: 0 },
                    { name: 'deliveriesRejected', type: 'integer', default: 0 },
                    { name: 'tenantId', type: 'uuid', isNullable: true },
                    { name: 'organizationId', type: 'uuid', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            true,
        );

        await queryRunner.createForeignKey(
            'composio_trigger_subscriptions',
            new TableForeignKey({
                columnNames: ['userId'],
                referencedTableName: 'users',
                referencedColumnNames: ['id'],
                onDelete: 'CASCADE',
            }),
        );

        await queryRunner.createIndex(
            'composio_trigger_subscriptions',
            new TableIndex({
                name: 'uq_composio_trigger_subscription',
                columnNames: ['userId', 'toolkitSlug', 'triggerSlug'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'composio_trigger_subscriptions',
            new TableIndex({
                name: 'uq_composio_trigger_subscription_remote',
                columnNames: ['composioTriggerId'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'composio_trigger_subscriptions',
            new TableIndex({
                name: 'idx_composio_trigger_subscription_user',
                columnNames: ['userId'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('composio_trigger_subscriptions', true);
    }
}
