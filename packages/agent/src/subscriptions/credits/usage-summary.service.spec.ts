import {
    InvalidUsagePeriodError,
    resolveUsageSummaryWindow,
    UsageSummaryService,
} from './usage-summary.service';
import type { CreditLedgerRepository } from '@src/database/repositories/credit-ledger.repository';
import type { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';

describe('resolveUsageSummaryWindow', () => {
    const now = new Date('2026-07-25T12:00:00.000Z');

    it('defaults to the current UTC calendar month (half-open window)', () => {
        const window = resolveUsageSummaryWindow(undefined, now);
        expect(window.period).toBe('2026-07');
        expect(window.from.toISOString()).toBe('2026-07-01T00:00:00.000Z');
        expect(window.to.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('resolves an explicit YYYY-MM month (incl. December→January rollover)', () => {
        const window = resolveUsageSummaryWindow('2025-12', now);
        expect(window.period).toBe('2025-12');
        expect(window.from.toISOString()).toBe('2025-12-01T00:00:00.000Z');
        expect(window.to.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('resolves rolling 7d and 30d windows ending now', () => {
        const seven = resolveUsageSummaryWindow('7d', now);
        expect(seven.period).toBe('7d');
        expect(seven.to).toEqual(now);
        expect(seven.from.toISOString()).toBe('2026-07-18T12:00:00.000Z');

        const thirty = resolveUsageSummaryWindow('30d', now);
        expect(thirty.from.toISOString()).toBe('2026-06-25T12:00:00.000Z');
    });

    it('throws the stable-named InvalidUsagePeriodError on malformed input', () => {
        for (const bad of ['2026-13', '90d', 'yesterday', '7D']) {
            expect(() => resolveUsageSummaryWindow(bad, now)).toThrow(InvalidUsagePeriodError);
        }
    });
});

describe('UsageSummaryService', () => {
    let pluginUsageRepository: jest.Mocked<
        Pick<
            PluginUsageRepository,
            | 'getTotalSpendCentsForUser'
            | 'getUsageCountsForUser'
            | 'getDailySpendForUser'
            | 'getSpendByModelForUser'
            | 'getSpendByAgentForUser'
            | 'getSpendByWorkForUser'
            | 'getAgentNames'
            | 'getWorkNames'
        >
    >;
    let creditLedgerRepository: jest.Mocked<
        Pick<CreditLedgerRepository, 'getBalance' | 'getPeriodTotals'>
    >;
    let service: UsageSummaryService;

    beforeEach(() => {
        pluginUsageRepository = {
            getTotalSpendCentsForUser: jest.fn().mockResolvedValue(240),
            getUsageCountsForUser: jest.fn().mockResolvedValue({
                tasksCompleted: 3,
                worksActive: 2,
                agentRuns: 7,
            }),
            getDailySpendForUser: jest.fn().mockResolvedValue([
                { day: '2026-07-01', costCents: 100 },
                { day: '2026-07-02', costCents: 140 },
            ]),
            getSpendByModelForUser: jest.fn().mockResolvedValue([
                { key: 'gpt-x', units: 5, costCents: 200 },
                { key: null, units: 2, costCents: 40 },
            ]),
            getSpendByAgentForUser: jest.fn().mockResolvedValue([
                { key: 'agent-1', units: 4, costCents: 150 },
                { key: null, units: 1, costCents: 90 },
            ]),
            getSpendByWorkForUser: jest
                .fn()
                .mockResolvedValue([{ key: 'work-1', units: 6, costCents: 240 }]),
            getAgentNames: jest.fn().mockResolvedValue(new Map([['agent-1', 'Research Agent']])),
            getWorkNames: jest.fn().mockResolvedValue(new Map([['work-1', 'My Directory']])),
        } as any;
        creditLedgerRepository = {
            getBalance: jest.fn().mockResolvedValue(500),
            getPeriodTotals: jest
                .fn()
                .mockResolvedValue({ consumedCredits: 260, addedCredits: 300 }),
        } as any;
        service = new UsageSummaryService(
            pluginUsageRepository as unknown as PluginUsageRepository,
            creditLedgerRepository as unknown as CreditLedgerRepository,
        );
    });

    it('getTotals composes balance, ledger movements, spend, and counts for ONE user + window', async () => {
        const result = await service.getTotals('user-1', '2026-07');

        expect(result).toMatchObject({
            period: '2026-07',
            balanceCredits: 500,
            creditsConsumed: 260,
            creditsAdded: 300,
            spendCents: 240,
            tasksCompleted: 3,
            worksActive: 2,
            agentRuns: 7,
        });

        // Every underlying query is keyed on the SAME owner + window.
        const from = new Date('2026-07-01T00:00:00.000Z');
        const to = new Date('2026-08-01T00:00:00.000Z');
        expect(creditLedgerRepository.getBalance).toHaveBeenCalledWith('user-1');
        expect(creditLedgerRepository.getPeriodTotals).toHaveBeenCalledWith('user-1', from, to);
        expect(pluginUsageRepository.getTotalSpendCentsForUser).toHaveBeenCalledWith(
            'user-1',
            from,
            to,
        );
        expect(pluginUsageRepository.getUsageCountsForUser).toHaveBeenCalledWith(
            'user-1',
            from,
            to,
        );
    });

    it('getGrouped(day) maps daily buckets to chart rows', async () => {
        const result = await service.getGrouped('user-1', 'day', '2026-07');

        expect(result.groupBy).toBe('day');
        expect(result.rows).toEqual([
            { key: '2026-07-01', label: '2026-07-01', units: 0, costCents: 100 },
            { key: '2026-07-02', label: '2026-07-02', units: 0, costCents: 140 },
        ]);
    });

    it('getGrouped(model) uses modelId as the label and keeps unattributed (null) rows', async () => {
        const result = await service.getGrouped('user-1', 'model', '2026-07');

        expect(result.rows[0]).toEqual({ key: 'gpt-x', label: 'gpt-x', units: 5, costCents: 200 });
        expect(result.rows[1].key).toBeNull();
    });

    it('getGrouped(agent) resolves Agent display names with ONE IN-query (no N+1)', async () => {
        const result = await service.getGrouped('user-1', 'agent', '2026-07');

        // Null keys are filtered OUT of the name lookup but kept as rows.
        expect(pluginUsageRepository.getAgentNames).toHaveBeenCalledTimes(1);
        expect(pluginUsageRepository.getAgentNames).toHaveBeenCalledWith(['agent-1']);
        expect(result.rows[0]).toEqual({
            key: 'agent-1',
            label: 'Research Agent',
            units: 4,
            costCents: 150,
        });
        expect(result.rows[1].key).toBeNull();
    });

    it('getGrouped(work) resolves Work names; a deleted Work falls back to its raw id', async () => {
        pluginUsageRepository.getSpendByWorkForUser.mockResolvedValue([
            { key: 'work-1', units: 6, costCents: 240 },
            { key: 'work-gone', units: 1, costCents: 10 },
        ]);

        const result = await service.getGrouped('user-1', 'work', '2026-07');

        expect(pluginUsageRepository.getWorkNames).toHaveBeenCalledWith(['work-1', 'work-gone']);
        expect(result.rows[0].label).toBe('My Directory');
        expect(result.rows[1].label).toBe('work-gone');
    });

    it('rejects a malformed period before any repository work happens', async () => {
        await expect(service.getTotals('user-1', 'nope')).rejects.toBeInstanceOf(
            InvalidUsagePeriodError,
        );
        expect(creditLedgerRepository.getBalance).not.toHaveBeenCalled();
        expect(pluginUsageRepository.getDailySpendForUser).not.toHaveBeenCalled();
    });
});
