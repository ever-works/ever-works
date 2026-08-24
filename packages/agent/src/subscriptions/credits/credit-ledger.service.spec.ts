import { Logger } from '@nestjs/common';
import { CreditLedgerService, InsufficientCreditsError } from './credit-ledger.service';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';

/**
 * CreditLedgerService is the business layer over the atomic repository
 * write path: it validates movements, applies the overdraft posture
 * (env-configurable), converts metered costCents into credit debits
 * (`consumeForRun`) and runs the non-accumulating daily free-grant
 * sweep. No real DB/Nest container — collaborators are jest.fn()
 * shells, env knobs flipped via `process.env` (usage-ledger house
 * pattern).
 */

function makeLedgerRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        recordAtomic: jest.fn().mockImplementation(async (write: any) => ({
            status: 'created',
            entry: { id: 'entry-1', ...write, balanceAfter: write.amountCredits },
        })),
        getBalance: jest.fn().mockResolvedValue(0),
        findForUser: jest.fn().mockResolvedValue({ entries: [], total: 0 }),
        findByIdempotencyKey: jest.fn().mockResolvedValue(null),
        sumByRefTypeInWindow: jest.fn().mockResolvedValue(0),
        expireDueBuckets: jest.fn().mockResolvedValue([]),
        findUsersWithDueBuckets: jest.fn().mockResolvedValue([]),
        ...overrides,
    };
}

function makeEntitlements(overrides: Record<string, jest.Mock> = {}) {
    return {
        get: jest.fn(),
        getNumber: jest.fn().mockResolvedValue(50),
        clearCache: jest.fn(),
        ...overrides,
    };
}

function makeUserRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        findActiveBatch: jest.fn().mockResolvedValue([]),
        ...overrides,
    };
}

function makeService(
    ledger: Record<string, jest.Mock> = {},
    entitlements: Record<string, jest.Mock> = {},
    users: Record<string, jest.Mock> = {},
) {
    const ledgerRepository = makeLedgerRepository(ledger);
    const entitlementsService = makeEntitlements(entitlements);
    const userRepository = makeUserRepository(users);
    const service = new CreditLedgerService(
        ledgerRepository as any,
        entitlementsService as any,
        userRepository as any,
    );
    return {
        service,
        ledgerRepository,
        entitlementsService,
        userRepository,
    };
}

