import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Subscription lifecycle on the billing profile (audit B07/B08).
 *
 * The Billing page could START a subscription but never manage one:
 * there was no cancel path, no `cancelAtPeriodEnd` state, and the status
 * chip was hardcoded. These five columns give the money path somewhere to
 * persist what the provider reports, so cancel/resume and the PAST_DUE
 * banner read real state instead of an assumption.
 *
 *  - `providerSubscriptionId`   — opaque provider subscription id. NULL ⇒
 *                                 no recurring plan (free tier / payments
 *                                 not wired) and cancel/resume are refused
 *                                 with a 409 rather than silently no-op'ing.
 *  - `subscriptionStatus`       — vendor-neutral lifecycle token
 *                                 (`active` / `past_due` / `canceled` …),
 *                                 written by cancel/resume AND by the
 *                                 signature-verified webhook.
 *  - `cancelAtPeriodEnd`        — cancel requested, paid period still
 *                                 running. Defaults FALSE, which is
 *                                 exactly right for every existing row.
 *  - `currentPeriodEnd`         — when a pending cancellation takes effect.
 *  - `subscriptionCanceledAt`   — when it actually ended.
 *
 * Entity: `packages/agent/src/entities/billing-profile.entity.ts`. The
 * two date columns are `PortableDateColumn` (`timestamp` NULL), matching
 * `autoRechargeInFlightAt` / `autoRechargeLastFailureAt` on the same table.
 *
 * Nothing is backfilled: every pre-existing profile keeps NULL status +
 * FALSE `cancelAtPeriodEnd`, which the service reads as "this account has
 * no provider subscription" — the behaviour it had before this change.
 *
 * Forward-only with per-step guards (house pattern, mirrors
 * `1784400000000-AddRunAttentionColumns`).
 */
export class AddBillingSubscriptionLifecycleColumns1784720000000 implements MigrationInterface {
    name = 'AddBillingSubscriptionLifecycleColumns1784720000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('billing_profiles');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "billing_profiles" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('providerSubscriptionId', `"providerSubscriptionId" varchar(128)`);
        await addColumn('subscriptionStatus', `"subscriptionStatus" varchar(32)`);
        await addColumn('cancelAtPeriodEnd', `"cancelAtPeriodEnd" boolean NOT NULL DEFAULT false`);
        await addColumn('currentPeriodEnd', `"currentPeriodEnd" TIMESTAMP`);
        await addColumn('subscriptionCanceledAt', `"subscriptionCanceledAt" TIMESTAMP`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('billing_profiles');
        if (!table) return;
        for (const col of [
            'subscriptionCanceledAt',
            'currentPeriodEnd',
            'cancelAtPeriodEnd',
            'subscriptionStatus',
            'providerSubscriptionId',
        ]) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "billing_profiles" DROP COLUMN "${col}"`);
            }
        }
    }
}
