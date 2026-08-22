import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hosting, annual/one-time pricing, seats and credit allowance on the subscription plan
 * (owner directive 2026-08-22 — align Ever Works pricing with Ever Gauzy / Ever Teams).
 *
 * `subscription_plans` could describe exactly one shape of plan: a flat monthly price on cloud
 * hosting. The agreed model needs three more axes, so the six columns below give the plan row
 * somewhere to hold them:
 *
 *  - `hosting`          — `cloud` or `selfhosted`. Paid self-hosted editions sell a commercial
 *                         licence that lifts the buyer's AGPLv3 obligations. Together with the
 *                         tier this derives the plan's Stripe `lookup_key` in the shared account.
 *  - `annualPrice`      — charged once per YEAR. The marketing site quotes annual per month, so
 *                         cloud Pro displays "$17/mo" and stores 204.00. `0` ⇒ no annual option,
 *                         which is exactly right for every pre-existing row.
 *  - `lifetimePrice`    — one-time perpetual commercial licence. NULL on every plan not sold that
 *                         way. 🛑 A row with this set is bought in Stripe `mode: payment`, never
 *                         `subscription`.
 *  - `seatsIncluded`    — seats (employees OR agents, interchangeably) before per-seat billing
 *                         starts. NULL ⇒ UNBOUNDED, and an unbounded plan never emits a seat line.
 *  - `seatMonthlyPrice` — price per ADDITIONAL seat per month. The annual rate is 12x this;
 *                         additional seats carry no annual discount, matching Gauzy's flat
 *                         "$5 per month" wording.
 *  - `monthlyCredits`   — platform-billed AI credits per month, on top of the universal daily free
 *                         grant. A SEPARATE axis from seats: self-hosting is free, but a
 *                         self-hosted deployment using Ever-hosted AI still spends credits.
 *
 * Entity: `packages/agent/src/entities/subscription-plan.entity.ts`.
 *
 * Nothing is backfilled and nothing is dropped. Every pre-existing row keeps `hosting='cloud'`,
 * `annualPrice=0`, and NULL seats/lifetime — i.e. precisely the behaviour it had before this
 * change. The new values arrive through `SubscriptionService.seedPlans()`, which upserts on
 * `code` at boot; the three new `selfhosted_*` codes create their own rows there.
 *
 * 🛑 `subscription_plans.code` is NOT touched. `free` / `standard` / `premium` are stored verbatim
 * in `user_subscriptions.planCode` and in Stripe metadata on every subscription ever created.
 * Standard and Premium are now DISPLAYED as "Pro" and "Enterprise", which is a `displayName`
 * change in the seed, not a code change.
 *
 * Forward-only with per-step guards (house pattern, mirrors
 * `1784720000000-AddBillingSubscriptionLifecycleColumns`), so it is safe on both the SQLite demo
 * deployment and the Postgres stage/prod ones, and safe to re-run.
 */
export class AddPlanHostingSeatsAndCredits1786940000000 implements MigrationInterface {
    name = 'AddPlanHostingSeatsAndCredits1786940000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('subscription_plans');
        if (!table) return;

        const addColumn = async (name: string, ddl: string) => {
            if (!table.findColumnByName(name)) {
                await queryRunner.query(`ALTER TABLE "subscription_plans" ADD COLUMN ${ddl}`);
            }
        };

        await addColumn('hosting', `"hosting" varchar(32) NOT NULL DEFAULT 'cloud'`);
        await addColumn('annualPrice', `"annualPrice" decimal(10,2) NOT NULL DEFAULT 0`);
        await addColumn('lifetimePrice', `"lifetimePrice" decimal(10,2)`);
        await addColumn('seatsIncluded', `"seatsIncluded" integer`);
        await addColumn('seatMonthlyPrice', `"seatMonthlyPrice" decimal(10,2)`);
        await addColumn('monthlyCredits', `"monthlyCredits" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('subscription_plans');
        if (!table) return;

        for (const col of [
            'hosting',
            'annualPrice',
            'lifetimePrice',
            'seatsIncluded',
            'seatMonthlyPrice',
            'monthlyCredits',
        ]) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "subscription_plans" DROP COLUMN "${col}"`);
            }
        }
    }
}
