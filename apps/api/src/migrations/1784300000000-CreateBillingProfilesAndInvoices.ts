import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Payment provider bridge (billing PRD §5.3(3)/(4)) — the two tables the
 * money path needs beyond the already-shipped credits ledger.
 *
 * `billing_profiles` — one row per user, created lazily at first
 * checkout. Entity: `packages/agent/src/entities/billing-profile.entity.ts`.
 *
 *   - `provider` + `providerCustomerId`: customer mapping, so a returning
 *     buyer reuses the same provider customer.
 *   - Default payment-method **summary only**: `defaultPaymentMethodRef`
 *     (opaque provider token), brand, last4, expiry month/year. **No PAN,
 *     no CVC, no cardholder data** — capture is entirely on the
 *     provider's hosted tokenized surface (PRD §3.3), so nothing PCI-
 *     scoped ever reaches this schema.
 *   - Auto-recharge state: `autoRechargeEnabled` / `…ThresholdCredits` /
 *     `…PackId` plus the `autoRechargeInFlightKey` compare-and-set guard
 *     and a failure counter. The PRD put these on a `credit_accounts`
 *     table (§5.3(1)) that was deliberately designed away in Wave 9 M1
 *     (balance = SUM over `credit_ledger_entries`), so they land here —
 *     the row that already must exist for an off-session charge to be
 *     possible at all. See the entity header for the full rationale.
 *
 * `invoices` — the provider invoice/receipt mirror, written ONLY by the
 * signature-verified webhook handler. Entity:
 * `packages/agent/src/entities/invoice.entity.ts`.
 *
 *   - `(provider, providerInvoiceId)` UNIQUE so webhook re-delivery
 *     updates instead of duplicating.
 *   - Amounts are read from the provider event, never from a client.
 *   - `lineItems` is `text` carrying the entity's `simple-json` value
 *     (driver-portable — same posture as `meetings.participants`).
 *
 * Scope columns are raw uuids (no @ManyToOne — EW-654 cycle rule); FK
 * `userId` → `users.id` ON DELETE CASCADE on both tables.
 *
 * Forward-only + idempotent (`hasTable` guards) — house pattern of
 * `1783400000000-CreateCreditsLedgerAndEntitlements` /
 * `1783900000000-CreateFleetNodes`.
 */
export class CreateBillingProfilesAndInvoices1784300000000 implements MigrationInterface {
    name = 'CreateBillingProfilesAndInvoices1784300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('billing_profiles'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'billing_profiles',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'provider', type: 'varchar', length: '32' },
                        { name: 'providerCustomerId', type: 'varchar', length: '128' },
                        // Payment-method SUMMARY only — never a PAN.
                        {
                            name: 'defaultPaymentMethodRef',
                            type: 'varchar',
                            length: '128',
                            isNullable: true,
                        },
                        {
                            name: 'paymentMethodBrand',
                            type: 'varchar',
                            length: '32',
                            isNullable: true,
                        },
                        {
                            name: 'paymentMethodLast4',
                            type: 'varchar',
                            length: '4',
                            isNullable: true,
                        },
                        { name: 'paymentMethodExpMonth', type: 'int', isNullable: true },
                        { name: 'paymentMethodExpYear', type: 'int', isNullable: true },
                        // Auto-recharge (PRD §3.4).
                        { name: 'autoRechargeEnabled', type: 'boolean', default: false },
                        { name: 'autoRechargeThresholdCredits', type: 'int', isNullable: true },
                        {
                            name: 'autoRechargePackId',
                            type: 'varchar',
                            length: '64',
                            isNullable: true,
                        },
                        {
                            name: 'autoRechargeInFlightKey',
                            type: 'varchar',
                            length: '128',
                            isNullable: true,
                        },
                        { name: 'autoRechargeInFlightAt', type: 'timestamp', isNullable: true },
                        { name: 'autoRechargeFailureCount', type: 'int', default: 0 },
                        { name: 'autoRechargeLastFailureAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            // One profile per user — also the lookup the checkout path uses.
            await queryRunner.createIndex(
                'billing_profiles',
                new TableIndex({
                    name: 'idx_billing_profiles_user',
                    columnNames: ['userId'],
                    isUnique: true,
                }),
            );

            // Webhook events arrive keyed by provider customer, not user.
            await queryRunner.createIndex(
                'billing_profiles',
                new TableIndex({
                    name: 'idx_billing_profiles_customer',
                    columnNames: ['provider', 'providerCustomerId'],
                }),
            );

            await queryRunner.createForeignKey(
                'billing_profiles',
                new TableForeignKey({
                    name: 'fk_billing_profiles_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        if (!(await queryRunner.hasTable('invoices'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'invoices',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'userId', type: 'uuid' },
                        { name: 'organizationId', type: 'uuid', isNullable: true },
                        { name: 'tenantId', type: 'uuid', isNullable: true },
                        { name: 'provider', type: 'varchar', length: '32' },
                        { name: 'providerInvoiceId', type: 'varchar', length: '128' },
                        { name: 'number', type: 'varchar', length: '64', isNullable: true },
                        { name: 'status', type: 'varchar', length: '16' },
                        { name: 'periodStart', type: 'timestamp', isNullable: true },
                        { name: 'periodEnd', type: 'timestamp', isNullable: true },
                        { name: 'subtotalCents', type: 'int' },
                        { name: 'totalCents', type: 'int' },
                        { name: 'amountPaidCents', type: 'int', default: 0 },
                        { name: 'currency', type: 'varchar', length: '8' },
                        { name: 'hostedUrl', type: 'varchar', length: '512', isNullable: true },
                        { name: 'pdfUrl', type: 'varchar', length: '512', isNullable: true },
                        // The entity's `simple-json` value.
                        { name: 'lineItems', type: 'text', isNullable: true },
                        { name: 'issuedAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            // Owner-scoped invoice history, newest-first.
            await queryRunner.createIndex(
                'invoices',
                new TableIndex({
                    name: 'idx_invoices_user_issued',
                    columnNames: ['userId', 'issuedAt'],
                }),
            );

            // Webhook re-delivery must update, never duplicate.
            await queryRunner.createIndex(
                'invoices',
                new TableIndex({
                    name: 'idx_invoices_provider_ref',
                    columnNames: ['provider', 'providerInvoiceId'],
                    isUnique: true,
                }),
            );

            await queryRunner.createForeignKey(
                'invoices',
                new TableForeignKey({
                    name: 'fk_invoices_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('invoices')) {
            await queryRunner.dropTable('invoices', true);
        }
        if (await queryRunner.hasTable('billing_profiles')) {
            await queryRunner.dropTable('billing_profiles', true);
        }
    }
}
