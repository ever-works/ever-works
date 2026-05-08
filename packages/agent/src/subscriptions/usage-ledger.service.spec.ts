import { UsageLedgerService } from './usage-ledger.service';
import { UsageLedgerTriggerType } from '@src/entities/usage-ledger-entry.entity';
import { WorkScheduleBillingMode, WorkScheduleCadence } from '@ever-works/contracts/api';

/**
 * UsageLedgerService is the agent-side write path for pay-per-use overage
 * charges. It is gated by BOTH `config.subscriptions.isEnabled` AND the
 * caller's billing-mode flag — the kill-switch wins. On a green-light path
 * it persists a single ledger row and forwards the entry to a (possibly
 * no-op) `BillingProvider.recordUsageCharge` hook. The amount per row is
 * sourced from `config.subscriptions.getPayPerUsePriceCents`.
 *
 * No real DB / Nest container is booted — both collaborators are pure
 * `jest.fn()` shells, env knobs are flipped via `process.env`.
 */

function makeLedgerRepository(overrides: Record<string, jest.Mock> = {}) {
    return {
        record: jest.fn(),
        ...overrides,
    };
}

function makeBillingProvider(overrides: Record<string, jest.Mock> = {}) {
    return {
        getDefaultCurrency: jest.fn().mockReturnValue('usd'),
        recordUsageCharge: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeService(
    ledger: Record<string, jest.Mock> = {},
    billing: Record<string, jest.Mock> = {},
) {
    const ledgerRepository = makeLedgerRepository(ledger);
    const billingProvider = makeBillingProvider(billing);
    const service = new UsageLedgerService(ledgerRepository as any, billingProvider as any);
    return { service, ledgerRepository, billingProvider };
}

describe('UsageLedgerService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = {
            ...originalEnv,
            // Default: subscriptions enabled (so the gate passes), no overage
            // price override (defaults to 500 cents = $5.00).
            SUBSCRIPTIONS_ENABLED: 'true',
        };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('recordUsage — gating (kill-switch + billing-mode)', () => {
        it('returns null when subscriptions are disabled (kill-switch wins)', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service, ledgerRepository, billingProvider } = makeService();

            const result = await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
            });

            expect(result).toBeNull();
            expect(ledgerRepository.record).not.toHaveBeenCalled();
            expect(billingProvider.recordUsageCharge).not.toHaveBeenCalled();
        });

        it('returns null when billingMode !== USAGE (caller is on a subscription plan)', async () => {
            const { service, ledgerRepository } = makeService();

            const result = await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.MANUAL,
                billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            });

            expect(result).toBeNull();
            expect(ledgerRepository.record).not.toHaveBeenCalled();
        });

        it('returns null when BOTH kill-switch is off AND billingMode is non-USAGE', async () => {
            process.env.SUBSCRIPTIONS_ENABLED = 'false';
            const { service, ledgerRepository } = makeService();
            const result = await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            });
            expect(result).toBeNull();
            expect(ledgerRepository.record).not.toHaveBeenCalled();
        });

        it('proceeds when subscriptions are enabled AND billingMode === USAGE', async () => {
            const entry = { id: 'led-1', amountCents: 500 };
            const { service, ledgerRepository, billingProvider } = makeService({
                record: jest.fn().mockResolvedValue(entry),
            });

            const result = await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
            });

            expect(result).toBe(entry);
            expect(ledgerRepository.record).toHaveBeenCalledTimes(1);
            expect(billingProvider.recordUsageCharge).toHaveBeenCalledWith(entry);
        });
    });

    describe('recordUsage — happy-path persistence shape', () => {
        it('persists the documented row shape (1 unit, configured price, currency from billing provider)', async () => {
            process.env.PAY_PER_USE_PRICE_USD = '0.50'; // → 50 cents
            const entry = { id: 'led-2' };
            const { service, ledgerRepository, billingProvider } = makeService(
                { record: jest.fn().mockResolvedValue(entry) },
                { getDefaultCurrency: jest.fn().mockReturnValue('eur') },
            );

            const schedule = {
                id: 'sched-1',
                cadence: WorkScheduleCadence.DAILY,
            };
            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                schedule: schedule as any,
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
                generationHistoryId: 'h1',
            });

            expect(ledgerRepository.record).toHaveBeenCalledWith({
                userId: 'u1',
                workId: 'w1',
                scheduleId: 'sched-1',
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
                units: 1,
                amountCents: 50,
                currency: 'eur',
                generationHistoryId: 'h1',
                metadata: { cadence: WorkScheduleCadence.DAILY },
            });
            expect(billingProvider.getDefaultCurrency).toHaveBeenCalled();
        });

        it('uses the default 500-cent overage price when PAY_PER_USE_PRICE_USD is unset', async () => {
            delete process.env.PAY_PER_USE_PRICE_USD;
            const { service, ledgerRepository } = makeService({
                record: jest.fn().mockResolvedValue({ id: 'led' }),
            });

            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
            });

            expect(ledgerRepository.record).toHaveBeenCalledWith(
                expect.objectContaining({ amountCents: 500 }),
            );
        });

        it('omits scheduleId AND metadata.cadence when no schedule is provided', async () => {
            const { service, ledgerRepository } = makeService({
                record: jest.fn().mockResolvedValue({ id: 'led' }),
            });

            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.MANUAL,
                billingMode: WorkScheduleBillingMode.USAGE,
            });

            const args = (ledgerRepository.record as jest.Mock).mock.calls[0][0];
            expect(args.scheduleId).toBeUndefined();
            expect(args.metadata).toEqual({ cadence: undefined });
        });

        it('omits scheduleId when schedule is null (defensive null-cadence)', async () => {
            const { service, ledgerRepository } = makeService({
                record: jest.fn().mockResolvedValue({ id: 'led' }),
            });

            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                schedule: null,
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
            });

            const args = (ledgerRepository.record as jest.Mock).mock.calls[0][0];
            expect(args.scheduleId).toBeUndefined();
            expect(args.metadata.cadence).toBeUndefined();
        });

        it('omits generationHistoryId when not provided (undefined survives the spread)', async () => {
            const { service, ledgerRepository } = makeService({
                record: jest.fn().mockResolvedValue({ id: 'led' }),
            });
            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.MANUAL,
                billingMode: WorkScheduleBillingMode.USAGE,
            });
            const args = (ledgerRepository.record as jest.Mock).mock.calls[0][0];
            expect(args.generationHistoryId).toBeUndefined();
        });

        it('forwards the trigger type verbatim (MANUAL vs SCHEDULED)', async () => {
            const { service, ledgerRepository } = makeService({
                record: jest.fn().mockResolvedValue({ id: 'led' }),
            });

            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.MANUAL,
                billingMode: WorkScheduleBillingMode.USAGE,
            });
            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
            });

            expect((ledgerRepository.record as jest.Mock).mock.calls[0][0].triggerType).toBe(
                UsageLedgerTriggerType.MANUAL,
            );
            expect((ledgerRepository.record as jest.Mock).mock.calls[1][0].triggerType).toBe(
                UsageLedgerTriggerType.SCHEDULED,
            );
        });
    });

    describe('recordUsage — billing provider hook', () => {
        it('calls billingProvider.recordUsageCharge AFTER the ledger row is persisted', async () => {
            const order: string[] = [];
            const entry = { id: 'led-3' };
            const ledgerRepository = makeLedgerRepository({
                record: jest.fn(async () => {
                    order.push('record');
                    return entry;
                }),
            });
            const billingProvider = makeBillingProvider({
                recordUsageCharge: jest.fn(async () => {
                    order.push('charge');
                }),
            });
            const service = new UsageLedgerService(ledgerRepository as any, billingProvider as any);

            await service.recordUsage({
                userId: 'u1',
                workId: 'w1',
                triggerType: UsageLedgerTriggerType.SCHEDULED,
                billingMode: WorkScheduleBillingMode.USAGE,
            });

            expect(order).toEqual(['record', 'charge']);
            expect(billingProvider.recordUsageCharge).toHaveBeenCalledWith(entry);
        });

        it('propagates a billingProvider.recordUsageCharge rejection to the caller', async () => {
            const { service } = makeService(
                { record: jest.fn().mockResolvedValue({ id: 'led-4' }) },
                {
                    recordUsageCharge: jest.fn().mockRejectedValue(new Error('stripe down')),
                },
            );

            await expect(
                service.recordUsage({
                    userId: 'u1',
                    workId: 'w1',
                    triggerType: UsageLedgerTriggerType.SCHEDULED,
                    billingMode: WorkScheduleBillingMode.USAGE,
                }),
            ).rejects.toThrow('stripe down');
        });

        it('propagates a ledgerRepository.record rejection (and skips the billing call entirely)', async () => {
            const { service, billingProvider } = makeService({
                record: jest.fn().mockRejectedValue(new Error('db down')),
            });
            await expect(
                service.recordUsage({
                    userId: 'u1',
                    workId: 'w1',
                    triggerType: UsageLedgerTriggerType.MANUAL,
                    billingMode: WorkScheduleBillingMode.USAGE,
                }),
            ).rejects.toThrow('db down');
            expect(billingProvider.recordUsageCharge).not.toHaveBeenCalled();
        });
    });
});
