import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Adds the `onboarding_requests` and `webhook_subscriptions` tables for the
 * agent zero-friction onboarding feature.
 *
 * Forward-only, additive — no DROP, no rename of existing columns.
 *
 * NOTE: this migration is hand-written because no `pnpm typeorm migration:generate`
 * was run during the foundation slice. Re-running the generator after pulling
 * the new entities should produce a no-op (or a small diff) — verify before
 * shipping. See `tasks.md` T3.
 */
export class AddOnboardingAndWebhookSubscriptions1746360000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.createTable(
            new Table({
                name: 'onboarding_requests',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'github_identity_hash', type: 'varchar', length: '64' },
                    { name: 'repo_url_canonical', type: 'varchar', length: '512' },
                    { name: 'contact_email', type: 'varchar', length: '320', isNullable: true },
                    { name: 'agent_id', type: 'varchar', length: '256', isNullable: true },
                    { name: 'account_id', type: 'uuid', isNullable: true },
                    { name: 'work_id', type: 'uuid', isNullable: true },
                    { name: 'status', type: 'varchar', length: '64' },
                    { name: 'failure_code', type: 'varchar', length: '128', isNullable: true },
                    { name: 'failure_detail', type: 'jsonb', isNullable: true },
                    { name: 'idempotency_key', type: 'varchar', length: '64', isNullable: true },
                    { name: 'webhook_url', type: 'varchar', length: '512', isNullable: true },
                    { name: 'subdomain', type: 'varchar', length: '64', isNullable: true },
                    {
                        name: 'created_at',
                        type: 'timestamp with time zone',
                        default: 'now()',
                    },
                    {
                        name: 'updated_at',
                        type: 'timestamp with time zone',
                        default: 'now()',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'onboarding_requests',
            new TableIndex({
                name: 'IDX_onboarding_identity_repo',
                columnNames: ['github_identity_hash', 'repo_url_canonical'],
                isUnique: true,
            }),
        );

        await queryRunner.createIndex(
            'onboarding_requests',
            new TableIndex({
                name: 'IDX_onboarding_repo',
                columnNames: ['repo_url_canonical'],
            }),
        );

        await queryRunner.createIndex(
            'onboarding_requests',
            new TableIndex({
                name: 'IDX_onboarding_work',
                columnNames: ['work_id'],
            }),
        );

        await queryRunner.createIndex(
            'onboarding_requests',
            new TableIndex({
                name: 'IDX_onboarding_account',
                columnNames: ['account_id'],
            }),
        );

        await queryRunner.createTable(
            new Table({
                name: 'webhook_subscriptions',
                columns: [
                    {
                        name: 'id',
                        type: 'uuid',
                        isPrimary: true,
                        default: 'uuid_generate_v4()',
                    },
                    { name: 'account_id', type: 'uuid' },
                    { name: 'work_id', type: 'uuid', isNullable: true },
                    { name: 'url', type: 'varchar', length: '2048' },
                    { name: 'secret_encrypted', type: 'text' },
                    { name: 'status', type: 'varchar', length: '32', default: "'active'" },
                    { name: 'consecutive_failures', type: 'integer', default: 0 },
                    {
                        name: 'last_delivery_at',
                        type: 'timestamp with time zone',
                        isNullable: true,
                    },
                    {
                        name: 'created_at',
                        type: 'timestamp with time zone',
                        default: 'now()',
                    },
                    {
                        name: 'updated_at',
                        type: 'timestamp with time zone',
                        default: 'now()',
                    },
                ],
            }),
            true,
        );

        await queryRunner.createIndex(
            'webhook_subscriptions',
            new TableIndex({
                name: 'IDX_webhook_account',
                columnNames: ['account_id'],
            }),
        );

        await queryRunner.createIndex(
            'webhook_subscriptions',
            new TableIndex({
                name: 'IDX_webhook_work',
                columnNames: ['work_id'],
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable('webhook_subscriptions', true);
        await queryRunner.dropTable('onboarding_requests', true);
    }
}
