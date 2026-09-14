import { RunCostSettlementService, splitMeteredSpend } from './run-cost-settlement.service';
import { CreditLedgerService, InsufficientCreditsError } from './credit-ledger.service';
import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { config } from '@src/config';
import { PublishedCreditPriceList } from '../../usage/credit-price-list';

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
        // Billing spec FR-3 — the gate's lazy daily grant.
        grantDailyForUser: jest.fn().mockResolvedValue('granted'),
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
        /** Pay-as-you-go collaborator (billing spec §3.5); absent by default. */
        payg?: Record<string, jest.Mock>;
        /** A real ledger service in place of the jest.fn() shell (conversion under test). */
        ledgerInstance?: CreditLedgerService;
    } = {},
) {
    const agentRuns = makeAgentRuns(parts.agentRuns);
    const usage = makeUsage(parts.usage);
    const ledger = parts.ledgerInstance ?? makeLedger(parts.ledger);
    const entitlements = makeEntitlements(parts.entitlements);
    const users = makeUsers(parts.users);
    const notifications =
        parts.notifications === null ? undefined : makeNotifications(parts.notifications);
    const settings = parts.settings === null ? undefined : makeSettings(parts.settings);
    const payg = parts.payg;
    const service = new RunCostSettlementService(
        agentRuns as any,
        usage as any,
        ledger as any,
        entitlements as any,
        users as any,
        notifications as any,
        settings as any,
        undefined, // auto-recharge — covered by its own spec
        payg as any,
    );
    return {
        service,
        agentRuns,
        usage,
        ledger: ledger as ReturnType<typeof makeLedger>,
        entitlements,
        users,
        notifications,
        settings,
        payg,
    };
}

