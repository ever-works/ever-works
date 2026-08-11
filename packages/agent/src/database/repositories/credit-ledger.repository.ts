import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, EntityManager, In, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { CreditLedgerEntry, CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { User } from '@src/entities/user.entity';

/** Column values for a new ledger movement (balanceAfter is computed). */
export interface CreditLedgerWrite {
    userId: string;
    organizationId?: string | null;
    tenantId?: string | null;
    kind: CreditLedgerKind;
    /** Signed: positive = credit, negative = debit. */
    amountCredits: number;
    costCentsRef?: number | null;
    refType?: string | null;
    refId?: string | null;
    description?: string | null;
    idempotencyKey?: string | null;
}

export interface RecordAtomicOptions {
    /**
     * Reject the write when the resulting balance would fall below this
     * floor (the consumption negative-balance guard). `null`/`undefined`
     * = no floor (overdraft allowed).
     */
    minBalanceAfter?: number | null;
    /**
     * Clamp the (positive) amount so the resulting balance never exceeds
     * this ceiling — the non-accumulating daily-free-grant semantics. A
     * clamp down to zero (balance already at/above the ceiling) returns
     * `status: 'skipped'` and writes nothing.
     */
    maxBalanceAfter?: number | null;
}

export type RecordAtomicResult =
    /** Row inserted in this call. */
    | { status: 'created'; entry: CreditLedgerEntry }
    /** A row with the same idempotencyKey already existed — no write. */
    | { status: 'idempotent'; entry: CreditLedgerEntry }
    /** minBalanceAfter floor would be crossed — no write. */
    | { status: 'insufficient'; balance: number }
    /** maxBalanceAfter ceiling clamped the amount to ≤ 0 — no write. */
    | { status: 'skipped'; balance: number };

export interface CreditLedgerQuery {
    from?: Date;
    to?: Date;
    kinds?: CreditLedgerKind[];
    skip: number;
    take: number;
}

/**
 * Append-only credits ledger (pricing Wave 9 M1).
 *
 * All writes go through {@link recordAtomic}: ONE transaction that
 * checks idempotency, serializes concurrent writers per user (a
 * pessimistic lock on the owning `users` row where the driver supports
 * it — postgres/mysql; sqlite serializes writes at the connection), sums
 * the authoritative balance, applies the floor/ceiling guards, and
 * inserts the row with the materialized `balanceAfter`.
 */
@Injectable()
export class CreditLedgerRepository {
    constructor(
        @InjectRepository(CreditLedgerEntry)
        private readonly repository: Repository<CreditLedgerEntry>,
    ) {}

    async recordAtomic(
        write: CreditLedgerWrite,
        options: RecordAtomicOptions = {},
    ): Promise<RecordAtomicResult> {
        try {
            return await this.repository.manager.transaction(async (manager) => {
                const repo = manager.getRepository(CreditLedgerEntry);

                if (write.idempotencyKey) {
                    const existing = await repo.findOne({
                        where: { idempotencyKey: write.idempotencyKey },
                    });
                    if (existing) {
                        return { status: 'idempotent' as const, entry: existing };
                    }
                }

                await this.lockUserRow(manager, write.userId);

                const balance = await this.sumBalance(manager, write.userId);

                let amount = write.amountCredits;
                if (options.maxBalanceAfter !== null && options.maxBalanceAfter !== undefined) {
                    const headroom = options.maxBalanceAfter - balance;
                    if (amount > headroom) {
                        amount = headroom;
                    }
                    // A positive grant fully clamped away (balance already
                    // at/above the ceiling) writes nothing — a ceiling must
                    // never turn a grant into a debit.
                    if (write.amountCredits > 0 && amount <= 0) {
                        return { status: 'skipped' as const, balance };
                    }
                }

                const balanceAfter = balance + amount;
                if (
                    options.minBalanceAfter !== null &&
                    options.minBalanceAfter !== undefined &&
                    balanceAfter < options.minBalanceAfter
                ) {
                    return { status: 'insufficient' as const, balance };
                }

                const entry = await repo.save(
                    repo.create({
                        ...write,
                        amountCredits: amount,
                        balanceAfter,
                    }),
                );
                return { status: 'created' as const, entry };
            });
        } catch (error) {
            // Concurrent duplicate slipped past the in-tx idempotency read
            // and hit the UNIQUE index — resolve to the surviving row.
            if (write.idempotencyKey && this.isUniqueViolation(error)) {
                const existing = await this.findByIdempotencyKey(write.idempotencyKey);
                if (existing) {
                    return { status: 'idempotent', entry: existing };
                }
            }
            throw error;
        }
    }

    async getBalance(userId: string): Promise<number> {
        return this.sumBalance(this.repository.manager, userId);
    }

    async findByIdempotencyKey(idempotencyKey: string): Promise<CreditLedgerEntry | null> {
        return this.repository.findOne({ where: { idempotencyKey } });
    }

    /**
     * Newest movement correlated to one external object, e.g. the PURCHASE
     * row a payment produced (`refType='billing-payment'`, `refId={paymentId}`).
     * Used by the refund path to size the reversing entry from what was
     * actually granted rather than re-deriving it from a pack table that
     * may have been repriced since.
     */
    async findLatestByRef(refType: string, refId: string): Promise<CreditLedgerEntry | null> {
        return this.repository.findOne({
            where: { refType, refId },
            order: { createdAt: 'DESC' },
        });
    }

    async findForUser(
        userId: string,
        query: CreditLedgerQuery,
    ): Promise<{ entries: CreditLedgerEntry[]; total: number }> {
        const where: Record<string, unknown> = { userId };
        if (query.from && query.to) {
            where.createdAt = Between(query.from, query.to);
        } else if (query.from) {
            where.createdAt = MoreThanOrEqual(query.from);
        } else if (query.to) {
            where.createdAt = LessThan(query.to);
        }
        if (query.kinds && query.kinds.length > 0) {
            where.kind = In(query.kinds);
        }

        const [entries, total] = await this.repository.findAndCount({
            where,
            order: { createdAt: 'DESC' },
            skip: query.skip,
            take: query.take,
        });
        return { entries, total };
    }

    /**
     * Wave 13 (Billing/Usage UI) — period movement totals for the
     * Usage & Credits stat tiles: credits consumed (sum of debits,
     * returned positive) and credits added (sum of credits) inside a
     * half-open `[from, to)` window. ONE grouped query using the
     * `(userId, createdAt)` index; `CASE WHEN` is standard SQL so the
     * same statement runs on SQLite (CI/dev) and Postgres (prod).
     *
     * Negation is written `-1 * e.amountCredits`, never `-e.amountCredits`.
     * TypeORM rewrites `alias.property` into a quoted `"alias"."column"`
     * only when the reference is preceded by a space, `=`, `(` or the start
     * of the string — its regex is literally `([ =(]|^.{0})`. A unary minus
     * is not in that set, so `-e.amountCredits` survives into the emitted
     * SQL unquoted, Postgres folds it to `e.amountcredits`, and the whole
     * statement fails with 42703 ("column e.amountcredits does not exist").
     *
     * That made `GET /api/credits/usage-summary` return 500 on every
     * Postgres environment while CI stayed green, because SQLite matches
     * unquoted identifiers case-insensitively — the failure could not
     * reproduce on the driver the tests run against. `-1 *` puts a space
     * before the reference, so the rewrite fires and the column stays
     * quoted on both drivers. See the guard in
     * `credit-ledger.period-totals-sql.integration.spec.ts`.
     */
    async getPeriodTotals(
        userId: string,
        from: Date,
        to: Date,
    ): Promise<{ consumedCredits: number; addedCredits: number }> {
        const row = await this.repository
            .createQueryBuilder('e')
            .select(
                'COALESCE(SUM(CASE WHEN e.amountCredits < 0 THEN -1 * e.amountCredits ELSE 0 END), 0)',
                'consumed',
            )
            .addSelect(
                'COALESCE(SUM(CASE WHEN e.amountCredits > 0 THEN e.amountCredits ELSE 0 END), 0)',
                'added',
            )
            .where('e.userId = :userId', { userId })
            .andWhere('e.createdAt >= :from', { from })
            .andWhere('e.createdAt < :to', { to })
            .getRawOne<{ consumed: string; added: string }>();

        return {
            consumedCredits: Number(row?.consumed ?? 0),
            addedCredits: Number(row?.added ?? 0),
        };
    }

    /**
     * Serialize concurrent ledger writes for one user. Pessimistic row
     * locks are only supported on postgres/mysql/mariadb; better-sqlite3
     * throws `LockNotSupportedOnGivenDriverError` AND serializes writes
     * at the connection anyway, so the lock is safely skipped there.
     */
    private async lockUserRow(manager: EntityManager, userId: string): Promise<void> {
        const driver = manager.connection.options.type;
        if (driver === 'postgres' || driver === 'mysql' || driver === 'mariadb') {
            await manager.getRepository(User).findOne({
                where: { id: userId },
                lock: { mode: 'pessimistic_write' },
            });
        }
    }

    private async sumBalance(manager: EntityManager, userId: string): Promise<number> {
        const raw = await manager
            .getRepository(CreditLedgerEntry)
            .createQueryBuilder('entry')
            .select('COALESCE(SUM(entry.amountCredits), 0)', 'balance')
            .where('entry.userId = :userId', { userId })
            .getRawOne<{ balance: string | number }>();
        return Number(raw?.balance ?? 0);
    }

    /**
     * Driver-agnostic unique-violation detection: postgres exposes code
     * 23505, sqlite/mysql surface "UNIQUE"/"Duplicate" in the message.
     */
    private isUniqueViolation(error: unknown): boolean {
        const err = error as { code?: string; message?: string; driverError?: { code?: string } };
        if (err?.code === '23505' || err?.driverError?.code === '23505') {
            return true;
        }
        const message = String(err?.message ?? '');
        return (
            message.includes('UNIQUE constraint failed') ||
            message.includes('duplicate key') ||
            message.includes('Duplicate entry')
        );
    }
}
