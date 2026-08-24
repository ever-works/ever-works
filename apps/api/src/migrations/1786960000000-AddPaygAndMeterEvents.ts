import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';
import { randomUUID } from 'crypto';

/**
 * Pay-as-you-go on Stripe Billing Meters + enforcement seeds (billing spec
 * §3.5 / §3.7 — `docs/specs/features/billing/spec.md`).
 *
 * `billing_profiles` gains the pay-as-you-go columns: the owner's opt-in,
 * the provider's metered subscription + item, its reconciled status and
 * current cycle, the owner's monthly cap, and a once-per-cycle
 * notification latch. All nullable/defaulted — every pre-existing profile
 * reads as "pay-as-you-go off".
 *
 * `credit_meter_events` — one row per run whose cost overflowed the
 * prepaid balance while pay-as-you-go was on: the credits reported to
 * the provider's usage meter (and the part written off beyond the cap),
 * the cycle it belongs to, and the send status the flush cron retries.
 * Entity: `packages/agent/src/entities/credit-meter-event.entity.ts`.
 * `identifier` (`run:{runId}`) is UNIQUE — our idempotency key and the
 * provider's meter-event identifier at once.
 *
 * Seeds (INSERT-if-missing): `credit-limited = 1` for `free`, `standard`,
 * `premium`. With the provider configured, `CREDITS_ENFORCEMENT` now
 * defaults to on (FR-30), and this row is what makes the three cloud
 * tiers subject to the dispatch-gate balance/headroom check. Self-hosted
 * plan codes carry no row and are never limited.
 *
 * Forward-only with per-step guards (house pattern), safe to re-run.
 */
export class AddPaygAndMeterEvents1786960000000 implements MigrationInterface {
    name = 'AddPaygAndMeterEvents1786960000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const profiles = await queryRunner.getTable('billing_profiles');
        if (profiles) {
            const addColumn = async (name: string, ddl: string) => {
                if (!profiles.findColumnByName(name)) {
                    await queryRunner.query(`ALTER TABLE "billing_profiles" ADD COLUMN ${ddl}`);
                }
            };
            await addColumn('paygEnabled', `"paygEnabled" boolean NOT NULL DEFAULT false`);
            await addColumn('paygSubscriptionId', `"paygSubscriptionId" varchar(128)`);
            await addColumn('paygSubscriptionItemId', `"paygSubscriptionItemId" varchar(128)`);
            await addColumn('paygStatus', `"paygStatus" varchar(32)`);
            await addColumn('paygPeriodStart', `"paygPeriodStart" TIMESTAMP`);
            await addColumn('paygPeriodEnd', `"paygPeriodEnd" TIMESTAMP`);
            await addColumn('paygMonthlyCapCredits', `"paygMonthlyCapCredits" integer`);
            await addColumn(
                'paygCapNotifiedPercent',
                `"paygCapNotifiedPercent" integer NOT NULL DEFAULT 0`,
            );
        }

        if (!(await queryRunner.hasTable('credit_meter_events'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'credit_meter_events',
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
                        { name: 'runId', type: 'uuid' },
                        { name: 'identifier', type: 'varchar', length: '128' },
                        { name: 'credits', type: 'int' },
                        { name: 'writtenOffCredits', type: 'int', default: 0 },
                        { name: 'costCentsRef', type: 'int', isNullable: true },
                        { name: 'periodStart', type: 'timestamp' },
                        { name: 'periodEnd', type: 'timestamp' },
                        { name: 'status', type: 'varchar', length: '16', default: "'pending'" },
                        { name: 'attempts', type: 'int', default: 0 },
                        { name: 'lastError', type: 'varchar', length: '256', isNullable: true },
                        { name: 'sentAt', type: 'timestamp', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );
            await queryRunner.createIndex(
                'credit_meter_events',
                new TableIndex({
                    name: 'idx_credit_meter_events_identifier',
                    columnNames: ['identifier'],
                    isUnique: true,
                }),
            );
            await queryRunner.createIndex(
                'credit_meter_events',
                new TableIndex({
                    name: 'idx_credit_meter_events_user_period',
                    columnNames: ['userId', 'periodStart'],
                }),
            );
            await queryRunner.createIndex(
                'credit_meter_events',
                new TableIndex({
                    name: 'idx_credit_meter_events_status_created',
                    columnNames: ['status', 'createdAt'],
                }),
            );
            if (await queryRunner.hasTable('users')) {
                await queryRunner.createForeignKey(
                    'credit_meter_events',
                    new TableForeignKey({
                        name: 'fk_credit_meter_events_user',
                        columnNames: ['userId'],
                        referencedTableName: 'users',
                        referencedColumnNames: ['id'],
                        onDelete: 'CASCADE',
                    }),
                );
            }
        }

        if (await queryRunner.hasTable('plan_entitlements')) {
            for (const planId of ['free', 'standard', 'premium']) {
                const existing = await queryRunner.manager
                    .createQueryBuilder()
                    .select('pe.id', 'id')
                    .from('plan_entitlements', 'pe')
                    .where('pe."planId" = :planId AND pe."key" = :key', {
                        planId,
                        key: 'credit-limited',
                    })
                    .getRawOne();
                if (existing) continue;
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into('plan_entitlements', ['id', 'planId', 'key', 'valueInt'])
                    .values({ id: randomUUID(), planId, key: 'credit-limited', valueInt: 1 })
                    .execute();
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('credit_meter_events')) {
            await queryRunner.dropTable('credit_meter_events', true);
        }
        const profiles = await queryRunner.getTable('billing_profiles');
        if (!profiles) return;
        for (const col of [
            'paygEnabled',
            'paygSubscriptionId',
            'paygSubscriptionItemId',
            'paygStatus',
            'paygPeriodStart',
            'paygPeriodEnd',
            'paygMonthlyCapCredits',
            'paygCapNotifiedPercent',
        ]) {
            if (profiles.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "billing_profiles" DROP COLUMN "${col}"`);
            }
        }
    }
}
