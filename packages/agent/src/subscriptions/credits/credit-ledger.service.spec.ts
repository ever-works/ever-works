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
    return { service, ledgerRepository, entitlementsService, userRepository };
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
                expect.objectContaining({ maxBalanceAfter: 50 }),
            );
            expect(summary).toEqual({ granted: 1, skipped: 0, alreadyGranted: 0, scanned: 1 });
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
            expect(summary).toEqual({ granted: 0, skipped: 0, alreadyGranted: 1, scanned: 1 });
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

            expect(summary).toEqual({ granted: 0, skipped: 2, alreadyGranted: 0, scanned: 2 });
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

            expect(summary).toEqual({ granted: 1, skipped: 1, alreadyGranted: 0, scanned: 2 });
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
