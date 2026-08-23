import { DataSource, Repository } from 'typeorm';
import { CreditLedgerEntry, CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { CreditLedgerRepository } from './credit-ledger.repository';

/**
 * Bucket allocation + expiry (billing spec §3.2 FR-6..FR-8), executed
 * against a real (in-memory sqlite) ledger so the ORDER BY / IS NULL
 * semantics and the transaction choreography are exercised for real,
 * not mocked.
 *
 * The contract under test:
 *  - every positive row opens a bucket (`remainingCredits = amount`);
 *  - a debit is allocated soonest-expiring first, then non-expiring
 *    oldest-first, and never touches a lapsed bucket;
 *  - a write "expires on touch": due buckets are closed with an `expiry`
 *    row BEFORE the balance the guards read is summed;
 *  - `getBalance` is the AVAILABLE balance (lapsed-but-unswept credits
 *    are not spendable) and `expireDueBuckets` is idempotent.
 */
describe('CreditLedgerRepository — buckets + expiry (integration)', () => {
    let dataSource: DataSource;
    let repository: CreditLedgerRepository;
    let entries: Repository<CreditLedgerEntry>;

    const USER = '11111111-1111-4111-8111-111111111111';
    const T0 = new Date(Date.UTC(2026, 7, 1, 12, 0, 0));
    const DAY = 24 * 60 * 60 * 1000;
    const at = (days: number) => new Date(T0.getTime() + days * DAY);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [CreditLedgerEntry],
            synchronize: true,
        });
        await dataSource.initialize();
        entries = dataSource.getRepository(CreditLedgerEntry);
        repository = new CreditLedgerRepository(entries);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await entries.clear();
    });

    const credit = (
        amount: number,
        kind: CreditLedgerKind,
        options: { expiresAt?: Date | null; now?: Date; key?: string } = {},
    ) =>
        repository.recordAtomic(
            {
                userId: USER,
                kind,
                amountCredits: amount,
                expiresAt: options.expiresAt ?? null,
                idempotencyKey: options.key ?? null,
            },
            { now: options.now ?? T0 },
        );

    const debit = (amount: number, now: Date = T0) =>
        repository.recordAtomic(
            { userId: USER, kind: CreditLedgerKind.CONSUMPTION, amountCredits: -amount },
            { minBalanceAfter: 0, now },
        );

    const remainingOf = async (id: string) =>
        (await entries.findOneByOrFail({ id })).remainingCredits;

    it('opens a bucket for every positive row and none for a debit', async () => {
        const grant = await credit(300, CreditLedgerKind.GRANT, { expiresAt: at(30) });
        const purchase = await credit(1000, CreditLedgerKind.PURCHASE);
        const used = await debit(50);

        expect(grant.status).toBe('created');
        expect(purchase.status).toBe('created');
        expect(used.status).toBe('created');
        if (
            grant.status !== 'created' ||
            purchase.status !== 'created' ||
            used.status !== 'created'
        ) {
            throw new Error('unreachable');
        }
        expect(grant.entry.expiresAt?.getTime()).toBe(at(30).getTime());
        expect(await remainingOf(grant.entry.id)).toBe(250);
        expect(await remainingOf(purchase.entry.id)).toBe(1000);
        expect(used.entry.remainingCredits).toBeNull();
        expect(used.entry.expiresAt).toBeNull();
    });

    it('allocates soonest-expiring first, then non-expiring oldest-first', async () => {
        const perpetualOld = await credit(100, CreditLedgerKind.PURCHASE, { now: at(0) });
        const expiresLater = await credit(100, CreditLedgerKind.GRANT, {
            expiresAt: at(60),
            now: at(0),
        });
        const expiresSoon = await credit(100, CreditLedgerKind.GRANT, {
            expiresAt: at(30),
            now: at(0),
        });
        const perpetualNew = await credit(100, CreditLedgerKind.PURCHASE, { now: at(1) });
        if (
            perpetualOld.status !== 'created' ||
            expiresLater.status !== 'created' ||
            expiresSoon.status !== 'created' ||
            perpetualNew.status !== 'created'
        ) {
            throw new Error('setup');
        }

        // 250 = all of soon (100) + all of later (100) + 50 of the OLDEST perpetual.
        const result = await debit(250, at(2));
        expect(result.status).toBe('created');

        expect(await remainingOf(expiresSoon.entry.id)).toBe(0);
        expect(await remainingOf(expiresLater.entry.id)).toBe(0);
        expect(await remainingOf(perpetualOld.entry.id)).toBe(50);
        expect(await remainingOf(perpetualNew.entry.id)).toBe(100);
    });

    it('expires on touch: a lapsed bucket is closed with an expiry row before the debit is guarded', async () => {
        const lapsed = await credit(500, CreditLedgerKind.GRANT, { expiresAt: at(10), now: at(0) });
        const purchase = await credit(80, CreditLedgerKind.PURCHASE, { now: at(0) });
        if (lapsed.status !== 'created' || purchase.status !== 'created') throw new Error('setup');

        // Ledger SUM is 580, but 500 of it lapsed at day 10. A 100-credit
        // debit on day 11 must be refused: only 80 is spendable.
        const refused = await debit(100, at(11));
        expect(refused).toEqual({ status: 'insufficient', balance: 80 });

        // The refusal still closed the lapsed bucket (expire on touch).
        const expiryRows = await entries.findBy({ userId: USER, kind: CreditLedgerKind.EXPIRY });
        expect(expiryRows).toHaveLength(1);
        expect(expiryRows[0].amountCredits).toBe(-500);
        expect(expiryRows[0].refId).toBe(lapsed.entry.id);
        expect(expiryRows[0].idempotencyKey).toBe(`expiry:${lapsed.entry.id}`);
        expect(expiryRows[0].balanceAfter).toBe(80);
        expect(await remainingOf(lapsed.entry.id)).toBe(0);

        // And the spendable part still works.
        const ok = await debit(80, at(11));
        expect(ok.status).toBe('created');
        expect(await remainingOf(purchase.entry.id)).toBe(0);
    });

    it('getBalance reports the AVAILABLE balance before any sweep has run', async () => {
        await credit(300, CreditLedgerKind.GRANT, { expiresAt: at(5), now: at(0) });
        await credit(120, CreditLedgerKind.PURCHASE, { now: at(0) });

        expect(await repository.getBalance(USER, at(4))).toBe(420);
        // Day 6: the grant lapsed, nothing swept it yet — still not spendable.
        expect(await repository.getBalance(USER, at(6))).toBe(120);
        // The raw ledger SUM is unchanged until the sweep writes the row.
        const sum = await entries
            .createQueryBuilder('e')
            .select('COALESCE(SUM(e.amountCredits), 0)', 'sum')
            .where('e.userId = :u', { u: USER })
            .getRawOne<{ sum: number }>();
        expect(Number(sum?.sum)).toBe(420);
    });

    it('expireDueBuckets is idempotent and reports what it closed', async () => {
        const a = await credit(300, CreditLedgerKind.GRANT, { expiresAt: at(5), now: at(0) });
        const b = await credit(200, CreditLedgerKind.GRANT, { expiresAt: at(7), now: at(0) });
        await credit(50, CreditLedgerKind.PURCHASE, { now: at(0) });
        if (a.status !== 'created' || b.status !== 'created') throw new Error('setup');
        await debit(100, at(1)); // taken from `a` (soonest) → a=200 left

        const first = await repository.expireDueBuckets(USER, at(8));
        expect(first.map((x) => [x.entryId, x.expiredCredits])).toEqual([
            [a.entry.id, 200],
            [b.entry.id, 200],
        ]);
        expect(await repository.getBalance(USER, at(8))).toBe(50);

        const second = await repository.expireDueBuckets(USER, at(9));
        expect(second).toEqual([]);
        const expiryRows = await entries.findBy({ userId: USER, kind: CreditLedgerKind.EXPIRY });
        expect(expiryRows).toHaveLength(2);
        expect(await repository.getBalance(USER, at(9))).toBe(50);
    });

    it('findUsersWithDueBuckets lists exactly the users with a lapsed, non-empty bucket', async () => {
        const OTHER = '22222222-2222-4222-8222-222222222222';
        await credit(10, CreditLedgerKind.GRANT, { expiresAt: at(2), now: at(0) });
        await repository.recordAtomic(
            {
                userId: OTHER,
                kind: CreditLedgerKind.GRANT,
                amountCredits: 10,
                expiresAt: at(20),
            },
            { now: at(0) },
        );

        expect(await repository.findUsersWithDueBuckets(at(3))).toEqual([USER]);
        await repository.expireDueBuckets(USER, at(3));
        expect(await repository.findUsersWithDueBuckets(at(3))).toEqual([]);
    });

    it('the non-accumulating daily ceiling measures headroom against the available balance', async () => {
        // 40 lapsed credits + 10 live: the daily top-up to 50 must add 40, not 0.
        await credit(40, CreditLedgerKind.GRANT, { expiresAt: at(1), now: at(0) });
        await credit(10, CreditLedgerKind.DAILY_FREE, { now: at(0) });

        const topUp = await repository.recordAtomic(
            {
                userId: USER,
                kind: CreditLedgerKind.DAILY_FREE,
                amountCredits: 50,
                idempotencyKey: `daily:${USER}:2026-08-03`,
            },
            { maxBalanceAfter: 50, now: at(2) },
        );
        expect(topUp.status).toBe('created');
        if (topUp.status !== 'created') throw new Error('unreachable');
        expect(topUp.entry.amountCredits).toBe(40);
        expect(topUp.entry.balanceAfter).toBe(50);
        expect(await repository.getBalance(USER, at(2))).toBe(50);
    });
});
