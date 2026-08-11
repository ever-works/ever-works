import { DataSource, Repository } from 'typeorm';
import { CreditLedgerEntry } from '@src/entities/credit-ledger-entry.entity';
import { CreditLedgerRepository } from './credit-ledger.repository';

/**
 * Guard for the `getPeriodTotals` aggregate SQL.
 *
 * `GET /api/credits/usage-summary` returned 500 on every Postgres
 * environment — dev, stage and production — with:
 *
 *     QueryFailedError: column e.amountcredits does not exist
 *     HINT: Perhaps you meant to reference the column "e.amountCredits".
 *
 * The select fragment negated a debit as `-e.amountCredits`. TypeORM only
 * rewrites an `alias.property` reference into a quoted `"alias"."column"`
 * when it is preceded by a space, `=`, `(` or the start of the string —
 * its regex is literally ``([ =(]|^.{0})``. A unary minus is not in that
 * set, so exactly one of the four references in the statement survived
 * unquoted, Postgres folded it to lower case, and the query failed.
 *
 * Two things kept this invisible:
 *
 *  1. The unit spec beside this one mocks `createQueryBuilder` wholesale,
 *     so no SQL is ever generated and no assertion can reach the defect.
 *  2. The suite runs on better-sqlite3, which matches unquoted identifiers
 *     case-insensitively. `-e.amountCredits` executes perfectly happily
 *     there. The bug is only observable on the driver production uses.
 *
 * So executing the query is not enough: this spec asserts on the SQL text
 * itself, which is driver-independent, and additionally executes it to
 * pin the arithmetic. Reverting the fix to `-e.amountCredits` fails the
 * `emitted SQL` expectation below.
 */
describe('CreditLedgerRepository.getPeriodTotals — emitted SQL (integration)', () => {
    let dataSource: DataSource;
    let repository: CreditLedgerRepository;
    let entries: Repository<CreditLedgerEntry>;
    let queries: string[];

    const USER = '11111111-1111-4111-8111-111111111111';
    const OTHER_USER = '22222222-2222-4222-8222-222222222222';

    beforeAll(async () => {
        queries = [];

        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [CreditLedgerEntry],
            synchronize: true,
            logging: ['query'],
            logger: {
                logQuery: (query: string) => queries.push(query),
                logQueryError: () => undefined,
                logQuerySlow: () => undefined,
                logSchemaBuild: () => undefined,
                logMigration: () => undefined,
                log: () => undefined,
            },
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
        queries.length = 0;
    });

    const seed = (amountCredits: number, createdAt: Date, userId = USER) =>
        entries.save(
            entries.create({
                userId,
                kind: 'consumption',
                amountCredits,
                balanceAfter: 0,
                createdAt,
            } as Partial<CreditLedgerEntry>),
        );

    /**
     * The assertion that actually catches the production defect. After the
     * rewrite every reference must be quoted, so the bare `e.amountCredits`
     * substring cannot appear anywhere in the statement — a quoted one reads
     * `"e"."amountCredits"` and does not contain it.
     */
    it('quotes every amountCredits reference, including the negated one', async () => {
        await repository.getPeriodTotals(
            USER,
            new Date('2026-08-01T00:00:00.000Z'),
            new Date('2026-09-01T00:00:00.000Z'),
        );

        const sql = queries.find((q) => q.includes('credit_ledger_entries'));
        expect(sql).toBeDefined();

        // Control: the statement really does reference the column, so a
        // passing test cannot be one that simply matched nothing.
        expect(sql).toMatch(/amountCredits/);

        // The defect: an alias reference that TypeORM never rewrote.
        expect(sql).not.toContain('e.amountCredits');
        expect(sql).not.toMatch(/-\s*e\.amountCredits/);
    });

    it('returns debits as a positive consumed total and credits as added', async () => {
        const from = new Date('2026-08-01T00:00:00.000Z');
        const to = new Date('2026-09-01T00:00:00.000Z');

        await seed(-30, new Date('2026-08-05T12:00:00.000Z'));
        await seed(-12, new Date('2026-08-06T12:00:00.000Z'));
        await seed(100, new Date('2026-08-07T12:00:00.000Z'));

        const totals = await repository.getPeriodTotals(USER, from, to);

        expect(totals).toEqual({ consumedCredits: 42, addedCredits: 100 });
    });

    it('honours the half-open window and excludes other users', async () => {
        const from = new Date('2026-08-01T00:00:00.000Z');
        const to = new Date('2026-09-01T00:00:00.000Z');

        await seed(-5, new Date('2026-07-31T23:59:59.000Z')); // before `from`
        await seed(-7, to); // exactly `to` — excluded, window is [from, to)
        await seed(-9, new Date('2026-08-15T00:00:00.000Z'), OTHER_USER);
        await seed(-11, new Date('2026-08-15T00:00:00.000Z'));

        const totals = await repository.getPeriodTotals(USER, from, to);

        expect(totals).toEqual({ consumedCredits: 11, addedCredits: 0 });
    });

    it('returns zeros rather than NaN when the window holds no rows', async () => {
        const totals = await repository.getPeriodTotals(
            USER,
            new Date('2026-01-01T00:00:00.000Z'),
            new Date('2026-02-01T00:00:00.000Z'),
        );

        expect(totals).toEqual({ consumedCredits: 0, addedCredits: 0 });
    });
});
