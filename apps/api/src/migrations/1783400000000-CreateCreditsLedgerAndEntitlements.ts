import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';
import { randomUUID } from 'crypto';

/**
 * Credits ledger + plan entitlements (pricing Wave 9 M1).
 *
 * `credit_ledger_entries` — append-only signed balance movements; the
 * usage currency layered on the EXISTING costCents metering
 * (`plugin_usage_events`). Entity:
 * `packages/agent/src/entities/credit-ledger-entry.entity.ts`.
 *
 *   - `amountCredits` signed int (+credit / −debit); `balanceAfter`
 *     materialized at write time inside the recordAtomic transaction
 *     (SUM per user stays authoritative).
 *   - `idempotencyKey` UNIQUE + nullable — cron re-runs and webhook
 *     re-deliveries are no-ops (`daily:{userId}:{date}`, `run:{runId}`).
 *   - `refType`/`refId` + `costCentsRef` correlate a movement back to
 *     its run/generation/task and the metered cost it derived from, so
 *     credits and the metering pipeline reconcile without
 *     double-charging.
 *   - Scope columns are raw uuids (no @ManyToOne — EW-654 cycle rule);
 *     FK `userId` → `users.id` ON DELETE CASCADE only.
 *
 * `plan_entitlements` — per-plan feature/limit levers as (planId, key)
 * rows, additive beside the columns already on `subscription_plans`.
 * `planId` is the plan CODE ('free'/…): plans are seeded at boot AFTER
 * migrations, so the row uuid cannot be referenced here. Entity:
 * `packages/agent/src/entities/plan-entitlement.entity.ts`.
 *
 * Seeds (INSERT-if-missing, same migration per the Wave 9 spec): free
 * plan `daily-free-credits` (env CREDITS_DAILY_FREE, default 50),
 * `max-concurrent-runs` (default 3 — the D5 safety-valve posture),
 * `works-limit` (default 1, mirroring FREE `maxWorks`).
 *
 * Forward-only + idempotent (`hasTable` / seed-existence guards) —
 * house pattern of `1782700000000-AddTaskIsolationColumns` /
 * `1783200000000-CreateIngestedEvents`.
 */
export class CreateCreditsLedgerAndEntitlements1783400000000 implements MigrationInterface {
    name = 'CreateCreditsLedgerAndEntitlements1783400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        if (!(await queryRunner.hasTable('credit_ledger_entries'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'credit_ledger_entries',
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
                        { name: 'kind', type: 'varchar', length: '16' },
                        { name: 'amountCredits', type: 'int' },
                        { name: 'costCentsRef', type: 'int', isNullable: true },
                        { name: 'refType', type: 'varchar', length: '32', isNullable: true },
                        { name: 'refId', type: 'uuid', isNullable: true },
                        { name: 'balanceAfter', type: 'int' },
                        { name: 'description', type: 'varchar', length: '256', isNullable: true },
                        {
                            name: 'idempotencyKey',
                            type: 'varchar',
                            length: '128',
                            isNullable: true,
                        },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            // Ledger reads are owner-scoped, newest-first.
            await queryRunner.createIndex(
                'credit_ledger_entries',
                new TableIndex({
                    name: 'idx_credit_ledger_user_created',
                    columnNames: ['userId', 'createdAt'],
                }),
            );

            // Kind filters on the Billing-page ledger table (Wave 13 UI).
            await queryRunner.createIndex(
                'credit_ledger_entries',
                new TableIndex({
                    name: 'idx_credit_ledger_user_kind',
                    columnNames: ['userId', 'kind'],
                }),
            );

            // Idempotent writers — re-delivery/re-run must be a no-op.
            // UNIQUE over a nullable column: NULLs don't collide (pg/mysql).
            await queryRunner.createIndex(
                'credit_ledger_entries',
                new TableIndex({
                    name: 'idx_credit_ledger_idempotency',
                    columnNames: ['idempotencyKey'],
                    isUnique: true,
                }),
            );