describe('RunCostSettlementService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.CREDITS_ENFORCEMENT;
        delete process.env.CREDITS_PER_DOLLAR;
        delete process.env.CREDITS_MARGIN_PERCENT;
        delete process.env.CREDITS_SETTLEMENT_MODE;
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

    describe('settleRun — pay-as-you-go overflow (billing spec FR-18)', () => {
        it('meters the uncovered remainder when PAYG takes it, and does NOT raise the exhaustion notification', async () => {
            const payg = {
                recordOverflow: jest.fn().mockResolvedValue({
                    status: 'metered',
                    billedCredits: 17,
                    writtenOffCredits: 0,
                    sent: true,
                    capReached: false,
                }),
            };
            const { service, ledger, notifications } = makeService({
                ledger: {
                    consumeForRun: jest
                        .fn()
                        .mockRejectedValue(new InsufficientCreditsError('user-1', 37, 20)),
                },
                payg,
            });

            const result = await service.settleRun('run-1');

            // Prepaid part still debited down to zero…
            expect(ledger.record).toHaveBeenCalledWith(
                expect.objectContaining({ amountCredits: -20, idempotencyKey: 'run:run-1' }),
            );
            // …and the remainder (37 − 20) goes to the meter.
            expect(payg.recordOverflow).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1', runId: 'run-1', remainderCredits: 17 }),
            );
            expect(result).toMatchObject({
                status: 'metered',
                debitedCredits: 20,
                meteredCredits: 17,
                writtenOffCredits: 0,
            });
            expect(notifications!.notifyCreditsBalanceExhausted).not.toHaveBeenCalled();
        });

        it('falls back to the partial/exhausted policy (with notification) when PAYG is off or capped out', async () => {
            const payg = {
                recordOverflow: jest.fn().mockResolvedValue({
                    status: 'not-eligible',
                    billedCredits: 0,
                    writtenOffCredits: 37,
                }),
            };
            const { service, notifications } = makeService({
                ledger: {
                    consumeForRun: jest
                        .fn()
                        .mockRejectedValue(new InsufficientCreditsError('user-1', 37, 0)),
                },
                payg,
            });

            const result = await service.settleRun('run-1');

            expect(result).toMatchObject({
                status: 'exhausted',
                meteredCredits: 0,
                writtenOffCredits: 37,
            });
            expect(notifications!.notifyCreditsBalanceExhausted).toHaveBeenCalled();
        });

        it('a PAYG failure never reddens the settlement', async () => {
            const payg = { recordOverflow: jest.fn().mockRejectedValue(new Error('stripe down')) };
            const { service } = makeService({
                ledger: {
                    consumeForRun: jest
                        .fn()
                        .mockRejectedValue(new InsufficientCreditsError('user-1', 37, 20)),
                },
                payg,
            });
            await expect(service.settleRun('run-1')).resolves.toMatchObject({ status: 'partial' });
        });
    });

    describe('settleRun — BYOK/BYOS exemption (founder decision P2/P3)', () => {
        it('fleet-node rows (EW-777) stamp costCents and debit nothing — with or without a settings service', async () => {
            // A fleet run's model spend is billed to the CLI seat on the
            // owner's own machine; the plugin id is the provenance, so no
            // settings lookup is needed and the "no settings service ⇒
            // bill in full" posture must NOT apply to it.
            for (const settings of [undefined, null] as const) {
                const { service, agentRuns, ledger } = makeService({
                    usage: {
                        getRunCostByPlugin: jest
                            .fn()
                            .mockResolvedValue([
                                { pluginId: 'fleet-node:claude-code', costCents: 42 },
                            ]),
                    },
                    ...(settings === null ? { settings: null } : {}),
                });

                const result = await service.settleRun('run-1');

                expect(result.status).toBe('settled');
                expect(result.totalCostCents).toBe(42);
                expect(result.billableCostCents).toBe(0);
                expect(result.exemptPluginIds).toEqual(['fleet-node:claude-code']);
                // Stamped for the Goal cap, the top-runs panel and the ceilings...
                expect(agentRuns.update).toHaveBeenCalledWith('run-1', { costCents: 42 });
                // ...and never debited.
                expect(ledger.consumeForRun).not.toHaveBeenCalled();
            }
        });

        it('a fleet-node row next to a platform-keyed row exempts only the fleet row', async () => {
            const { service, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest.fn().mockResolvedValue([
                        { pluginId: 'fleet-node:codex', costCents: 30 },
                        { pluginId: 'platform-provider', costCents: 12 },
                    ]),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.exemptPluginIds).toEqual(['fleet-node:codex']);
            expect(result.billableCostCents).toBe(12);
            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 12 }),
            );
        });

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

    /**
     * AW-17 — rows classified at capture, in the opt-in `price_list` settlement
     * mode. A fixed-priced credits row debits its stamped credits; a
     * Workspace-paid or add-on row debits nothing; everything else settles
     * from provider cost exactly as before.
     */
    describe('settleRun — meters classified at capture, price_list mode (AW-17)', () => {
        beforeEach(() => {
            process.env.CREDITS_SETTLEMENT_MODE = 'price_list';
        });

        const group = (overrides: Record<string, unknown>) => ({
            pluginId: 'search-a',
            meter: 'credits',
            payer: 'platform',
            priceKey: 'search.query',
            priceVersion: 1,
            calls: 1,
            costCents: 0,
            creditsCharged: 0,
            ...overrides,
        });

        it('a run made entirely on Workspace-owned credentials writes no ledger row', async () => {
            const { service, ledger, agentRuns, settings } = makeService({
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'openai', costCents: 80 }]),
                    getRunMeterGroups: jest.fn().mockResolvedValue([
                        group({
                            pluginId: 'openai',
                            meter: 'model',
                            payer: 'workspace',
                            priceKey: 'ai.managed',
                            priceVersion: null,
                            costCents: 80,
                        }),
                    ]),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('settled');
            expect(result.totalCostCents).toBe(80);
            expect(result.billableCostCents).toBe(0);
            expect(result.exemptPluginIds).toEqual(['openai']);
            expect(agentRuns.update).toHaveBeenCalledWith('run-1', { costCents: 80 });
            expect(ledger.consumeForRun).not.toHaveBeenCalled();
            // Stamped at capture — no settlement-time provenance lookup.
            expect(settings?.getResolvedSettings).not.toHaveBeenCalled();
        });

        it('a mixed run debits the fixed prices plus the converted remainder, and nothing for own-key rows', async () => {
            const { service, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest.fn().mockResolvedValue([
                        { pluginId: 'search-a', costCents: 3 },
                        { pluginId: 'openrouter', costCents: 20 },
                        { pluginId: 'openai', costCents: 50 },
                    ]),
                    getRunMeterGroups: jest.fn().mockResolvedValue([
                        group({ pluginId: 'search-a', costCents: 3, calls: 3, creditsCharged: 6 }),
                        group({
                            pluginId: 'search-a',
                            outcome: 'failed',
                            costCents: 0,
                            creditsCharged: 0,
                        }),
                        group({
                            pluginId: 'openrouter',
                            priceKey: 'ai.managed',
                            priceVersion: null,
                            costCents: 20,
                            creditsCharged: 24,
                        }),
                        group({
                            pluginId: 'openai',
                            meter: 'model',
                            payer: 'workspace',
                            priceKey: 'ai.managed',
                            priceVersion: null,
                            costCents: 50,
                        }),
                    ]),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.totalCostCents).toBe(73);
            // 3¢ of fixed-priced search rows + 20¢ settled from provider cost.
            expect(result.billableCostCents).toBe(23);
            expect(ledger.creditsForCostCents).toHaveBeenCalledWith(20);
            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({
                    runId: 'run-1',
                    costCents: 23,
                    // 6 published credits + the mock ledger's 1:1 conversion of 20¢.
                    credits: 26,
                }),
            );
            expect(result.exemptPluginIds).toEqual(['openai']);
        });

        it('with no fixed price anywhere, settles exactly as before — no explicit credits override', async () => {
            const { service, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'openrouter', costCents: 37 }]),
                    getRunMeterGroups: jest.fn().mockResolvedValue([
                        group({
                            pluginId: 'openrouter',
                            priceKey: 'ai.managed',
                            priceVersion: null,
                            costCents: 37,
                            creditsCharged: 45,
                        }),
                    ]),
                },
            });

            await service.settleRun('run-1');

            const call = ledger.consumeForRun.mock.calls[0][0];
            expect(call.costCents).toBe(37);
            expect(call.credits).toBeUndefined();
        });

        it('a fixed-priced row whose only cost is the published price still debits', async () => {
            const { service, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'search-a', costCents: 0 }]),
                    getRunMeterGroups: jest
                        .fn()
                        .mockResolvedValue([group({ calls: 2, creditsCharged: 4 })]),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('settled');
            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 0, credits: 4 }),
            );
        });

        it('a fully cached run debits nothing', async () => {
            const { service, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'search-a', costCents: 0 }]),
                    getRunMeterGroups: jest
                        .fn()
                        .mockResolvedValue([group({ outcome: 'cached', creditsCharged: 0 })]),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('settled');
            expect(ledger.consumeForRun).not.toHaveBeenCalled();
        });

        it('checks provenance for a fixed-priced row whose payer was unconfirmed — an own key is not charged', async () => {
            const { service, ledger, settings } = makeService({
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'search-a', costCents: 0 }]),
                    getRunMeterGroups: jest
                        .fn()
                        .mockResolvedValue([group({ payer: 'unconfirmed', creditsCharged: 2 })]),
                },
                settings: {
                    getResolvedSettings: jest.fn().mockResolvedValue({
                        apiKey: { key: 'apiKey', value: 'sk', source: 'user', isFallback: false },
                    }),
                },
            });

            const result = await service.settleRun('run-1');

            expect(settings?.getResolvedSettings).toHaveBeenCalledWith(
                'search-a',
                expect.objectContaining({ userId: 'user-1' }),
            );
            expect(result.exemptPluginIds).toEqual(['search-a']);
            expect(ledger.consumeForRun).not.toHaveBeenCalled();
        });

        it('an unconfirmed fixed-priced row that resolves to the platform is charged the published price', async () => {
            const { service, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'search-a', costCents: 1 }]),
                    getRunMeterGroups: jest
                        .fn()
                        .mockResolvedValue([
                            group({ payer: 'unconfirmed', costCents: 1, creditsCharged: 2 }),
                        ]),
                },
            });

            await service.settleRun('run-1');

            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 1, credits: 2 }),
            );
        });

        it('a retried settlement reuses the same run key — never a second debit', async () => {
            const entry = { id: 'entry-1', amountCredits: -6 };
            const consumeForRun = jest.fn().mockResolvedValue(entry);
            const { service, ledger } = makeService({
                ledger: { consumeForRun },
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'search-a', costCents: 3 }]),
                    getRunMeterGroups: jest
                        .fn()
                        .mockResolvedValue([group({ calls: 3, costCents: 3, creditsCharged: 6 })]),
                },
            });

            await service.settleRun('run-1');
            await service.settleRun('run-1');

            expect(ledger.consumeForRun).toHaveBeenCalledTimes(2);
            expect(ledger.consumeForRun.mock.calls[0][0]).toEqual(
                ledger.consumeForRun.mock.calls[1][0],
            );
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('settles the pre-meter way when the classified read fails', async () => {
            const { service, ledger } = makeService({
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'openrouter', costCents: 37 }]),
                    getRunMeterGroups: jest.fn().mockRejectedValue(new Error('column missing')),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('settled');
            expect(ledger.consumeForRun).toHaveBeenCalledWith(
                expect.objectContaining({ costCents: 37 }),
            );
            expect(ledger.consumeForRun.mock.calls[0][0].credits).toBeUndefined();
        });

        it('an insufficient balance on a fixed-priced debit still takes the partial path', async () => {
            const { service, ledger } = makeService({
                ledger: {
                    consumeForRun: jest
                        .fn()
                        .mockRejectedValue(new InsufficientCreditsError('user-1', 6, 4)),
                },
                usage: {
                    getRunCostByPlugin: jest
                        .fn()
                        .mockResolvedValue([{ pluginId: 'search-a', costCents: 0 }]),
                    getRunMeterGroups: jest
                        .fn()
                        .mockResolvedValue([group({ calls: 3, creditsCharged: 6 })]),
                },
            });

            const result = await service.settleRun('run-1');

            expect(result.status).toBe('partial');
            expect(ledger.record).toHaveBeenCalledWith(
                expect.objectContaining({ amountCredits: -4, idempotencyKey: 'run:run-1' }),
            );
        });
    });

    /**
     * AW-17 — the settlement mode is configuration, and the default changes
     * nothing a customer is charged. The debit is computed by a REAL
     * CreditLedgerService (only its storage port is a shell), so the expected
     * credits come from the configured conversion rather than a mock's 1:1.
     */
    describe('settleRun — settlement mode (AW-17)', () => {
        const SEARCH_COST_CENTS = 5;
        /** A web search the platform paid for, classified and stamped at capture. */
        const platformSearch = {
            spend: [{ pluginId: 'tavily', costCents: SEARCH_COST_CENTS }],
            groups: [
                {
                    pluginId: 'tavily',
                    meter: 'credits',
                    payer: 'platform',
                    priceKey: 'search.query',
                    priceVersion: 1,
                    calls: 1,
                    costCents: SEARCH_COST_CENTS,
                    creditsCharged: 2,
                },
            ],
        };

        function makeRealLedger() {
            const recordAtomic = jest.fn(async (write: Record<string, unknown>) => ({
                status: 'created',
                entry: { id: 'entry-real', ...write },
            }));
            const ledger = new CreditLedgerService(
                { recordAtomic } as never,
                {} as never,
                {} as never,
            );
            return { ledger, recordAtomic };
        }

        function settleSearch(settings?: Record<string, jest.Mock>) {
            const { ledger, recordAtomic } = makeRealLedger();
            const getRunMeterGroups = jest.fn().mockResolvedValue(platformSearch.groups);
            const made = makeService({
                ledgerInstance: ledger,
                usage: {
                    getRunCostByPlugin: jest.fn().mockResolvedValue(platformSearch.spend),
                    getRunMeterGroups,
                },
                ...(settings ? { settings } : {}),
            });
            return { ...made, recordAtomic, getRunMeterGroups };
        }

        /**
         * The run conversion as it stands on the branch this PR targets:
         * `ceil(costCents × creditsPerDollar/100 × (1 + margin/100))`, read from
         * the configured knobs.
         */
        function preMeterCredits(costCents: number): number {
            const creditsPerCent = config.billing.credits.getCreditsPerDollar() / 100;
            const margin = 1 + config.billing.credits.getMarginPercent() / 100;
            return Math.ceil(costCents * creditsPerCent * margin);
        }

        it('defaults to provider_cost: a platform-paid search settles to exactly the pre-meter credits', async () => {
            const expected = preMeterCredits(SEARCH_COST_CENTS);
            // Guard the fixture: the two modes must disagree, or this proves nothing.
            expect(expected).not.toBe(2);

            const { service, recordAtomic, getRunMeterGroups } = settleSearch();
            const result = await service.settleRun('run-1');

            expect(result.settlementMode).toBe('provider_cost');
            expect(result.status).toBe('settled');
            expect(result.billableCostCents).toBe(SEARCH_COST_CENTS);
            expect(result.debitedCredits).toBe(expected);
            expect(recordAtomic).toHaveBeenCalledTimes(1);
            expect(recordAtomic.mock.calls[0][0]).toMatchObject({
                kind: CreditLedgerKind.CONSUMPTION,
                amountCredits: -expected,
                costCentsRef: SEARCH_COST_CENTS,
                idempotencyKey: 'run:run-1',
            });
            // The classification never takes part in a provider_cost debit.
            expect(getRunMeterGroups).not.toHaveBeenCalled();
        });

        it('the same row under a different configured margin still follows the conversion, not the list', async () => {
            process.env.CREDITS_MARGIN_PERCENT = '80';
            const expected = preMeterCredits(SEARCH_COST_CENTS);

            const { service } = settleSearch();
            const result = await service.settleRun('run-1');

            expect(result.debitedCredits).toBe(expected);
        });

        it('price_list: the same platform-paid search settles at its published 2 credits', async () => {
            process.env.CREDITS_SETTLEMENT_MODE = 'price_list';
            const published = new PublishedCreditPriceList().find('search.query');
            expect(published?.credits).toBe(2);

            const { service, recordAtomic, getRunMeterGroups } = settleSearch();
            const result = await service.settleRun('run-1');

            expect(result.settlementMode).toBe('price_list');
            expect(getRunMeterGroups).toHaveBeenCalledWith('run-1');
            expect(result.debitedCredits).toBe(2);
            expect(recordAtomic.mock.calls[0][0]).toMatchObject({ amountCredits: -2 });
        });

        it('an unrecognised mode value settles the default way', async () => {
            process.env.CREDITS_SETTLEMENT_MODE = 'fixed';

            const { service, getRunMeterGroups } = settleSearch();
            const result = await service.settleRun('run-1');

            expect(result.settlementMode).toBe('provider_cost');
            expect(result.debitedCredits).toBe(preMeterCredits(SEARCH_COST_CENTS));
            expect(getRunMeterGroups).not.toHaveBeenCalled();
        });

        it.each(['provider_cost', 'price_list'])(
            '%s: a search on a Workspace-owned key is exempt and debits nothing',
            async (mode) => {
                process.env.CREDITS_SETTLEMENT_MODE = mode;
                const { ledger, recordAtomic } = makeRealLedger();
                const { service } = makeService({
                    ledgerInstance: ledger,
                    usage: {
                        getRunCostByPlugin: jest.fn().mockResolvedValue(platformSearch.spend),
                        // What capture stamps for an own-key call.
                        getRunMeterGroups: jest.fn().mockResolvedValue([
                            {
                                ...platformSearch.groups[0],
                                meter: 'model',
                                payer: 'workspace',
                                priceVersion: null,
                                creditsCharged: 0,
                            },
                        ]),
                    },
                    settings: {
                        getResolvedSettings: jest.fn().mockResolvedValue({
                            apiKey: {
                                key: 'apiKey',
                                value: 'sk',
                                source: 'user',
                                isFallback: false,
                            },
                        }),
                    },
                });

                const result = await service.settleRun('run-1');

                expect(result.status).toBe('settled');
                expect(result.totalCostCents).toBe(SEARCH_COST_CENTS);
                expect(result.billableCostCents).toBe(0);
                expect(result.exemptPluginIds).toEqual(['tavily']);
                expect(result.debitedCredits).toBe(0);
                expect(recordAtomic).not.toHaveBeenCalled();
            },
        );

        it('provider_cost ignores the capture-time stamp and resolves provenance exactly as before', async () => {
            // Capture said "Workspace-paid", but the key now resolves to the
            // platform's: the pre-meter settlement billed it, so this one does too.
            const { ledger } = makeRealLedger();
            const { service, settings } = makeService({
                ledgerInstance: ledger,
                usage: {
                    getRunCostByPlugin: jest.fn().mockResolvedValue(platformSearch.spend),
                    getRunMeterGroups: jest
                        .fn()
                        .mockResolvedValue([
                            { ...platformSearch.groups[0], meter: 'model', payer: 'workspace' },
                        ]),
                },
            });

            const result = await service.settleRun('run-1');

            expect(settings?.getResolvedSettings).toHaveBeenCalledWith(
                'tavily',
                expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
            );
            expect(result.exemptPluginIds).toEqual([]);
            expect(result.debitedCredits).toBe(preMeterCredits(SEARCH_COST_CENTS));
        });
    });

    describe('splitMeteredSpend', () => {
        it('keeps an unclassified remainder of a plugin on the legacy path — nothing counted twice', () => {
            const split = splitMeteredSpend(
                [{ pluginId: 'search-a', costCents: 10 }],
                [
                    {
                        pluginId: 'search-a',
                        meter: 'credits',
                        payer: 'platform',
                        priceKey: 'search.query',
                        priceVersion: 1,
                        calls: 2,
                        costCents: 4,
                        creditsCharged: 4,
                    },
                ],
            );
            expect(split.fixedRows).toEqual([
                { pluginId: 'search-a', costCents: 4, creditsCharged: 4, unconfirmed: false },
            ]);
            expect(split.legacySpend).toEqual([{ pluginId: 'search-a', costCents: 6 }]);
        });

        it('treats pre-meter rows (no meter) as legacy', () => {
            const split = splitMeteredSpend(
                [{ pluginId: 'openrouter', costCents: 12 }],
                [
                    {
                        pluginId: 'openrouter',
                        meter: null,
                        payer: null,
                        priceKey: null,
                        priceVersion: null,
                        calls: 3,
                        costCents: 12,
                        creditsCharged: 0,
                    },
                ],
            );
            expect(split.fixedRows).toEqual([]);
            expect(split.workspacePluginIds).toEqual([]);
            expect(split.legacySpend).toEqual([{ pluginId: 'openrouter', costCents: 12 }]);
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

        it("grants today's daily allowance lazily before reading the balance (billing spec FR-3)", async () => {
            process.env.CREDITS_ENFORCEMENT = 'on';
            const { service, ledger } = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(50) },
            });
            await expect(service.shouldQueueForCredits('user-1')).resolves.toBe(false);
            expect(ledger.grantDailyForUser).toHaveBeenCalledWith('user-1', 'free');
            // Grant BEFORE balance read.
            expect(ledger.grantDailyForUser.mock.invocationCallOrder[0]).toBeLessThan(
                ledger.getBalance.mock.invocationCallOrder[0],
            );
        });

        it('admits a zero-balance user who still has pay-as-you-go headroom (billing spec FR-19)', async () => {
            process.env.CREDITS_ENFORCEMENT = 'on';
            const withHeadroom = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(0) },
                payg: { headroom: jest.fn().mockResolvedValue(400) },
            });
            await expect(withHeadroom.service.shouldQueueForCredits('user-1')).resolves.toBe(false);

            const capped = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(0) },
                payg: { headroom: jest.fn().mockResolvedValue(0) },
            });
            await expect(capped.service.shouldQueueForCredits('user-1')).resolves.toBe(true);
        });

        it('enforcement defaults ON when the billing provider is configured and OFF otherwise (billing spec FR-30)', async () => {
            delete process.env.CREDITS_ENFORCEMENT;
            process.env.STRIPE_SECRET_KEY = 'sk_test_x';
            const configured = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(0) },
            });
            await expect(configured.service.shouldQueueForCredits('user-1')).resolves.toBe(true);

            delete process.env.STRIPE_SECRET_KEY;
            const unconfigured = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(0) },
            });
            await expect(unconfigured.service.shouldQueueForCredits('user-1')).resolves.toBe(false);

            process.env.CREDITS_ENFORCEMENT = 'off';
            process.env.STRIPE_SECRET_KEY = 'sk_test_x';
            const explicitOff = makeService({
                entitlements: { getNumber: jest.fn().mockResolvedValue(1) },
                ledger: { getBalance: jest.fn().mockResolvedValue(0) },
            });
            await expect(explicitOff.service.shouldQueueForCredits('user-1')).resolves.toBe(false);
            delete process.env.STRIPE_SECRET_KEY;
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
