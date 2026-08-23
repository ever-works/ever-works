import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';
import { randomUUID } from 'crypto';

/**
 * Credit-ledger buckets + expiry, and the universal daily allowance
 * (billing spec §3.2 — `docs/specs/features/billing/spec.md`).
 *
 * `credit_ledger_entries` gains two nullable columns:
 *
 *  - `remainingCredits` — for a POSITIVE row (purchase / grant / daily-free /
 *    positive adjustment), the part not yet consumed. NULL on debits.
 *    Debits are allocated against open buckets soonest-expiring first
 *    inside the same transaction as the debit
 *    (`CreditLedgerRepository.recordAtomic`).
 *  - `expiresAt`        — when the unconsumed part lapses. NULL = never
 *    (purchases, refund adjustments, daily-free top-ups). Plan allowance
 *    grants carry the end of their allowance month; the daily sweep writes
 *    an `expiry` row of `-remainingCredits` for every due bucket.
 *
 * Backfill: every existing positive row starts as a full bucket
 * (`remainingCredits = amountCredits`), then every existing debit is
 * replayed per user in `createdAt` order so the buckets reflect what was
 * actually consumed. Nothing existing today carries an expiry, so the
 * replay is pure FIFO. The loop runs in TypeScript over small per-user
 * batches rather than in SQL so SQLite (demo/CI) and Postgres (stage/prod)
 * behave identically; the ledger is small pre-launch.
 *
 * Entitlement seeds (INSERT-if-missing): `daily-free-credits = 50` for
 * `standard` and `premium`. The free plan already has its row from
 * `1783400000000`. Code now treats the daily allowance as universal (every
 * plan code falls back to the platform default), so these rows are
 * explicitness, not behaviour — an operator who wants a different level
 * per tier edits them.
 *
 * Forward-only with per-step guards (house pattern), safe to re-run.
 */
export class AddCreditLedgerBuckets1786950000000 implements MigrationInterface {
    name = 'AddCreditLedgerBuckets1786950000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('credit_ledger_entries');
        if (!table) return;

        const hadRemaining = Boolean(table.findColumnByName('remainingCredits'));
        if (!hadRemaining) {
            await queryRunner.query(
                `ALTER TABLE "credit_ledger_entries" ADD COLUMN "remainingCredits" integer`,
            );
        }
        if (!table.findColumnByName('expiresAt')) {
            await queryRunner.query(
                `ALTER TABLE "credit_ledger_entries" ADD COLUMN "expiresAt" TIMESTAMP`,
            );
        }

        const refreshed = await queryRunner.getTable('credit_ledger_entries');
        if (
            refreshed &&
            !refreshed.indices.some((i) => i.name === 'idx_credit_ledger_user_expires')
        ) {
            await queryRunner.createIndex(
                'credit_ledger_entries',
                new TableIndex({
                    name: 'idx_credit_ledger_user_expires',
                    columnNames: ['userId', 'expiresAt'],
                }),
            );
        }

        // Backfill only on the first application (the column did not exist
        // before). A re-run after a partial failure is still safe: rows
        // that already carry a value are left alone by the first UPDATE
        // (IS NULL guard) and the replay below is idempotent for them.
        if (!hadRemaining) {
            await queryRunner.query(
                `UPDATE "credit_ledger_entries" SET "remainingCredits" = "amountCredits" ` +
                    `WHERE "amountCredits" > 0 AND "remainingCredits" IS NULL`,
            );
            await this.replayDebits(queryRunner);
        }

        // Universal daily allowance — explicit rows for the paid cloud tiers.
        const intFromEnv = (name: string, fallback: number): number => {
            const parsed = parseInt(process.env[name] || '');
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
        };
        const dailyFree = intFromEnv('CREDITS_DAILY_FREE', 50);
        if (await queryRunner.hasTable('plan_entitlements')) {
            for (const planId of ['standard', 'premium']) {
                const existing = await queryRunner.manager
                    .createQueryBuilder()
                    .select('pe.id', 'id')
                    .from('plan_entitlements', 'pe')
                    .where('pe.planId = :planId AND pe.key = :key', {
                        planId,
                        key: 'daily-free-credits',
                    })
                    .getRawOne();
                if (existing) continue;
                await queryRunner.manager
                    .createQueryBuilder()
                    .insert()
                    .into('plan_entitlements', ['id', 'planId', 'key', 'valueInt'])
                    .values({
                        id: randomUUID(),
                        planId,
                        key: 'daily-free-credits',
                        valueInt: dailyFree,
                    })
                    .execute();
            }
        }
    }

    /**
     * FIFO replay of historical debits against the freshly-opened buckets,
     * one user at a time. Reads `(id, amountCredits, remainingCredits,
     * createdAt)` ordered by `createdAt, id`; walks debits allocating from
     * the earliest open bucket; writes back every bucket that changed.
     */
    private async replayDebits(queryRunner: QueryRunner): Promise<void> {
        // Query builder throughout: it renders the right placeholder style
        // for the driver (`?` on sqlite, `$n` on postgres).
        const users = await queryRunner.manager
            .createQueryBuilder()
            .select('e.userId', 'userId')
            .from('credit_ledger_entries', 'e')
            .where('e.amountCredits < 0')
            .groupBy('e.userId')
            .getRawMany<{ userId: string }>();

        for (const { userId } of users) {
            const rows = await queryRunner.manager
                .createQueryBuilder()
                .select('e.id', 'id')
                .addSelect('e.amountCredits', 'amountCredits')
                .addSelect('e.remainingCredits', 'remainingCredits')
                .from('credit_ledger_entries', 'e')
                .where('e.userId = :userId', { userId })
                .orderBy('e.createdAt', 'ASC')
                .addOrderBy('e.id', 'ASC')
                .getRawMany<{
                    id: string;
                    amountCredits: number | string;
                    remainingCredits: number | string | null;
                }>();

            const buckets: Array<{ id: string; remaining: number; dirty: boolean }> = [];
            for (const row of rows) {
                const amount = Number(row.amountCredits);
                if (amount > 0) {
                    buckets.push({
                        id: row.id,
                        remaining: Number(row.remainingCredits ?? amount),
                        dirty: false,
                    });
                    continue;
                }
                let left = -amount;
                for (const bucket of buckets) {
                    if (left <= 0) break;
                    if (bucket.remaining <= 0) continue;
                    const take = Math.min(bucket.remaining, left);
                    bucket.remaining -= take;
                    bucket.dirty = true;
                    left -= take;
                }
            }
            for (const bucket of buckets) {
                if (!bucket.dirty) continue;
                await queryRunner.manager
                    .createQueryBuilder()
                    .update('credit_ledger_entries')
                    .set({ remainingCredits: bucket.remaining })
                    .where('id = :id', { id: bucket.id })
                    .execute();
            }
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        const table = await queryRunner.getTable('credit_ledger_entries');
        if (!table) return;
        if (table.indices.some((i) => i.name === 'idx_credit_ledger_user_expires')) {
            await queryRunner.dropIndex('credit_ledger_entries', 'idx_credit_ledger_user_expires');
        }
        for (const col of ['remainingCredits', 'expiresAt']) {
            if (table.findColumnByName(col)) {
                await queryRunner.query(`ALTER TABLE "credit_ledger_entries" DROP COLUMN "${col}"`);
            }
        }
    }
}
