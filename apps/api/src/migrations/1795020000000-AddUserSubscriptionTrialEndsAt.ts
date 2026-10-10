import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `user_subscriptions.trialEndsAt` (owner, 2026-10-09 — the 90-day Cloud trial runs on Free-plan
 * credits). Entity: `packages/agent/src/entities/user-subscription.entity.ts`.
 *
 * The end of the subscription's free trial, NULL when it had none. Until it passes, the plan's
 * monthly credits are not granted; after it, the allowance months are anchored on it so the first
 * paid month's credits last a full month (they used to anchor on the trial START, which would
 * expire the first paid allowance days after the first payment).
 *
 * Nullable, no backfill: every existing row keeps NULL and keeps its current anchor (`createdAt`),
 * so nothing already granted moves. Forward-only with a per-column guard (house pattern).
 */
export class AddUserSubscriptionTrialEndsAt1795020000000 implements MigrationInterface {
    name = 'AddUserSubscriptionTrialEndsAt1795020000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_subscriptions');
        if (!table) return;
        if (!table.findColumnByName('trialEndsAt')) {
            await queryRunner.query(
                `ALTER TABLE "user_subscriptions" ADD COLUMN "trialEndsAt" TIMESTAMP`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_subscriptions');
        if (!table) return;
        if (table.findColumnByName('trialEndsAt')) {
            await queryRunner.query(`ALTER TABLE "user_subscriptions" DROP COLUMN "trialEndsAt"`);
        }
    }
}
