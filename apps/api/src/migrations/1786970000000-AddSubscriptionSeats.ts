import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seats on the subscription row (billing spec §3.6 / FR-26 —
 * `docs/specs/features/billing/spec.md`).
 *
 * Seats were already being SOLD (the plan checkout adds a per-additional-seat
 * line item from the catalog) and then forgotten: nothing recorded how many
 * the customer bought, so nothing could enforce them and the Billing page had
 * nothing to show. Two columns fix that:
 *
 *  - `seats`                — additional seats the provider subscription bills
 *                             for beyond the plan allowance, reconciled from
 *                             its per-seat items on every `subscription.*`
 *                             delivery. NULL = unknown/unbounded, which every
 *                             reader treats as "fall back to the plan's
 *                             `seatsIncluded`", never as zero.
 *  - `providerSeatItemId`   — the subscription item carrying the seat price,
 *                             so a quantity change updates that item instead
 *                             of guessing or creating a duplicate.
 *
 * Both nullable with no backfill: every pre-existing row keeps behaving as it
 * did (seats resolve from the plan), and the real values arrive on the next
 * webhook or seat purchase.
 *
 * Forward-only with per-column guards (house pattern), safe to re-run.
 */
export class AddSubscriptionSeats1786970000000 implements MigrationInterface {
    name = 'AddSubscriptionSeats1786970000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_subscriptions');
        if (!table) return;

        if (!table.findColumnByName('seats')) {
            await queryRunner.query(`ALTER TABLE "user_subscriptions" ADD COLUMN "seats" integer`);
        }
        if (!table.findColumnByName('providerSeatItemId')) {
            await queryRunner.query(
                `ALTER TABLE "user_subscriptions" ADD COLUMN "providerSeatItemId" varchar(128)`,
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('user_subscriptions');
        if (!table) return;
        for (const col of ['seats', 'providerSeatItemId']) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "user_subscriptions" DROP COLUMN "${col}"`);
            }
        }
    }
}
