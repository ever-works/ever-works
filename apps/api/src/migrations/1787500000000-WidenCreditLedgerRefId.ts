import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `credit_ledger_entries.refId` from `uuid` to `varchar(128)`.
 *
 * 🛑 This is a live production blocker on the money path, not a tidy-up.
 *
 * The creating migration (`1783400000000`) declared `refId` as a Postgres
 * `uuid`, but the only code that writes it puts a STRIPE id there:
 * `BillingService` records a settled credit-pack purchase with
 * `refId: event.paymentId` (billing.service.ts:549) and sizes a refund
 * reversal from the same column (`:607`, read back via `findLatestByRef`).
 * `event.paymentId` is `intent.id` — a `pi_…` string
 * (stripe-billing.provider.ts:533, 701).
 *
 * So the FIRST settled credit-pack purchase on any Postgres environment
 * raises `22P02 invalid input syntax for type uuid`, the webhook 500s, and
 * Stripe retries that delivery on its back-off schedule indefinitely. The
 * customer is charged and never receives the credits.
 *
 * The test suite cannot see it: it runs on better-sqlite3, where `uuid` is
 * just a varchar and `'pi_3ABC'` inserts happily. Only the absence of any
 * completed purchase to date has kept this from firing.
 *
 * Widening `uuid` → `varchar(128)` is lossless (every uuid is a valid
 * 36-char string) and needs no data migration. `findLatestByRef` keeps
 * working because it compares the column to a string either way.
 *
 * Forward-only and idempotent: the column type is checked first, so a
 * re-run is a no-op and a database that never had the uuid type is left
 * alone. `down()` deliberately does NOT narrow back — that would fail on
 * any row holding a real Stripe id, which is exactly the data this
 * migration exists to allow.
 */
export class WidenCreditLedgerRefId1787500000000 implements MigrationInterface {
    name = 'WidenCreditLedgerRefId1787500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('credit_ledger_entries');
        const column = table?.findColumnByName('refId');
        if (!column) {
            return;
        }
        // Only Postgres actually enforces the uuid type; on sqlite/mysql the
        // column is already string-shaped and there is nothing to widen.
        if (queryRunner.connection.options.type !== 'postgres') {
            return;
        }
        if (column.type !== 'uuid') {
            return;
        }
        await queryRunner.query(
            'ALTER TABLE "credit_ledger_entries" ALTER COLUMN "refId" TYPE character varying(128)',
        );
    }

    public async down(): Promise<void> {
        // Intentionally empty. Narrowing back to `uuid` would fail on any row
        // holding a Stripe `pi_…` id — the very rows this migration enables.
    }
}
