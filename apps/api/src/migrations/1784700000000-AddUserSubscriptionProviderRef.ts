import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/**
 * Paid-plan checkout (audit B24) — the one column `user_subscriptions`
 * was missing to be driven by a payment provider.
 *
 *  - `providerSubscriptionId` — the provider's own subscription id,
 *    stamped when a hosted plan checkout completes. It is what lets a
 *    later `customer.subscription.updated` / `.deleted` delivery update
 *    or revoke exactly the row that checkout created, instead of
 *    guessing from the customer mapping. Opaque reference, never a
 *    secret; NULL on every pre-existing (manually granted) row, which
 *    reads correctly as "not provider-managed".
 *
 * A non-unique index because a re-subscribe legitimately produces a new
 * provider subscription while the cancelled row is still on file —
 * uniqueness here would reject the second sale.
 *
 * Forward-only with per-step guards (house pattern, mirrors
 * `1784400000000-AddRunAttentionColumns`). No backfill: there is nothing
 * to backfill, and no existing behavior changes.
 */
export class AddUserSubscriptionProviderRef1784700000000 implements MigrationInterface {
    name = 'AddUserSubscriptionProviderRef1784700000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_subscriptions');
        if (!table) return;

        if (!table.findColumnByName('providerSubscriptionId')) {
            await queryRunner.query(
                `ALTER TABLE "user_subscriptions" ADD COLUMN "providerSubscriptionId" varchar(128)`,
            );
        }

        const refreshed = await queryRunner.getTable('user_subscriptions');
        const hasIndex = refreshed?.indices.some(
            (index) => index.name === 'idx_user_subscriptions_provider_subscription',
        );
        if (!hasIndex) {
            await queryRunner.createIndex(
                'user_subscriptions',
                new TableIndex({
                    name: 'idx_user_subscriptions_provider_subscription',
                    columnNames: ['providerSubscriptionId'],
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_subscriptions');
        if (!table) return;

        const hasIndex = table.indices.some(
            (index) => index.name === 'idx_user_subscriptions_provider_subscription',
        );
        if (hasIndex) {
            await queryRunner.dropIndex(
                'user_subscriptions',
                'idx_user_subscriptions_provider_subscription',
            );
        }
        if (table.findColumnByName('providerSubscriptionId')) {
            await queryRunner.query(
                `ALTER TABLE "user_subscriptions" DROP COLUMN "providerSubscriptionId"`,
            );
        }
    }
}
