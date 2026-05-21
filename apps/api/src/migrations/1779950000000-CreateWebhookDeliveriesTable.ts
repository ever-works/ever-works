import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * EW-634 — Create the `webhook_deliveries` table backing the per-attempt
 * delivery log surfaced by `GET /api/webhooks/deliveries` and the
 * redeliver endpoint.
 *
 * The companion entity is `packages/agent/src/entities/webhook-delivery.entity.ts`.
 *
 * The table is idempotent (no-op if already present) and intentionally
 * does NOT carry a foreign key on `subscriptionId` — subscriptions can be
 * deleted and we still want to retain the historical delivery rows for
 * audit. The producer-side dispatcher refuses to enqueue against a missing
 * subscription, so dangling foreign keys are a non-issue in practice.
 */
export class CreateWebhookDeliveriesTable_1779950000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        const exists = await queryRunner.hasTable('webhook_deliveries');
        if (exists) return;

        await queryRunner.createTable(
            new Table({
                name: 'webhook_deliveries',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        generationStrategy: 'uuid',
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'subscriptionId', type: 'uuid', isNullable: false },
                    { name: 'accountId', type: 'uuid', isNullable: false },
                    { name: 'event', type: 'varchar', length: '128', isNullable: false },
                    { name: 'payload', type: 'jsonb', isNullable: false },
                    {
                        name: 'status',
                        type: 'varchar',
                        length: '32',
                        isNullable: false,
                        default: "'pending'",
                    },
                    { name: 'attempts', type: 'int', isNullable: false, default: 0 },
                    { name: 'lastResponseStatus', type: 'int', isNullable: true },
                    { name: 'lastOutcome', type: 'varchar', length: '32', isNullable: true },
                    { name: 'lastError', type: 'text', isNullable: true },
                    { name: 'durationMs', type: 'int', isNullable: true },
                    { name: 'triggerRunId', type: 'varchar', length: '128', isNullable: true },
                    { name: 'lastAttemptAt', type: 'bigint', isNullable: true },
                    { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                ],
            }),
            // ifNotExists
            true,
        );

        await queryRunner.createIndex(
            'webhook_deliveries',
            new TableIndex({
                name: 'IDX_webhook_deliveries_sub_createdAt',
                columnNames: ['subscriptionId', 'createdAt'],
            }),
        );
        await queryRunner.createIndex(
            'webhook_deliveries',
            new TableIndex({
                name: 'IDX_webhook_deliveries_account_createdAt',
                columnNames: ['accountId', 'createdAt'],
            }),
        );
        await queryRunner.createIndex(
            'webhook_deliveries',
            new TableIndex({
                name: 'IDX_webhook_deliveries_status',
                columnNames: ['status'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('webhook_deliveries')) {
            await queryRunner.dropTable('webhook_deliveries');
        }
    }
}
