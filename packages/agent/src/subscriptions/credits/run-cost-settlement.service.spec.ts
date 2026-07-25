import { RunCostSettlementService } from './run-cost-settlement.service';
import { InsufficientCreditsError } from './credit-ledger.service';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';

/**
 * Pricing Wave 9 M2 — the metering → credits bridge fired by
 * `AgentRunRepository` on run terminal transitions.
 *
 * Contract under test:
 *  - accumulation sums ONLY this run's tagged usage events and stamps
 *    `agent_runs.costCents` with the FULL metered total;
 *  - the debit goes through `CreditLedgerService.consumeForRun`
 *    (idempotency key `run:{runId}` — re-running a terminal write can
 *    never double-debit);
 *  - insufficient balance ⇒ zero-or-partial debit + notification, and
 *    the settlement NEVER rejects (a credits outage must never fail a
 *    run — PRD §6);
 *  - BYOK exemption: plugins whose apiKey resolved from user/work
 *    settings are excluded from the billable amount (founder decision
 *    P2/P3 — user-supplied keys consume no platform credits).
 *
 * No real DB/Nest container — collaborators are jest.fn() shells (house
 * pattern, mirrors credit-ledger.service.spec.ts).
 */

const RUN = {
    id: 'run-1',
    userId: 'user-1',
    workId: 'work-1',
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    triggerKind: 'task',
    status: 'completed',
};

