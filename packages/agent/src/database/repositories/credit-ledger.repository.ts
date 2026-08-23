import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    Between,
    EntityManager,
    In,
    IsNull,
    LessThan,
    LessThanOrEqual,
    MoreThan,
    MoreThanOrEqual,
    Repository,
} from 'typeorm';
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
    /**
     * Bucket expiry for a POSITIVE write (plan allowance month end,
     * promotional grant). Ignored on debits. `null`/absent = never.
     */
    expiresAt?: Date | null;
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
    /**
     * Clock for bucket expiry decisions inside the transaction (tests);
     * defaults to `new Date()`.
     */
    now?: Date;
}

/** One bucket that lapsed: the `expiry` row written and the bucket it closed. */
export interface ExpiredBucket {
    entryId: string;
    expiredCredits: number;
    expiryEntry: CreditLedgerEntry;
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
 * Append-only credits ledger (pricing Wave 9 M1; buckets + expiry 2026-08).
 *
 * All writes go through {@link recordAtomic}: ONE transaction that
 * checks idempotency, serializes concurrent writers per user (a
 * pessimistic lock on the owning `users` row where the driver supports
 * it — postgres/mysql; sqlite serializes writes at the connection),
 * expires the user's due buckets ("expire on touch", so the SUM the
 * guards read never includes lapsed credits), sums the authoritative
 * balance, applies the floor/ceiling guards, inserts the row with the
 * materialized `balanceAfter`, and — for a debit — allocates the amount
 * against the user's open buckets soonest-expiring first.
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
        const now = options.now ?? new Date();
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

                // Expire on touch: any bucket whose expiry has passed is
                // closed BEFORE the balance is read, so a debit can never
                // spend lapsed credits and a grant's ceiling is measured
                // against what the user can actually use.
                await this.expireDueBucketsInTx(manager, write.userId, now);

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

                const { expiresAt, ...columns } = write;
                const entry = await repo.save(
                    repo.create({
                        ...columns,
                        amountCredits: amount,
                        balanceAfter,
                        // A positive row is a bucket: it starts fully
                        // unconsumed and may carry an expiry. A debit is
                        // not a bucket.
                        remainingCredits: amount > 0 ? amount : null,
                        expiresAt: amount > 0 ? (expiresAt ?? null) : null,
                    }),
                );

                if (amount < 0) {
                    await this.allocateDebit(manager, write.userId, -amount, now);
                }
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

    /**
     * Close every due bucket of one user: write an `expiry` row of
     * `-remainingCredits` (idempotency `expiry:{entryId}`) and zero the
     * bucket. Runs in its own transaction under the user lock; the
     * write path calls the in-transaction variant itself.
     */
    async expireDueBuckets(userId: string, now: Date = new Date()): Promise<ExpiredBucket[]> {
        return this.repository.manager.transaction(async (manager) => {
            await this.lockUserRow(manager, userId);
            return this.expireDueBucketsInTx(manager, userId, now);
        });
    }

    /**
     * Users that have at least one due bucket — the daily sweep's work
     * list. Bounded; the sweep loops until empty.
     */
    async findUsersWithDueBuckets(now: Date, limit = 500): Promise<string[]> {
        const rows = await this.repository
            .createQueryBuilder('e')
            .select('e.userId', 'userId')
            .where('e.remainingCredits > 0')
            .andWhere('e.expiresAt IS NOT NULL')
            .andWhere('e.expiresAt <= :now', { now })
            .groupBy('e.userId')
            .limit(limit)
            .getRawMany<{ userId: string }>();
        return rows.map((row) => row.userId);
    }

    /**
     * AVAILABLE balance: the ledger SUM minus the unconsumed part of
     * buckets that have lapsed but have not been swept yet. The two only
     * differ in the window between a bucket's expiry instant and the
     * next write/sweep for that user; reads must not pretend lapsed
     * credits are spendable during it.
     */
    async getBalance(userId: string, now: Date = new Date()): Promise<number> {
        const manager = this.repository.manager;
        const [sum, dueRemaining] = await Promise.all([
            this.sumBalance(manager, userId),
            this.sumDueRemaining(manager, userId, now),
        ]);
        return sum - dueRemaining;
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
    ): Promise<{ consumedCredits: number; addedCredits: number; expiredCredits: number }> {
        // `consumed` is usage only: expiry rows are also negative but are
        // not something the user spent, so they are reported apart
        // (kind-tagged, not sign-tagged) and never inflate "Credits used".
        const row = await this.repository
            .createQueryBuilder('e')
            .select(
                'COALESCE(SUM(CASE WHEN e.amountCredits < 0 AND e.kind <> :expiryKind THEN -1 * e.amountCredits ELSE 0 END), 0)',
                'consumed',
            )
            .addSelect(
                'COALESCE(SUM(CASE WHEN e.amountCredits > 0 THEN e.amountCredits ELSE 0 END), 0)',
                'added',
            )
            .addSelect(
                'COALESCE(SUM(CASE WHEN e.kind = :expiryKind THEN -1 * e.amountCredits ELSE 0 END), 0)',
                'expired',
            )
            .where('e.userId = :userId', { userId })
            .andWhere('e.createdAt >= :from', { from })
            .andWhere('e.createdAt < :to', { to })
            .setParameter('expiryKind', CreditLedgerKind.EXPIRY)
            .getRawOne<{ consumed: string; added: string; expired: string }>();

        return {
            consumedCredits: Number(row?.consumed ?? 0),
            addedCredits: Number(row?.added ?? 0),
            expiredCredits: Number(row?.expired ?? 0),
        };
    }

    /**
     * Allocate a debit against the user's open buckets: expiring buckets
     * first (soonest expiry, then oldest), then non-expiring buckets
     * oldest-first. Two ordered reads rather than one `ORDER BY expiresAt
     * NULLS LAST` — postgres sorts NULLs last on ASC, sqlite sorts them
     * first, and the allocation order must not depend on the driver.
     * Any remainder (possible only when overdraft was allowed) stays
     * unallocated; the ledger SUM is still right.
     */
    private async allocateDebit(
        manager: EntityManager,
        userId: string,
        credits: number,
        now: Date,
    ): Promise<void> {
        const repo = manager.getRepository(CreditLedgerEntry);
        let left = credits;
        const expiring = await repo.find({
            where: { userId, remainingCredits: MoreThan(0), expiresAt: MoreThan(now) },
            order: { expiresAt: 'ASC', createdAt: 'ASC' },
        });
        const perpetual = await repo.find({
            where: { userId, remainingCredits: MoreThan(0), expiresAt: IsNull() },
            order: { createdAt: 'ASC' },
        });
        for (const bucket of [...expiring, ...perpetual]) {
            if (left <= 0) break;
            const available = bucket.remainingCredits ?? 0;
            const take = Math.min(available, left);
            if (take <= 0) continue;
            await repo.update(bucket.id, { remainingCredits: available - take });
            left -= take;
        }
    }

    private async expireDueBucketsInTx(
        manager: EntityManager,
        userId: string,
        now: Date,
    ): Promise<ExpiredBucket[]> {
        const repo = manager.getRepository(CreditLedgerEntry);
        const due = await repo.find({
            where: { userId, remainingCredits: MoreThan(0), expiresAt: LessThanOrEqual(now) },
            order: { expiresAt: 'ASC', createdAt: 'ASC' },
        });
        const expired: ExpiredBucket[] = [];
        for (const bucket of due) {
            const remaining = bucket.remainingCredits ?? 0;
            if (remaining <= 0) continue;
            const idempotencyKey = `expiry:${bucket.id}`;
            const already = await repo.findOne({ where: { idempotencyKey } });
            if (already) {
                // Row exists but the bucket was not zeroed (crash between
                // the two writes) — finish the job, write nothing twice.
                await repo.update(bucket.id, { remainingCredits: 0 });
                continue;
            }
            const balance = await this.sumBalance(manager, userId);
            const expiryEntry = await repo.save(
                repo.create({
                    userId,
                    organizationId: bucket.organizationId ?? null,
                    tenantId: bucket.tenantId ?? null,
                    kind: CreditLedgerKind.EXPIRY,
                    amountCredits: -remaining,
                    costCentsRef: null,
                    refType: 'credit-ledger-entry',
                    refId: bucket.id,
                    balanceAfter: balance - remaining,
                    description: `Expired: ${bucket.description ?? bucket.kind}`,
                    idempotencyKey,
                    remainingCredits: null,
                    expiresAt: null,
                }),
            );
            await repo.update(bucket.id, { remainingCredits: 0 });
            expired.push({ entryId: bucket.id, expiredCredits: remaining, expiryEntry });
        }
        return expired;
    }

    /** Unconsumed credits in buckets that lapsed but were not swept yet. */
    private async sumDueRemaining(
        manager: EntityManager,
        userId: string,
        now: Date,
    ): Promise<number> {
        const raw = await manager
            .getRepository(CreditLedgerEntry)
            .createQueryBuilder('entry')
            .select('COALESCE(SUM(entry.remainingCredits), 0)', 'due')
            .where('entry.userId = :userId', { userId })
            .andWhere('entry.remainingCredits > 0')
            .andWhere('entry.expiresAt IS NOT NULL')
            .andWhere('entry.expiresAt <= :now', { now })
            .getRawOne<{ due: string | number }>();
        return Number(raw?.due ?? 0);
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
