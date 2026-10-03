import { DataSource, Repository } from 'typeorm';
import {
    StripeRelayDeadLetter,
    StripeRelayDeadLetterResolution,
    StripeRelayDeadLetterStatus,
} from '../../../entities/stripe-relay-dead-letter.entity';
import {
    StripeRelayDeadLetterRepository,
    type StripeRelayDeadLetterFailure,
} from '../stripe-relay-dead-letter.repository';

/**
 * Dead letters for the shared Stripe webhook relay (audit CC05-06), against a
 * REAL better-sqlite3 schema carrying the REAL unique index: that index is what
 * keeps one event that Stripe retries sixteen times at ONE row with
 * `attempts = 16`, not sixteen rows an operator has to reconcile.
 *
 * Only this entity is registered: the table has no foreign keys by design (an
 * unknown Work is one of the failures it records).
 */
describe('StripeRelayDeadLetterRepository (better-sqlite3, real unique index)', () => {
    let dataSource: DataSource;
    let rows: Repository<StripeRelayDeadLetter>;
    let deadLetters: StripeRelayDeadLetterRepository;

    const T0 = new Date('2026-09-28T10:00:00.000Z');
    const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

    const failure = (
        overrides: Partial<StripeRelayDeadLetterFailure> = {},
    ): StripeRelayDeadLetterFailure => ({
        eventId: 'evt_1',
        eventType: 'invoice.payment_succeeded',
        workId: 'work-1',
        livemode: true,
        disposition: 'retry',
        reason: 'site_404',
        siteStatus: 404,
        payload: '{"id":"evt_1","object":"event"}',
        at: T0,
        ...overrides,
    });

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [StripeRelayDeadLetter],
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(StripeRelayDeadLetter);
        deadLetters = new StripeRelayDeadLetterRepository(rows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        jest.restoreAllMocks();
        await rows.clear();
    });

    it('records the first failure with the verbatim payload', async () => {
        const row = await deadLetters.recordFailure(failure());

        expect(row).toMatchObject({
            eventId: 'evt_1',
            eventType: 'invoice.payment_succeeded',
            workId: 'work-1',
            livemode: true,
            disposition: 'retry',
            reason: 'site_404',
            siteStatus: 404,
            attempts: 1,
            status: StripeRelayDeadLetterStatus.OPEN,
            payload: '{"id":"evt_1","object":"event"}',
        });
        expect(new Date(row.firstFailedAt).toISOString()).toBe(T0.toISOString());
    });

    it('keeps one row per event and counts every retry on it', async () => {
        await deadLetters.recordFailure(failure());
        await deadLetters.recordFailure(
            failure({ reason: 'site_502', siteStatus: 502, at: minutes(5) }),
        );
        const third = await deadLetters.recordFailure(
            failure({
                disposition: 'unroutable',
                reason: 'site_400',
                siteStatus: 400,
                at: minutes(9),
            }),
        );

        expect(await rows.count()).toBe(1);
        expect(third).toMatchObject({
            attempts: 3,
            disposition: 'unroutable',
            reason: 'site_400',
            siteStatus: 400,
        });
        // The first failure time is what the alert's grace period measures.
        expect(new Date(third.firstFailedAt).toISOString()).toBe(T0.toISOString());
        expect(new Date(third.lastFailedAt).toISOString()).toBe(minutes(9).toISOString());
    });

    it("counts a retry through the driver's own identifier quoting (MySQL backticks)", async () => {
        // MySQL (a supported driver) reads a hand-written "attempts" as a STRING
        // literal unless ANSI_QUOTES is on, which would pin the count at 1. The
        // increment must go through driver.escape; here it quotes the MySQL way
        // (backticks, which SQLite also accepts as identifier quotes).
        jest.spyOn(dataSource.driver, 'escape').mockImplementation(
            (name: string) => '`' + name + '`',
        );
        const update = jest.spyOn(rows, 'update');

        await deadLetters.recordFailure(failure());
        const second = await deadLetters.recordFailure(failure({ at: minutes(1) }));

        expect(second.attempts).toBe(2);
        // The SET expression itself, as the database receives it: TypeORM
        // escapes the column on the left anyway, so only the right-hand side
        // tells a driver-escaped increment from a hand-quoted one.
        const set = update.mock.calls.at(-1)?.[1] as { attempts?: () => string };
        expect(typeof set?.attempts).toBe('function');
        expect(set.attempts!()).toBe('`attempts` + 1');
    });

    it('converges on the winner when two pods record the same event at once', async () => {
        await deadLetters.recordFailure(failure());
        // The second pod's pre-read missed the row: its insert hits the UNIQUE
        // index and must fall back to counting the attempt on the winner.
        jest.spyOn(deadLetters, 'findByEventId').mockResolvedValueOnce(null);

        const row = await deadLetters.recordFailure(failure({ at: minutes(1) }));

        expect(await rows.count()).toBe(1);
        expect(row.attempts).toBe(2);
    });

    it('resolves an open row once, and reports a second resolve as a no-op', async () => {
        await deadLetters.recordFailure(failure());

        expect(
            await deadLetters.markResolved(
                'evt_1',
                StripeRelayDeadLetterResolution.STRIPE_RETRY,
                minutes(30),
            ),
        ).toBe(true);
        expect(
            await deadLetters.markResolved('evt_1', StripeRelayDeadLetterResolution.REPLAYED),
        ).toBe(false);
        expect(
            await deadLetters.markResolved('evt_unknown', StripeRelayDeadLetterResolution.REPLAYED),
        ).toBe(false);

        const row = await deadLetters.findByEventId('evt_1');
        expect(row).toMatchObject({
            status: StripeRelayDeadLetterStatus.RESOLVED,
            resolution: StripeRelayDeadLetterResolution.STRIPE_RETRY,
        });
    });

    it('never re-opens a resolved row when a stray duplicate fails later', async () => {
        await deadLetters.recordFailure(failure());
        await deadLetters.markResolved('evt_1', StripeRelayDeadLetterResolution.DISMISSED);

        const row = await deadLetters.recordFailure(
            failure({ reason: 'network', at: minutes(60) }),
        );

        expect(row).toMatchObject({
            status: StripeRelayDeadLetterStatus.RESOLVED,
            attempts: 1,
            reason: 'site_404',
        });
    });

    it('counts only OPEN rows, and only those older than the grace cut-off', async () => {
        await deadLetters.recordFailure(failure({ eventId: 'evt_old', at: T0 }));
        await deadLetters.recordFailure(failure({ eventId: 'evt_new', at: minutes(50) }));
        await deadLetters.recordFailure(failure({ eventId: 'evt_done', at: T0 }));
        await deadLetters.markResolved('evt_done', StripeRelayDeadLetterResolution.REPLAYED);

        expect(await deadLetters.countOpen()).toBe(2);
        // Cut-off at T0+30min: only the row that first failed before it counts.
        expect(await deadLetters.countOpen(minutes(30))).toBe(1);
        expect(await deadLetters.countOpen(minutes(-1))).toBe(0);
    });

    it('lists newest failure first and never returns the payload', async () => {
        await deadLetters.recordFailure(failure({ eventId: 'evt_a', at: T0 }));
        await deadLetters.recordFailure(failure({ eventId: 'evt_b', at: minutes(10) }));
        await deadLetters.markResolved('evt_a', StripeRelayDeadLetterResolution.REPLAYED);

        const [all, total] = await deadLetters.list({ limit: 10 });
        expect(total).toBe(2);
        expect(all.map((row) => row.eventId)).toEqual(['evt_b', 'evt_a']);
        for (const row of all) {
            expect(row).not.toHaveProperty('payload');
        }

        const [open, openTotal] = await deadLetters.list({
            status: StripeRelayDeadLetterStatus.OPEN,
            limit: 10,
        });
        expect(openTotal).toBe(1);
        expect(open.map((row) => row.eventId)).toEqual(['evt_b']);
    });
});