function makeAgentRuns(overrides: Record<string, jest.Mock> = {}) {
    return {
        findOne: jest.fn().mockResolvedValue({ ...RUN }),
        update: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeUsage(overrides: Record<string, jest.Mock> = {}) {
    return {
        getRunCostByPlugin: jest
            .fn()
            .mockResolvedValue([{ pluginId: 'openrouter', costCents: 37 }]),
        ...overrides,
    };
}

function makeLedger(overrides: Record<string, jest.Mock> = {}) {
    return {
        consumeForRun: jest.fn().mockImplementation(async (opts: any) => ({
            id: 'entry-1',
            kind: CreditLedgerKind.CONSUMPTION,
            amountCredits: -(opts.credits ?? opts.costCents),
            idempotencyKey: `run:${opts.runId}`,
        })),
        record: jest.fn().mockImplementation(async (opts: any) => ({
            id: 'entry-partial',
            ...opts,
        })),
        getBalance: jest.fn().mockResolvedValue(0),
        creditsForCostCents: jest.fn((cents: number) => cents),
        ...overrides,
    };
}

function makeEntitlements(overrides: Record<string, jest.Mock> = {}) {
    return {
        getNumber: jest.fn().mockResolvedValue(0),
        ...overrides,
    };
}

function makeUsers(overrides: Record<string, jest.Mock> = {}) {
    return {
        findByIdForScheduledRun: jest
            .fn()
            .mockResolvedValue({ id: 'user-1', defaultPlan: { code: 'free' } }),
        ...overrides,
    };
}

function makeNotifications(overrides: Record<string, jest.Mock> = {}) {
    return {
        notifyCreditsBalanceExhausted: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeSettings(overrides: Record<string, jest.Mock> = {}) {
    return {
        getResolvedSettings: jest.fn().mockResolvedValue({
            apiKey: { key: 'apiKey', value: 'sk-platform', source: 'env', isFallback: false },
        }),
        ...overrides,
    };
}

function makeService(
    parts: {
        agentRuns?: Record<string, jest.Mock>;
        usage?: Record<string, jest.Mock>;
        ledger?: Record<string, jest.Mock>;
        entitlements?: Record<string, jest.Mock>;
        users?: Record<string, jest.Mock>;
        notifications?: Record<string, jest.Mock> | null;
        settings?: Record<string, jest.Mock> | null;
    } = {},
) {
    const agentRuns = makeAgentRuns(parts.agentRuns);
    const usage = makeUsage(parts.usage);
    const ledger = makeLedger(parts.ledger);
    const entitlements = makeEntitlements(parts.entitlements);
    const users = makeUsers(parts.users);
    const notifications =
        parts.notifications === null ? undefined : makeNotifications(parts.notifications);
    const settings = parts.settings === null ? undefined : makeSettings(parts.settings);
    const service = new RunCostSettlementService(
        agentRuns as any,
        usage as any,
        ledger as any,
        entitlements as any,
        users as any,
        notifications as any,
        settings as any,
    );
    return { service, agentRuns, usage, ledger, entitlements, users, notifications, settings };
}

describe('RunCostSettlementService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.CREDITS_ENFORCEMENT;
        delete process.env.CREDITS_PER_DOLLAR;
        delete process.env.CREDITS_MARGIN_PERCENT;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('settleRun — accumulation', () => {
        it("sums only THIS run's tagged events and stamps agent_runs.costCents", async () => {
            const { service, agentRuns, usage } = makeService({
                usage: {
                    getRunCostByPlugin: jest.fn().mockResolvedValue([
                        { pluginId: 'openrouter', costCents: 30 },
                        { pluginId: 'tavily', costCents: 12 },
                    ]),
                },
            });

            const result = await service.settleRun('run-1');

            // The per-run query IS the scoping — nothing else is summed.
            expect(usage.getRunCostByPlugin).toHaveBeenCalledWith('run-1');
            expect(result.totalCostCents).toBe(42);
            expect(agentRuns.update).toHaveBeenCalledWith('run-1', { costCents: 42 });
            expect(result.status).toBe('settled');
        });

        it('skips (no stamp, no debit) when the run has zero tagged events', async () => {
            const { service, agentRuns, ledger } = makeService({
                usage: { getRunCostByPlugin: jest.fn().mockResolvedValue([]) },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('skipped');
            expect(agentRuns.update).not.toHaveBeenCalled();
            expect(ledger.consumeForRun).not.toHaveBeenCalled();
        });

        it('skips when the run row does not exist', async () => {
            const { service, ledger } = makeService({
                agentRuns: { findOne: jest.fn().mockResolvedValue(null) },
            });

            const result = await service.settleRun('run-missing');

            expect(result.status).toBe('skipped');
            expect(ledger.consumeForRun).not.toHaveBeenCalled();
        });
    });

    describe('settleRun — debit', () => {
        it('debits the billable total through consumeForRun with the run + scope', async () => {
            const { service, ledger } = makeService();

            const result = await service.settleRun('run-1');

            expect(ledger.consumeForRun).toHaveBeenCalledWith({
                userId: 'user-1',
                runId: 'run-1',
                costCents: 37,
                organizationId: 'org-1',
                tenantId: 'tenant-1',
                description: 'Run run-1 (task)',
            });
            expect(result.debitedCredits).toBe(37);
            expect(result.status).toBe('settled');
        });

        it('is idempotent across terminal-write re-runs — the SAME run key both times', async () => {
            const entry = { id: 'entry-1', amountCredits: -37 };
            const consumeForRun = jest
                .fn()
                // First terminal write: row created. Second: the ledger's
                // `run:{runId}` idempotency key returns the SAME row, no
                // second debit (CreditLedgerRepository.recordAtomic contract).
                .mockResolvedValueOnce(entry)
                .mockResolvedValueOnce(entry);
            const { service, ledger } = makeService({ ledger: { consumeForRun } });

            const first = await service.settleRun('run-1');
            const second = await service.settleRun('run-1');

            expect(ledger.consumeForRun).toHaveBeenCalledTimes(2);
            expect(ledger.consumeForRun.mock.calls[0][0].runId).toBe('run-1');
            expect(ledger.consumeForRun.mock.calls[1][0].runId).toBe('run-1');
            // Same ledger row observed both times — debited once.
            expect(first.debitedCredits).toBe(37);
            expect(second.debitedCredits).toBe(37);
            expect(ledger.record).not.toHaveBeenCalled();
        });
    });

    describe('settleRun — insufficient balance (PRD §6 policy)', () => {
        it('records a PARTIAL debit down to zero + emits the notification, never rejects', async () => {
            const { service, ledger, notifications } = makeService({
                ledger: {
                    consumeForRun: jest
                        .fn()
                        .mockRejectedValue(new InsufficientCreditsError('user-1', 37, 20)),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('partial');
            expect(result.debitedCredits).toBe(20);
            expect(ledger.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    kind: CreditLedgerKind.CONSUMPTION,
                    amountCredits: -20,
                    refId: 'run-1',
                    idempotencyKey: 'run:run-1',
                }),
            );
            expect(notifications!.notifyCreditsBalanceExhausted).toHaveBeenCalledWith({
                userId: 'user-1',
                runId: 'run-1',
                requiredCredits: 37,
                balanceCredits: 20,
            });
        });

        it('records NO debit when the balance is already exhausted (≤ 0), still notifies', async () => {
            const { service, ledger, notifications } = makeService({
                ledger: {
                    consumeForRun: jest
                        .fn()
                        .mockRejectedValue(new InsufficientCreditsError('user-1', 37, 0)),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('exhausted');
            expect(result.debitedCredits).toBe(0);
            expect(ledger.record).not.toHaveBeenCalled();
            expect(notifications!.notifyCreditsBalanceExhausted).toHaveBeenCalled();
        });

        it('never rejects even when the ledger AND the notification both fail', async () => {
            const { service } = makeService({
                ledger: {
                    consumeForRun: jest.fn().mockRejectedValue(new Error('ledger down')),
                },
                notifications: {
                    notifyCreditsBalanceExhausted: jest
                        .fn()
                        .mockRejectedValue(new Error('notify down')),
                },
            });

            await expect(service.settleRun('run-1')).resolves.toMatchObject({
                status: 'error',
            });
        });

        it('never rejects when the run lookup itself throws (terminal write is protected)', async () => {
            const { service } = makeService({
                agentRuns: { findOne: jest.fn().mockRejectedValue(new Error('DB down')) },
            });

            await expect(service.settleRun('run-1')).resolves.toMatchObject({ status: 'error' });
        });
    });

    describe('settleRun — BYOK/BYOS exemption (founder decision P2/P3)', () => {
        it('excludes plugins whose apiKey resolved from USER settings; stamp keeps the full total', async () => {
            const { service, agentRuns, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest.fn().mockResolvedValue([
                        { pluginId: 'user-keyed-provider', costCents: 30 },
                        { pluginId: 'platform-provider', costCents: 12 },
                    ]),
                },
                settings: {
                    getResolvedSettings: jest.fn().mockImplementation(async (pluginId: string) => ({
                        apiKey: {
                            key: 'apiKey',
                            value: 'sk-x',
                            source: pluginId === 'user-keyed-provider' ? 'user' : 'env',
                            isFallback: false,
                        },
                    })),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.exemptPluginIds).toEqual(['user-keyed-provider']);
            expect(result.totalCostCents).toBe(42);
            expect(result.billableCostCents).toBe(12);
            // costCents rollup stays the honest FULL metered figure.
            expect(agentRuns.update).toHaveBeenCalledWith('run-1', { costCents: 42 });
            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 12 }),
            );
        });

        it('a WORK-scoped user key is exempt too; a fully-exempt run debits nothing', async () => {
            const { service, ledger } = makeService({
                settings: {
                    getResolvedSettings: jest.fn().mockResolvedValue({
                        apiKey: { key: 'apiKey', value: 'sk-x', source: 'work', isFallback: false },
                    }),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('settled');
            expect(result.billableCostCents).toBe(0);
            expect(ledger.consumeForRun).not.toHaveBeenCalled();
        });

        it('bills the FULL amount when key provenance is not derivable (no settings service)', async () => {
            // Documented posture: BYOK_EXEMPTION_UNRESOLVED_BILLS_FULL —
            // never silently give usage away when provenance is unknown.
            const { service, ledger } = makeService({ settings: null });

            const result = await service.settleRun('run-1');

            expect(RunCostSettlementService.BYOK_EXEMPTION_UNRESOLVED_BILLS_FULL).toBe(true);
            expect(result.exemptPluginIds).toEqual([]);
            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 37 }),
            );
        });

        it('a per-plugin provenance failure bills that plugin (never exempt on doubt)', async () => {
            const { service, ledger } = makeService({
                settings: {
                    getResolvedSettings: jest.fn().mockRejectedValue(new Error('registry down')),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.exemptPluginIds).toEqual([]);
            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 37 }),
            );
        });
    });

    describe('shouldQueueForCredits — gate precheck (ship-dark)', () => {
        it('returns false when CREDITS_ENFORCEMENT is off (the default)', async () => {
            const { service, users } = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(-5) },
            });

            await expect(service.shouldQueueForCredits('user-1')).resolves.toBe(false);
            // Dark means dark — no lookups at all.
            expect(users.findByIdForScheduledRun).not.toHaveBeenCalled();
        });

        it('returns false when the plan is NOT credit-limited (no entitlement row ⇒ 0)', async () => {
            process.env.CREDITS_ENFORCEMENT = 'on';
            const { service, entitlements } = makeService({
                ledger: { getBalance: jest.fn().mockResolvedValue(-5) },
            });

            await expect(service.shouldQueueForCredits('user-1')).resolves.toBe(false);
            expect(entitlements.getNumber).toHaveBeenCalledWith('free', 'credit-limited', 0);
        });

        it('returns true only for credit-limited plan + balance ≤ 0', async () => {
            process.env.CREDITS_ENFORCEMENT = 'on';
            const { service } = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(0) },
            });

            await expect(service.shouldQueueForCredits('user-1')).resolves.toBe(true);
        });

        it('returns false (fail-open) when the balance is positive or resolution throws', async () => {
            process.env.CREDITS_ENFORCEMENT = 'on';
            const healthy = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(120) },
            });
            await expect(healthy.service.shouldQueueForCredits('user-1')).resolves.toBe(false);

            const broken = makeService({
                users: {
                    findByIdForScheduledRun: jest.fn().mockRejectedValue(new Error('DB down')),
                },
            });
            await expect(broken.service.shouldQueueForCredits('user-1')).resolves.toBe(false);
        });
    });
});