describe('CreditLedgerService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.CREDITS_PER_DOLLAR;
        delete process.env.CREDITS_MARGIN_PERCENT;
        delete process.env.CREDITS_ALLOW_OVERDRAFT;
        delete process.env.CREDITS_DAILY_FREE;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('record — validation + guards', () => {
        it('rejects zero and non-integer amounts before touching the repository', async () => {
            const { service, ledgerRepository } = makeService();

            await expect(
                service.record({ userId: 'u1', kind: CreditLedgerKind.GRANT, amountCredits: 0 }),
            ).rejects.toThrow('non-zero');
            await expect(
                service.record({ userId: 'u1', kind: CreditLedgerKind.GRANT, amountCredits: 1.5 }),
            ).rejects.toThrow('integer');
            expect(ledgerRepository.recordAtomic).not.toHaveBeenCalled();
        });

        it('applies the zero floor to debits by default (overdraft off)', async () => {
            const { service, ledgerRepository } = makeService();

            await service.record({
                userId: 'u1',
                kind: CreditLedgerKind.CONSUMPTION,
                amountCredits: -10,
            });

            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({ amountCredits: -10 }),
                expect.objectContaining({ minBalanceAfter: 0 }),
            );
        });

        it('drops the floor when CREDITS_ALLOW_OVERDRAFT=true (configurable overdraft)', async () => {
            process.env.CREDITS_ALLOW_OVERDRAFT = 'true';
            const { service, ledgerRepository } = makeService();

            await service.record({
                userId: 'u1',
                kind: CreditLedgerKind.CONSUMPTION,
                amountCredits: -10,
            });

            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ minBalanceAfter: null }),
            );
        });

        it('maps an insufficient result to InsufficientCreditsError (stable name → mapped 4xx)', async () => {
            const { service } = makeService({
                recordAtomic: jest.fn().mockResolvedValue({ status: 'insufficient', balance: 3 }),
            });

            const attempt = service.record({
                userId: 'u1',
                kind: CreditLedgerKind.CONSUMPTION,
                amountCredits: -10,
            });

            await expect(attempt).rejects.toThrow(InsufficientCreditsError);
            await expect(attempt).rejects.toMatchObject({
                name: 'InsufficientCreditsError',
                balanceCredits: 3,
                requestedCredits: 10,
            });
        });

        it('returns the existing entry for an idempotent replay (no duplicate write)', async () => {
            const existing = { id: 'existing-entry' };
            const { service } = makeService({
                recordAtomic: jest
                    .fn()
                    .mockResolvedValue({ status: 'idempotent', entry: existing }),
            });

            const entry = await service.record({
                userId: 'u1',
                kind: CreditLedgerKind.PURCHASE,
                amountCredits: 100,
                idempotencyKey: 'purchase:abc',
            });

            expect(entry).toBe(existing);
        });
    });

    describe('consumeForRun — the costCents → credits bridge', () => {
        it('converts costCents at the default rate (100 credits/$ → 1 credit = 1 cent)', async () => {
            const { service, ledgerRepository } = makeService();

            await service.consumeForRun({ userId: 'u1', runId: 'run-1', costCents: 250 });

            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: CreditLedgerKind.CONSUMPTION,
                    amountCredits: -250,
                    costCentsRef: 250,
                    refType: 'agent-run',
                    refId: 'run-1',
                    idempotencyKey: 'run:run-1',
                }),
                expect.anything(),
            );
        });

        it('honours CREDITS_PER_DOLLAR + CREDITS_MARGIN_PERCENT (rounded up, never zero)', async () => {
            process.env.CREDITS_PER_DOLLAR = '200'; // 2 credits per cent
            process.env.CREDITS_MARGIN_PERCENT = '20';
            const { service, ledgerRepository } = makeService();

            await service.consumeForRun({ userId: 'u1', runId: 'run-2', costCents: 101 });

            // 101 cents × 2 × 1.2 = 242.4 → ceil → 243 credits.
            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({ amountCredits: -243 }),
                expect.anything(),
            );
        });

        it('debits nothing for zero-cost runs (streaming/embed metering gap stays honest)', async () => {
            const { service, ledgerRepository } = makeService();

            const entry = await service.consumeForRun({
                userId: 'u1',
                runId: 'run-3',
                costCents: 0,
            });

            expect(entry).toBeNull();
            expect(ledgerRepository.recordAtomic).not.toHaveBeenCalled();
        });

        it('prefers an explicit credits override over the computed conversion', async () => {
            const { service, ledgerRepository } = makeService();

            await service.consumeForRun({
                userId: 'u1',
                runId: 'run-4',
                costCents: 999,
                credits: 5,
            });

            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({ amountCredits: -5, costCentsRef: 999 }),
                expect.anything(),
            );
        });

        it('propagates the TYPED InsufficientCreditsError (not a bare Error)', async () => {
            // `consumeForRun` is the second of the two spend entrypoints
            // (the other is `record` with a negative amount — covered
            // above). Both MUST reject with the stable-named class: the
            // api-side InsufficientCreditsExceptionFilter keys its 402 off
            // `.name`, and RunCostSettlementService keys its
            // partial-debit + exhaustion-notification policy off the type.
            // A bare Error here would silently become an unmapped 500 and
            // a swallowed settlement.
            const { service } = makeService({
                recordAtomic: jest.fn().mockResolvedValue({ status: 'insufficient', balance: 4 }),
            });

            const attempt = service.consumeForRun({
                userId: 'u1',
                runId: 'run-5',
                costCents: 900,
            });

            await expect(attempt).rejects.toThrow(InsufficientCreditsError);
            await expect(attempt).rejects.toMatchObject({
                name: 'InsufficientCreditsError',
                userId: 'u1',
                requestedCredits: 900,
                balanceCredits: 4,
            });
        });
    });

    describe('getLedger — period/kind filters + pagination', () => {
        it('translates a YYYY-MM period into the UTC month window', async () => {
            const { service, ledgerRepository } = makeService();

            await service.getLedger('u1', { period: '2026-07' });

            expect(ledgerRepository.findForUser).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({
                    from: new Date(Date.UTC(2026, 6, 1)),
                    to: new Date(Date.UTC(2026, 7, 1)),
                    skip: 0,
                    take: 25,
                }),
            );
        });

        it('rejects a malformed period and clamps pageSize to the maximum', async () => {
            const { service, ledgerRepository } = makeService();

            await expect(service.getLedger('u1', { period: '2026-13' })).rejects.toThrow(
                'Invalid period',
            );

            await service.getLedger('u1', { page: 3, pageSize: 9999 });
            expect(ledgerRepository.findForUser).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({ skip: 200, take: 100 }),
            );
        });

        it('passes kind filters through to the repository', async () => {
            const { service, ledgerRepository } = makeService();

            await service.getLedger('u1', {
                kinds: [CreditLedgerKind.PURCHASE, CreditLedgerKind.DAILY_FREE],
            });

            expect(ledgerRepository.findForUser).toHaveBeenCalledWith(
                'u1',
                expect.objectContaining({
                    kinds: [CreditLedgerKind.PURCHASE, CreditLedgerKind.DAILY_FREE],
                }),
            );
        });
    });

    describe('dispatchDailyGrants — idempotent daily sweep', () => {
        const NOW = new Date('2026-07-25T00:05:00.000Z');

        it('grants up to the entitlement level with the daily idempotency key', async () => {
            const users = [{ id: 'u1', defaultPlan: { code: 'free' } }];
            const { service, ledgerRepository, entitlementsService } = makeService(
                {},
                { getNumber: jest.fn().mockResolvedValue(50) },
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            expect(entitlementsService.getNumber).toHaveBeenCalledWith(
                'free',
                'daily-free-credits',
                expect.any(Number),
            );
            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    kind: CreditLedgerKind.DAILY_FREE,
                    amountCredits: 50,
                    idempotencyKey: 'daily:u1:2026-07-25',
                }),
                // Was `{ maxBalanceAfter: 50 }` — the top-up-to-N ceiling. It is
                // gone on purpose: the ceiling clamps against the WHOLE balance,
                // so it silently denied the advertised daily credits to every
                // paid tier AND to any free user who had bought a credit pack.
                // The UNIQUE daily key is what limits this to one grant a day.
                expect.objectContaining({ maxBalanceAfter: null }),
            );
            expect(summary).toEqual({
                granted: 1,
                skipped: 0,
                alreadyGranted: 0,
                scanned: 1,
                failed: 0,
            });
        });

        it('is a no-op on re-run: an existing daily key counts as alreadyGranted', async () => {
            const users = [{ id: 'u1', defaultPlan: { code: 'free' } }];
            const { service, ledgerRepository } = makeService(
                { findByIdempotencyKey: jest.fn().mockResolvedValue({ id: 'prior-grant' }) },
                {},
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            expect(ledgerRepository.recordAtomic).not.toHaveBeenCalled();
            expect(summary).toEqual({
                granted: 0,
                skipped: 0,
                alreadyGranted: 1,
                scanned: 1,
                failed: 0,
            });
        });

        it('skips users whose plan has no daily-free entitlement and counts ceiling clamps as skipped', async () => {
            const users = [
                { id: 'paid-user', defaultPlan: { code: 'premium' } },
                { id: 'rich-user', defaultPlan: { code: 'free' } },
            ];
            const { service } = makeService(
                {
                    // rich-user is already at the level → repository skips.
                    recordAtomic: jest.fn().mockResolvedValue({ status: 'skipped', balance: 80 }),
                },
                {
                    getNumber: jest
                        .fn()
                        .mockImplementation(async (planCode: string) =>
                            planCode === 'free' ? 50 : 0,
                        ),
                },
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            expect(summary).toEqual({
                granted: 0,
                skipped: 2,
                alreadyGranted: 0,
                scanned: 2,
                failed: 0,
            });
        });

        it('keeps sweeping when one user fails (best-effort per user)', async () => {
            const users = [
                { id: 'boom-user', defaultPlan: { code: 'free' } },
                { id: 'ok-user', defaultPlan: { code: 'free' } },
            ];
            const { service } = makeService(
                {
                    recordAtomic: jest
                        .fn()
                        .mockRejectedValueOnce(new Error('db hiccup'))
                        .mockResolvedValue({ status: 'created', entry: { id: 'e2' } }),
                },
                {},
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            expect(summary).toEqual({
                granted: 1,
                skipped: 1,
                alreadyGranted: 0,
                scanned: 2,
                // A thrown grant is now visible instead of being indistinguishable
                // from a healthy no-op: `failed` is a subset of `skipped`.
                failed: 1,
            });
        });

        /**
         * H3 (a) — the advertised daily allowance is universal.
         *
         * The sweep used to pass `planCode === 'free' ? fallback : 0` as the
         * entitlement fallback, so ANY plan without an explicit
         * `daily-free-credits` row resolved to zero and received nothing,
         * while the pricing page promised 50/day on every tier.
         *
         * This asserts the OUTCOME (a paid user with no row is granted), not
         * the argument passed to a mock: `getNumber` here behaves like the real
         * service when no row exists, i.e. it returns the fallback it is given.
         */
        it('grants the daily allowance on a PAID plan that has no entitlement row', async () => {
            const users = [{ id: 'pro-user', defaultPlan: { code: 'standard' } }];
            const { service, ledgerRepository } = makeService(
                {},
                {
                    // "no row" — the real EntitlementsService returns the fallback.
                    getNumber: jest
                        .fn()
                        .mockImplementation(async (_plan: string, _key: string, fb: number) => fb),
                },
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            expect(summary.granted).toBe(1);
            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'pro-user',
                    kind: CreditLedgerKind.DAILY_FREE,
                    amountCredits: 50,
                }),
                expect.anything(),
            );
        });

        /**
         * H3 (c) — THE hidden blocker, and the correction the attack found.
         *
         * `maxBalanceAfter` makes the daily grant a top-up-to-N, which is right
         * for a free user and catastrophic for a paid one: a Pro balance of
         * 3,000 monthly credits leaves negative headroom against a level of 50,
         * so the repository clamps to nothing and writes no row. Every test
         * passes and the paid tiers silently receive ZERO daily credits.
         *
         * Revert-check: change the ceiling back to an unconditional `level` and
         * this test must go RED (the repository stub reports `skipped`, so
         * `granted` drops to 0). If it stays green it is asserting nothing.
         */
        it('passes NO balance ceiling, so daily credits are always additive', async () => {
            const users = [
                { id: 'pro-user', defaultPlan: { code: 'standard', monthlyCredits: 3000 } },
            ];
            const { service, ledgerRepository } = makeService(
                {},
                {},
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            expect(summary.granted).toBe(1);
            const [, options] = ledgerRepository.recordAtomic.mock.calls[0];
            expect(options).not.toHaveProperty('maxBalanceAfter', expect.any(Number));
            expect(options.maxBalanceAfter ?? null).toBeNull();
        });

        /**
         * The case that killed the first attempt at a conditional ceiling.
         *
         * `maxBalanceAfter` clamps against the WHOLE balance, and `sumBalance`
         * sums every kind — purchases included. So any ceiling denies the
         * advertised daily credits to a free user who bought a credit pack:
         * 25,000 purchased credits against a level of 50 is negative headroom,
         * the repository writes nothing, and the sweep logs `skipped` exactly
         * as it does for a healthy user. ~500 days of silence, for the one
         * free-tier user who actually paid.
         *
         * Revert-check: reinstate `maxBalanceAfter: level` and this goes RED.
         */
        it('still grants a FREE user who has bought a large credit pack', async () => {
            const users = [{ id: 'free-buyer', defaultPlan: { code: 'free', monthlyCredits: 0 } }];
            const { service, ledgerRepository } = makeService(
                {
                    // Faithful to the repository: a ceiling below the current
                    // balance clamps the grant to nothing and writes NO row.
                    recordAtomic: jest.fn().mockImplementation(async (write: any, opts: any) => {
                        const balance = 25000; // bought the $200 pack
                        const ceiling = opts?.maxBalanceAfter;
                        if (
                            typeof ceiling === 'number' &&
                            balance + write.amountCredits > ceiling
                        ) {
                            return { status: 'skipped', balance };
                        }
                        return {
                            status: 'created',
                            entry: {
                                id: 'e1',
                                ...write,
                                balanceAfter: balance + write.amountCredits,
                            },
                        };
                    }),
                },
                {},
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            expect(summary.granted).toBe(1);
            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({ kind: CreditLedgerKind.DAILY_FREE, amountCredits: 50 }),
                expect.anything(),
            );
        });
    });

    describe('dispatchDailyGrants — universal allowance (billing spec FR-1)', () => {
        const NOW = new Date('2026-08-25T00:05:00.000Z');

        it('applies the platform fallback to EVERY plan code, not just free', async () => {
            const users = [
                { id: 'free-user', defaultPlan: { code: 'free' } },
                { id: 'pro-user', defaultPlan: { code: 'standard' } },
                { id: 'ent-user', defaultPlan: { code: 'premium' } },
            ];
            const { service, ledgerRepository, entitlementsService } = makeService(
                {},
                {
                    // No entitlement rows: every plan resolves the caller's fallback.
                    getNumber: jest
                        .fn()
                        .mockImplementation(async (_plan: string, _key: string, fb: number) => fb),
                },
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            const summary = await service.dispatchDailyGrants(NOW);

            for (const code of ['free', 'standard', 'premium']) {
                expect(entitlementsService.getNumber).toHaveBeenCalledWith(
                    code,
                    'daily-free-credits',
                    50,
                );
            }
            expect(ledgerRepository.recordAtomic).toHaveBeenCalledTimes(3);
            expect(summary).toEqual({
                granted: 3,
                skipped: 0,
                alreadyGranted: 0,
                scanned: 3,
                failed: 0,
            });
        });

        it('honours CREDITS_DAILY_FREE as the universal fallback level', async () => {
            process.env.CREDITS_DAILY_FREE = '75';
            const users = [{ id: 'pro-user', defaultPlan: { code: 'standard' } }];
            const { service, ledgerRepository } = makeService(
                {},
                {
                    getNumber: jest
                        .fn()
                        .mockImplementation(async (_plan: string, _key: string, fb: number) => fb),
                },
                { findActiveBatch: jest.fn().mockResolvedValueOnce(users).mockResolvedValue([]) },
            );

            await service.dispatchDailyGrants(NOW);

            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({ amountCredits: 75 }),
                expect.objectContaining({ maxBalanceAfter: null }),
            );
        });
    });

    describe('grantDailyForUser — lazy per-user grant (billing spec FR-3)', () => {
        const NOW = new Date('2026-08-25T13:00:00.000Z');

        it('writes the same daily key the sweep would, so the two can never double-grant', async () => {
            const { service, ledgerRepository } = makeService();

            expect(await service.grantDailyForUser('u1', 'standard', NOW)).toBe('granted');
            expect(ledgerRepository.recordAtomic).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'u1',
                    kind: CreditLedgerKind.DAILY_FREE,
                    amountCredits: 50,
                    idempotencyKey: 'daily:u1:2026-08-25',
                }),
                expect.objectContaining({ maxBalanceAfter: null }),
            );
        });

        it("reports already-granted when today's key exists and skipped when the ceiling clamps", async () => {
            const already = makeService({
                findByIdempotencyKey: jest.fn().mockResolvedValue({ id: 'prior' }),
            });
            expect(await already.service.grantDailyForUser('u1', 'free', NOW)).toBe(
                'already-granted',
            );
            expect(already.ledgerRepository.recordAtomic).not.toHaveBeenCalled();

            const clamped = makeService({
                recordAtomic: jest.fn().mockResolvedValue({ status: 'skipped', balance: 900 }),
            });
            expect(await clamped.service.grantDailyForUser('u1', 'free', NOW)).toBe('skipped');
        });
    });

    describe('expireDueCredits — expiry sweep (billing spec FR-7)', () => {
        const NOW = new Date('2026-09-23T00:05:00.000Z');

        it("closes one user's due buckets and tallies them", async () => {
            const { service, ledgerRepository } = makeService({
                expireDueBuckets: jest.fn().mockResolvedValue([
                    { entryId: 'a', expiredCredits: 300, expiryEntry: {} },
                    { entryId: 'b', expiredCredits: 200, expiryEntry: {} },
                ]),
            });

            const summary = await service.expireDueCredits('u1', NOW);

            expect(ledgerRepository.expireDueBuckets).toHaveBeenCalledWith('u1', NOW);
            expect(ledgerRepository.findUsersWithDueBuckets).not.toHaveBeenCalled();
            expect(summary).toEqual({ users: 1, buckets: 2, credits: 500 });
        });

        it('without a user, walks every user with a due bucket until the work list is empty', async () => {
            const { service, ledgerRepository } = makeService({
                findUsersWithDueBuckets: jest
                    .fn()
                    .mockResolvedValueOnce(['u1', 'u2'])
                    .mockResolvedValue([]),
                expireDueBuckets: jest
                    .fn()
                    .mockResolvedValueOnce([{ entryId: 'a', expiredCredits: 10, expiryEntry: {} }])
                    .mockResolvedValueOnce([]),
            });

            const summary = await service.expireDueCredits(undefined, NOW);

            expect(ledgerRepository.expireDueBuckets).toHaveBeenCalledWith('u1', NOW);
            expect(ledgerRepository.expireDueBuckets).toHaveBeenCalledWith('u2', NOW);
            // u2 had nothing left by the time it was visited → not counted as a user.
            expect(summary).toEqual({ users: 1, buckets: 1, credits: 10 });
        });

        it('record forwards expiresAt for a positive write only', async () => {
            const { service, ledgerRepository } = makeService();
            const expiresAt = new Date('2026-10-23T00:00:00.000Z');

            await service.record({
                userId: 'u1',
                kind: CreditLedgerKind.GRANT,
                amountCredits: 3000,
                expiresAt,
            });
            await service.record({
                userId: 'u1',
                kind: CreditLedgerKind.CONSUMPTION,
                amountCredits: -5,
                expiresAt,
                allowNegativeBalance: true,
            });

            expect(ledgerRepository.recordAtomic.mock.calls[0][0]).toEqual(
                expect.objectContaining({ expiresAt }),
            );
            expect(ledgerRepository.recordAtomic.mock.calls[1][0].expiresAt).toBeUndefined();
        });
    });

    describe('getBalance', () => {
        it('delegates to the repository SUM (authoritative balance)', async () => {
            const { service, ledgerRepository } = makeService({
                getBalance: jest.fn().mockResolvedValue(1234),
            });

            expect(await service.getBalance('u1')).toBe(1234);
            expect(ledgerRepository.getBalance).toHaveBeenCalledWith('u1');
        });
    });
});
