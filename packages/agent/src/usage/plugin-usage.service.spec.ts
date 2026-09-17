import { PluginUsageService } from './plugin-usage.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { UsageMeter, UsageOutcome, UsagePayer } from '@src/entities/_types';
import { PublishedCreditPriceList } from './credit-price-list';

/**
 * EW-602 — PluginUsageService is the best-effort write path for
 * per-call usage events. The two contractual invariants are:
 *   - never throws (a failed insert must not break the underlying
 *     plugin call)
 *   - silently skips when workId or userId is absent (system-initiated
 *     calls have no Work scope to attribute spend to)
 */

function makeRepo(overrides: Record<string, jest.Mock> = {}) {
    return {
        record: jest.fn().mockResolvedValue({ id: 'event-1' }),
        getTotalSpendCents: jest.fn(),
        getSpendByPlugin: jest.fn(),
        getDailySpend: jest.fn(),
        getCrossUserSpend: jest.fn(),
        findForExport: jest.fn(),
        pruneOlderThan: jest.fn(),
        ...overrides,
    };
}

function makeService(overrides: Record<string, jest.Mock> = {}) {
    const repository = makeRepo(overrides);
    const service = new PluginUsageService(repository as any);
    return { service, repository };
}

describe('PluginUsageService.record', () => {
    it('persists the event when both workId and userId are present', async () => {
        const { service, repository } = makeService();
        await service.record({
            workId: 'work-1',
            userId: 'user-1',
            pluginId: 'openai',
            capability: PluginUsageCapability.AI,
            units: 100,
            costCents: 250,
        });
        expect(repository.record).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
                units: 100,
                costCents: 250,
                currency: 'usd',
            }),
        );
    });

    it('returns null and does NOT call the repo when workId is missing', async () => {
        const { service, repository } = makeService();
        const result = await service.record({
            workId: undefined,
            userId: 'user-1',
            pluginId: 'openai',
            capability: PluginUsageCapability.AI,
        });
        expect(result).toBeNull();
        expect(repository.record).not.toHaveBeenCalled();
    });

    it('returns null and does NOT call the repo when userId is missing', async () => {
        const { service, repository } = makeService();
        const result = await service.record({
            workId: 'work-1',
            userId: undefined,
            pluginId: 'openai',
            capability: PluginUsageCapability.AI,
        });
        expect(result).toBeNull();
        expect(repository.record).not.toHaveBeenCalled();
    });

    it('defaults units=1, costCents=0, currency=usd when omitted', async () => {
        const { service, repository } = makeService();
        await service.record({
            workId: 'work-1',
            userId: 'user-1',
            pluginId: 'tavily',
            capability: PluginUsageCapability.SEARCH,
        });
        expect(repository.record).toHaveBeenCalledWith(
            expect.objectContaining({ units: 1, costCents: 0, currency: 'usd' }),
        );
    });

    it('rounds fractional costCents and clamps negatives to zero', async () => {
        const { service, repository } = makeService();
        await service.record({
            workId: 'work-1',
            userId: 'user-1',
            pluginId: 'openai',
            capability: PluginUsageCapability.AI,
            costCents: 12.7,
        });
        expect(repository.record).toHaveBeenCalledWith(expect.objectContaining({ costCents: 13 }));

        repository.record.mockClear();
        await service.record({
            workId: 'work-1',
            userId: 'user-1',
            pluginId: 'openai',
            capability: PluginUsageCapability.AI,
            costCents: -50,
        });
        expect(repository.record).toHaveBeenCalledWith(expect.objectContaining({ costCents: 0 }));
    });

    it('NEVER throws even when the repository.record rejects (best-effort contract)', async () => {
        const { service } = makeService({
            record: jest.fn().mockRejectedValue(new Error('DB down')),
        });
        const result = await service.record({
            workId: 'work-1',
            userId: 'user-1',
            pluginId: 'openai',
            capability: PluginUsageCapability.AI,
        });
        expect(result).toBeNull();
        // No throw — that's the assertion.
    });

    /**
     * Agents/Skills/Tasks PR #1017 — Phase 15.6. Agent + Task
     * attribution propagation.
     */
    describe('agentId / taskId attribution (Phase 15.6)', () => {
        it('persists agentId + taskId when supplied alongside workId', async () => {
            const { service, repository } = makeService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                agentId: 'agent-9',
                taskId: 'task-42',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'work-1',
                    userId: 'user-1',
                    agentId: 'agent-9',
                    taskId: 'task-42',
                }),
            );
        });

        it('agent-initiated call WITHOUT workId still persists when agentId is set', async () => {
            const { service, repository } = makeService();
            const result = await service.record({
                workId: undefined,
                userId: 'user-1',
                agentId: 'agent-9',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
            });
            expect(result).toEqual({ id: 'event-1' });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: undefined,
                    userId: 'user-1',
                    agentId: 'agent-9',
                    taskId: null,
                }),
            );
        });

        it('task-initiated call WITHOUT workId still persists when taskId is set', async () => {
            const { service, repository } = makeService();
            const result = await service.record({
                workId: undefined,
                userId: 'user-1',
                taskId: 'task-42',
                pluginId: 'tavily',
                capability: PluginUsageCapability.SEARCH,
            });
            expect(result).toEqual({ id: 'event-1' });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: undefined,
                    userId: 'user-1',
                    taskId: 'task-42',
                    agentId: null,
                }),
            );
        });

        it('still skips when all of workId / agentId / taskId are absent', async () => {
            const { service, repository } = makeService();
            const result = await service.record({
                workId: undefined,
                userId: 'user-1',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
            });
            expect(result).toBeNull();
            expect(repository.record).not.toHaveBeenCalled();
        });

        it('defaults agentId / taskId to null when omitted but workId is present', async () => {
            const { service, repository } = makeService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({ agentId: null, taskId: null }),
            );
        });
    });

    /**
     * Pricing Wave 9 M2 — per-run attribution: rows tagged with the run
     * id are what the run-cost accumulator sums at run-terminal time.
     */
    describe('runId attribution (Wave 9 M2)', () => {
        it('persists runId when supplied', async () => {
            const { service, repository } = makeService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                agentId: 'agent-9',
                runId: 'run-7',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
                costCents: 12,
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({ runId: 'run-7' }),
            );
        });

        it('defaults runId to null when omitted (non-run calls stay untagged)', async () => {
            const { service, repository } = makeService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({ runId: null }),
            );
        });
    });

    /**
     * AW-17 — the single write path classifies every row as it is written:
     * meter, payer, outcome, price key, price version, credits, and the
     * Mission of the run's Task passed straight through.
     */
    describe('meter classification at capture (AW-17)', () => {
        function makeClassifyingService(
            options: {
                payer?: UsagePayer;
                resolver?: { resolve: jest.Mock } | null;
                record?: jest.Mock;
            } = {},
        ) {
            const repository = makeRepo(options.record ? { record: options.record } : {});
            const resolver =
                options.resolver === null
                    ? undefined
                    : (options.resolver ?? {
                          resolve: jest
                              .fn()
                              .mockResolvedValue(options.payer ?? UsagePayer.PLATFORM),
                      });
            const service = new PluginUsageService(
                repository as any,
                new PublishedCreditPriceList(),
                resolver as any,
            );
            return { service, repository, resolver };
        }

        it('stamps meter, payer, outcome, price key, version and credits on a platform-paid search', async () => {
            const { service, repository, resolver } = makeClassifyingService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
                costCents: 1,
                metadata: { operation: 'search' },
            });
            expect(resolver?.resolve).toHaveBeenCalledWith({
                pluginId: 'search-a',
                userId: 'user-1',
                workId: 'work-1',
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    meter: UsageMeter.CREDITS,
                    payer: UsagePayer.PLATFORM,
                    outcome: UsageOutcome.OK,
                    priceKey: 'search.query',
                    priceVersion: 1,
                    creditsCharged: 2,
                }),
            );
        });

        it('records a call on a Workspace-owned key as model usage with zero credits', async () => {
            const { service, repository } = makeClassifyingService({ payer: UsagePayer.WORKSPACE });
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
                units: 900,
                costCents: 250,
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    meter: UsageMeter.MODEL,
                    payer: UsagePayer.WORKSPACE,
                    creditsCharged: 0,
                    priceVersion: null,
                    costCents: 250,
                }),
            );
        });

        it('uses a payer the caller already knows without asking the resolver', async () => {
            const { service, repository, resolver } = makeClassifyingService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'openai',
                capability: PluginUsageCapability.AI,
                payer: UsagePayer.WORKSPACE,
            });
            expect(resolver?.resolve).not.toHaveBeenCalled();
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({ meter: UsageMeter.MODEL }),
            );
        });

        it('writes a failed call with outcome failed and zero credits', async () => {
            const { service, repository } = makeClassifyingService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
                outcome: UsageOutcome.FAILED,
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    meter: UsageMeter.CREDITS,
                    outcome: UsageOutcome.FAILED,
                    creditsCharged: 0,
                }),
            );
        });

        it('passes the Mission of the run Task straight through, and null when the run had no Task', async () => {
            const { service, repository } = makeClassifyingService();
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                agentId: 'agent-1',
                taskId: 'task-1',
                runId: 'run-1',
                missionId: 'mission-7',
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
            });
            expect(repository.record).toHaveBeenLastCalledWith(
                expect.objectContaining({ missionId: 'mission-7', taskId: 'task-1' }),
            );

            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                agentId: 'agent-1',
                runId: 'heartbeat-run',
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
            });
            expect(repository.record).toHaveBeenLastCalledWith(
                expect.objectContaining({ missionId: null, taskId: null }),
            );
        });

        it('with no resolver bound, an unknown payer is recorded as unconfirmed credits and counted', async () => {
            const { service, repository } = makeClassifyingService({ resolver: null });
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
            });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    meter: UsageMeter.CREDITS,
                    payer: UsagePayer.UNCONFIRMED,
                }),
            );
            expect(service.getCounters()).toMatchObject({ recorded: 1, unconfirmedPayer: 1 });
        });

        it('still writes the row as credits/unconfirmed when classification throws', async () => {
            const { service, repository } = makeClassifyingService({
                resolver: {
                    resolve: jest.fn().mockRejectedValue(new Error('settings graph down')),
                },
            });
            const result = await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
                metadata: { operation: 'search' },
            });
            expect(result).toEqual({ id: 'event-1' });
            expect(repository.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    meter: UsageMeter.CREDITS,
                    payer: UsagePayer.UNCONFIRMED,
                    priceKey: 'search.query',
                    creditsCharged: 0,
                }),
            );
            expect(service.getCounters()).toMatchObject({
                recorded: 1,
                classifierFailures: 1,
                unconfirmedPayer: 1,
            });
        });

        it('counts a price-list miss per row and keeps every row', async () => {
            const { service, repository } = makeClassifyingService();
            const priceless = 'future' as unknown as PluginUsageCapability;
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'p',
                capability: priceless,
            });
            await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'p',
                capability: priceless,
            });
            expect(repository.record).toHaveBeenCalledTimes(2);
            expect(service.getCounters().pricebookMisses).toBe(2);
        });

        it('a repository throw still returns null and counts a write failure', async () => {
            const { service } = makeClassifyingService({
                record: jest.fn().mockRejectedValue(new Error('DB down')),
            });
            const result = await service.record({
                workId: 'work-1',
                userId: 'user-1',
                pluginId: 'search-a',
                capability: PluginUsageCapability.SEARCH,
            });
            expect(result).toBeNull();
            expect(service.getCounters()).toMatchObject({ recorded: 0, writeFailures: 1 });
        });
    });
});