            await queryRunner.createForeignKey(
                'credit_ledger_entries',
                new TableForeignKey({
                    name: 'fk_credit_ledger_user',
                    columnNames: ['userId'],
                    referencedTableName: 'users',
                    referencedColumnNames: ['id'],
                    onDelete: 'CASCADE',
                }),
            );
        }

        if (!(await queryRunner.hasTable('plan_entitlements'))) {
            await queryRunner.createTable(
                new Table({
                    name: 'plan_entitlements',
                    columns: [
                        {
                            name: 'id',
                            type: 'uuid',
                            isPrimary: true,
                            generationStrategy: 'uuid',
                            default: 'uuid_generate_v4()',
                        },
                        { name: 'planId', type: 'varchar', length: '64' },
                        { name: 'key', type: 'varchar', length: '64' },
                        { name: 'valueInt', type: 'int', isNullable: true },
                        { name: 'valueText', type: 'varchar', length: '128', isNullable: true },
                        { name: 'createdAt', type: 'timestamp', default: 'now()' },
                        { name: 'updatedAt', type: 'timestamp', default: 'now()' },
                    ],
                }),
                true,
            );

            await queryRunner.createIndex(
                'plan_entitlements',
                new TableIndex({
                    name: 'idx_plan_entitlements_plan_key',
                    columnNames: ['planId', 'key'],
                    isUnique: true,
                }),
            );
        }

        // Free-plan seeds — INSERT-if-missing so a re-run (or an operator
        // who already tuned a lever) never duplicates or overwrites.
        const intFromEnv = (name: string, fallback: number): number => {
            const parsed = parseInt(process.env[name] || '');
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
        };
        const seeds: Array<{ planId: string; key: string; valueInt: number }> = [
            {
                planId: 'free',
                key: 'daily-free-credits',
                valueInt: intFromEnv('CREDITS_DAILY_FREE', 50),
            },
            {
                planId: 'free',
                key: 'max-concurrent-runs',
                valueInt: intFromEnv('CREDITS_FREE_MAX_CONCURRENT_RUNS', 3),
            },
            {
                planId: 'free',
                key: 'works-limit',
                valueInt: intFromEnv('CREDITS_FREE_WORKS_LIMIT', 1),
            },
        ];

        for (const seed of seeds) {
            const existing = await queryRunner.manager
                .createQueryBuilder()
                .select('pe.id', 'id')
                .from('plan_entitlements', 'pe')
                // Identifiers are double-quoted explicitly so this query does not
                // depend on TypeORM resolving the raw table name to an entity.
                //
                // It normally does: the runtime DataSource registers every entity
                // (`database.config.ts` → `entities: ENTITIES`) alongside the
                // migrations glob, so `.from('plan_entitlements', 'pe')` matches
                // `PlanEntitlement` BY TABLE NAME and the emitted SQL is fully
                // quoted — which is why this seed has always worked on Postgres.
                // Quoting here only removes the dependency on that lookup; it is
                // what makes the query correct for a table with NO entity, where
                // TypeORM would emit `pe.planId` verbatim and Postgres would fold
                // it to `pe.planid` (sqlite, which CI runs on, matches unquoted
                // identifiers case-insensitively and would not catch it).
                .where('pe."planId" = :planId AND pe."key" = :key', {
                    planId: seed.planId,
                    key: seed.key,
                })
                .getRawOne();
            if (existing) {
                continue;
            }
            await queryRunner.manager
                .createQueryBuilder()
                .insert()
                .into('plan_entitlements', ['id', 'planId', 'key', 'valueInt'])
                .values({
                    id: randomUUID(),
                    planId: seed.planId,
                    key: seed.key,
                    valueInt: seed.valueInt,
                })
                .execute();
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        if (await queryRunner.hasTable('plan_entitlements')) {
            await queryRunner.dropTable('plan_entitlements', true);
        }
        if (await queryRunner.hasTable('credit_ledger_entries')) {
            await queryRunner.dropTable('credit_ledger_entries', true);
        }
    }
}
