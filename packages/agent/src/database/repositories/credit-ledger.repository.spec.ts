import { In } from 'typeorm';
import { CreditLedgerRepository } from './credit-ledger.repository';
import { CreditLedgerEntry, CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { User } from '@src/entities/user.entity';

/**
 * CreditLedgerRepository owns the ONE ledger write path
 * (`recordAtomic`): a single transaction that checks idempotency,
 * serializes writers per user (postgres/mysql row lock; skipped on
 * sqlite), sums the authoritative balance and materializes
 * `balanceAfter` on the inserted row. These tests drive the mocked
 * TypeORM manager through that transaction and pin the balance math,
 * the idempotency short-circuits, the floor/ceiling guards, and the
 * driver-gated lock.
 */

type QbMock = {
    select: jest.Mock;
    where: jest.Mock;
    getRawOne: jest.Mock;
};

function makeQb(balance: number | string): QbMock {
    const qb: any = {};
    qb.select = jest.fn().mockReturnValue(qb);
    qb.addSelect = jest.fn().mockReturnValue(qb);
    qb.where = jest.fn().mockReturnValue(qb);
    qb.andWhere = jest.fn().mockReturnValue(qb);
    qb.setParameter = jest.fn().mockReturnValue(qb);
    qb.groupBy = jest.fn().mockReturnValue(qb);
    qb.limit = jest.fn().mockReturnValue(qb);
    // `balance` feeds sumBalance; the due-remaining / expired aggregates
    // read other keys and therefore coerce to 0 on this harness.
    qb.getRawOne = jest.fn().mockResolvedValue({ balance });
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
}

function makeHarness(options: { balance?: number | string; driver?: string } = {}) {
    const entryRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        // Bucket reads (expire-on-touch + debit allocation): no open
        // buckets on this harness unless a test seeds some.
        find: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(undefined),
        create: jest.fn((value: any) => value),
        save: jest.fn(async (value: any) => ({ id: 'entry-1', ...value })),
        createQueryBuilder: jest.fn(() => makeQb(options.balance ?? 0)),
        findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const userRepo = {
        findOne: jest.fn().mockResolvedValue({ id: 'user-1' }),
    };
    const manager: any = {
        connection: { options: { type: options.driver ?? 'better-sqlite3' } },
        getRepository: jest.fn((entity: unknown) => {
            if (entity === CreditLedgerEntry) return entryRepo;
            if (entity === User) return userRepo;
            throw new Error('Unexpected repository request');
        }),
        transaction: jest.fn(async (cb: (m: any) => Promise<unknown>) => cb(manager)),
    };
    const topLevelRepository: any = {
        manager,
        findOne: jest.fn().mockResolvedValue(null),
        findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const repository = new CreditLedgerRepository(topLevelRepository);
    return { repository, entryRepo, userRepo, manager, topLevelRepository };
}

const BASE_WRITE = {
    userId: 'user-1',
    kind: CreditLedgerKind.GRANT,
    amountCredits: 25,
};

describe('CreditLedgerRepository.recordAtomic', () => {
    it('computes balanceAfter from the summed prior balance and inserts the row', async () => {
        const { repository, entryRepo } = makeHarness({ balance: 100 });

        const result = await repository.recordAtomic({ ...BASE_WRITE, amountCredits: 25 });

        expect(result.status).toBe('created');
        expect(entryRepo.save).toHaveBeenCalledTimes(1);
        const saved = entryRepo.save.mock.calls[0][0];
        expect(saved.amountCredits).toBe(25);
        expect(saved.balanceAfter).toBe(125);
    });

    it('is idempotent: an existing idempotencyKey row is returned without a second insert', async () => {
        const { repository, entryRepo } = makeHarness();
        const existing = { id: 'existing', idempotencyKey: 'daily:user-1:2026-07-25' };
        entryRepo.findOne.mockResolvedValue(existing);

        const result = await repository.recordAtomic({
            ...BASE_WRITE,
            idempotencyKey: 'daily:user-1:2026-07-25',
        });

        expect(result).toEqual({ status: 'idempotent', entry: existing });
        expect(entryRepo.save).not.toHaveBeenCalled();
    });

    it('resolves a concurrent-duplicate unique violation to the surviving row', async () => {
        const { repository, manager, topLevelRepository } = makeHarness();
        const survivor = { id: 'survivor', idempotencyKey: 'run:run-9' };
        manager.transaction.mockRejectedValue({
            code: '23505',
            message: 'duplicate key value violates unique constraint',
        });
        topLevelRepository.findOne.mockResolvedValue(survivor);

        const result = await repository.recordAtomic({
            ...BASE_WRITE,
            idempotencyKey: 'run:run-9',
        });

        expect(result).toEqual({ status: 'idempotent', entry: survivor });
    });

    it('rejects a debit that would cross the minBalanceAfter floor (negative guard)', async () => {
        const { repository, entryRepo } = makeHarness({ balance: 10 });

        const result = await repository.recordAtomic(
            { ...BASE_WRITE, kind: CreditLedgerKind.CONSUMPTION, amountCredits: -20 },
            { minBalanceAfter: 0 },
        );

        expect(result).toEqual({ status: 'insufficient', balance: 10 });
        expect(entryRepo.save).not.toHaveBeenCalled();
    });

    it('allows the debit when no floor is set (overdraft) and materializes the negative balance', async () => {
        const { repository, entryRepo } = makeHarness({ balance: 10 });

        const result = await repository.recordAtomic({
            ...BASE_WRITE,
            kind: CreditLedgerKind.CONSUMPTION,
            amountCredits: -20,
        });

        expect(result.status).toBe('created');
        expect(entryRepo.save.mock.calls[0][0].balanceAfter).toBe(-10);
    });

    it('clamps a grant to the maxBalanceAfter ceiling (non-accumulating daily grant)', async () => {
        const { repository, entryRepo } = makeHarness({ balance: 30 });

        const result = await repository.recordAtomic(
            { ...BASE_WRITE, kind: CreditLedgerKind.DAILY_FREE, amountCredits: 50 },
            { maxBalanceAfter: 50 },
        );

        expect(result.status).toBe('created');
        const saved = entryRepo.save.mock.calls[0][0];
        expect(saved.amountCredits).toBe(20);
        expect(saved.balanceAfter).toBe(50);
    });

    it('skips entirely when the balance is already at/above the ceiling', async () => {
        const { repository, entryRepo } = makeHarness({ balance: 80 });

        const result = await repository.recordAtomic(
            { ...BASE_WRITE, kind: CreditLedgerKind.DAILY_FREE, amountCredits: 50 },
            { maxBalanceAfter: 50 },
        );

        expect(result).toEqual({ status: 'skipped', balance: 80 });
        expect(entryRepo.save).not.toHaveBeenCalled();
    });

    it('locks the user row on postgres WITHOUT joining eager relations, and skips the lock on sqlite', async () => {
        const pg = makeHarness({ driver: 'postgres' });
        await pg.repository.recordAtomic({ ...BASE_WRITE });
        // 🛑 `loadEagerRelations: false` is the whole point of this assertion.
        // `User.defaultPlan` is an eager @ManyToOne, so without it TypeORM
        // LEFT JOINs `subscription_plans` and PostgreSQL rejects the lock with
        // "FOR UPDATE cannot be applied to the nullable side of an outer join".
        // That throw escaped every recordAtomic call — the single write path for
        // the entire ledger — so on Postgres NOTHING could be credited: not the
        // daily free grant, not a monthly plan allowance, and not a paid credit
        // pack (the customer was charged, the webhook 500d, Stripe retried).
        // Measured in production before the fix: the 00:05Z sweep on 2026-08-24
        // returned granted: 0, scanned: 30, failed: 30 with an empty ledger.
        //
        // This asserts the OPTION rather than the behaviour because the suite
        // runs on sqlite, where the lock is skipped entirely and the broken
        // statement is never executed. The behaviour was verified separately by
        // replaying both queries against a real PostgreSQL 16.
        expect(pg.userRepo.findOne).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            lock: { mode: 'pessimistic_write' },
            loadEagerRelations: false,
        });

        const sqlite = makeHarness({ driver: 'better-sqlite3' });
        await sqlite.repository.recordAtomic({ ...BASE_WRITE });
        expect(sqlite.userRepo.findOne).not.toHaveBeenCalled();
    });
});

