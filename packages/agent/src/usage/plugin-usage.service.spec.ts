import { PluginUsageService } from './plugin-usage.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';

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
});