describe('CreditLedgerRepository reads', () => {
    it('findLatestByRef selects the original purchase, not a later refund movement', async () => {
        const { repository, topLevelRepository } = makeHarness();

        await repository.findLatestByRef('billing-payment', 'pi_1');

        expect(topLevelRepository.findOne).toHaveBeenCalledWith({
            where: {
                refType: 'billing-payment',
                refId: 'pi_1',
                kind: CreditLedgerKind.PURCHASE,
            },
            order: { createdAt: 'DESC' },
        });
    });

    it('getBalance sums the signed movements (string aggregates coerced to number)', async () => {
        const { repository, manager } = makeHarness({ balance: '42' });
        // getBalance goes through the top-level manager, not a transaction.
        expect(await repository.getBalance('user-1')).toBe(42);
        expect(manager.transaction).not.toHaveBeenCalled();
    });

    it('findForUser applies kind + period filters and pagination', async () => {
        const { repository, topLevelRepository } = makeHarness();
        const from = new Date(Date.UTC(2026, 6, 1));
        const to = new Date(Date.UTC(2026, 7, 1));

        await repository.findForUser('user-1', {
            from,
            to,
            kinds: [CreditLedgerKind.PURCHASE, CreditLedgerKind.CONSUMPTION],
            skip: 25,
            take: 25,
        });

        expect(topLevelRepository.findAndCount).toHaveBeenCalledWith({
            where: expect.objectContaining({
                userId: 'user-1',
                kind: In([CreditLedgerKind.PURCHASE, CreditLedgerKind.CONSUMPTION]),
            }),
            order: { createdAt: 'DESC' },
            skip: 25,
            take: 25,
        });
    });

    // Wave 13 (Billing/Usage UI) — the stat-tile period rollup.
    it('getPeriodTotals returns consumed/added as coerced positive numbers, half-open window', async () => {
        const { repository, topLevelRepository } = makeHarness();
        const qb: any = {};
        qb.select = jest.fn().mockReturnValue(qb);
        qb.addSelect = jest.fn().mockReturnValue(qb);
        qb.where = jest.fn().mockReturnValue(qb);
        qb.andWhere = jest.fn().mockReturnValue(qb);
        qb.setParameter = jest.fn().mockReturnValue(qb);
        qb.getRawOne = jest
            .fn()
            .mockResolvedValue({ consumed: '260', added: '300', expired: '40' });
        topLevelRepository.createQueryBuilder = jest.fn().mockReturnValue(qb);

        const from = new Date(Date.UTC(2026, 6, 1));
        const to = new Date(Date.UTC(2026, 7, 1));
        const totals = await repository.getPeriodTotals('user-1', from, to);

        expect(totals).toEqual({ consumedCredits: 260, addedCredits: 300, expiredCredits: 40 });
        expect(qb.where).toHaveBeenCalledWith('e.userId = :userId', { userId: 'user-1' });
        expect(qb.andWhere).toHaveBeenCalledWith('e.createdAt >= :from', { from });
        expect(qb.andWhere).toHaveBeenCalledWith('e.createdAt < :to', { to });
    });

    it('getPeriodTotals degrades to zeros when the aggregate row is empty', async () => {
        const { repository, topLevelRepository } = makeHarness();
        const qb: any = {};
        qb.select = jest.fn().mockReturnValue(qb);
        qb.addSelect = jest.fn().mockReturnValue(qb);
        qb.where = jest.fn().mockReturnValue(qb);
        qb.andWhere = jest.fn().mockReturnValue(qb);
        qb.setParameter = jest.fn().mockReturnValue(qb);
        qb.getRawOne = jest.fn().mockResolvedValue(undefined);
        topLevelRepository.createQueryBuilder = jest.fn().mockReturnValue(qb);

        const totals = await repository.getPeriodTotals(
            'user-1',
            new Date(Date.UTC(2026, 6, 1)),
            new Date(Date.UTC(2026, 7, 1)),
        );

        expect(totals).toEqual({ consumedCredits: 0, addedCredits: 0, expiredCredits: 0 });
    });
});
