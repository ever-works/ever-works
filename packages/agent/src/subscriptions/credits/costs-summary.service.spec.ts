import type { AgentRunRepository } from '@src/database/repositories/agent-run.repository';
import type { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';
import type { AgentRun } from '@src/entities/agent-run.entity';
import {
    COSTS_DAILY_MAX_SERIES,
    COSTS_OTHER_SERIES_KEY,
    COSTS_TOP_RUNS_MAX_LIMIT,
    COSTS_UNATTRIBUTED_SERIES_KEY,
    CostsSummaryService,
    InvalidCostsWindowError,
    resolveCostsWindow,
} from './costs-summary.service';

const USER = 'user-1';

/** 2026-08-14T15:30:00Z — mid-day so the "snap to UTC midnight" rule bites. */
const NOW = new Date('2026-08-14T15:30:00.000Z');

function pluginUsageRepositoryMock(): jest.Mocked<PluginUsageRepository> {
    return {
        getTotalSpendCentsForUser: jest.fn().mockResolvedValue(0),
        getUsageCountsForUser: jest
            .fn()
            .mockResolvedValue({ tasksCompleted: 0, worksActive: 0, agentRuns: 0 }),
        getDailySpendByAgentForUser: jest.fn().mockResolvedValue([]),
        getSpendByAgentForUser: jest.fn().mockResolvedValue([]),
        getSpendByModelForUser: jest.fn().mockResolvedValue([]),
        getAgentNames: jest.fn().mockResolvedValue(new Map()),
        getTaskTitles: jest.fn().mockResolvedValue(new Map()),
        getDominantModelByRun: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<PluginUsageRepository>;
}

function agentRunRepositoryMock(): jest.Mocked<AgentRunRepository> {
    return {
        countRunsByAgentForUser: jest.fn().mockResolvedValue([]),
        findTopByCostForUser: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<AgentRunRepository>;
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
    return {
        id: 'run-1',
        agentId: 'agent-1',
        userId: USER,
        triggerKind: 'task',
        status: 'completed',
        costCents: 500,
        startedAt: new Date('2026-08-13T09:00:00.000Z'),
        taskId: null,
        workId: null,
        ...overrides,
    } as unknown as AgentRun;
}

describe('resolveCostsWindow', () => {
    it('defaults to 30 days when no window is supplied', () => {
        expect(resolveCostsWindow(undefined, NOW).windowDays).toBe(30);
    });

    it('rejects anything outside the 7/30/90 vocabulary', () => {
        for (const bad of [0, 1, 14, 31, 60, 365, -7, 7.5]) {
            expect(() => resolveCostsWindow(bad, NOW)).toThrow(InvalidCostsWindowError);
        }
    });

    it('snaps `from` to UTC midnight and ends the window at "now"', () => {
        const window = resolveCostsWindow(7, NOW);
        expect(window.from.toISOString()).toBe('2026-08-08T00:00:00.000Z');
        expect(window.to.toISOString()).toBe(NOW.toISOString());
    });

    it('a 7d window spans exactly 7 whole days including today', () => {
        // The off-by-one that would make a "7d" chart render 8 bars.
        const { from, to } = resolveCostsWindow(7, NOW);
        const wholeDaysElapsed = Math.floor(
            (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000),
        );
        expect(wholeDaysElapsed).toBe(6); // 6 whole days + the partial current day
        expect(from.toISOString().slice(0, 10)).toBe('2026-08-08');
        expect(to.toISOString().slice(0, 10)).toBe('2026-08-14');
    });

    it('scales the start date with the window length', () => {
        expect(resolveCostsWindow(30, NOW).from.toISOString().slice(0, 10)).toBe('2026-07-16');
        expect(resolveCostsWindow(90, NOW).from.toISOString().slice(0, 10)).toBe('2026-05-17');
    });
});

describe('CostsSummaryService', () => {
    let usage: jest.Mocked<PluginUsageRepository>;
    let runs: jest.Mocked<AgentRunRepository>;
    let service: CostsSummaryService;

    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(NOW);
        usage = pluginUsageRepositoryMock();
        runs = agentRunRepositoryMock();
        service = new CostsSummaryService(usage, runs);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('getSummary', () => {
        it('divides total spend by the run count', async () => {
            usage.getTotalSpendCentsForUser.mockResolvedValue(1234);
            usage.getUsageCountsForUser.mockResolvedValue({
                tasksCompleted: 3,
                worksActive: 2,
                agentRuns: 4,
            });

            const summary = await service.getSummary(USER, 7);

            expect(summary.totalCostCents).toBe(1234);
            expect(summary.runsCount).toBe(4);
            expect(summary.avgPerRunCents).toBe(309); // 1234 / 4 = 308.5 → 309
            expect(summary.windowDays).toBe(7);
            expect(summary.from).toBe('2026-08-08T00:00:00.000Z');
        });

        it('reports a zero average rather than NaN when there were no runs', async () => {
            usage.getTotalSpendCentsForUser.mockResolvedValue(900);

            const summary = await service.getSummary(USER);

            expect(summary.runsCount).toBe(0);
            expect(summary.avgPerRunCents).toBe(0);
        });

        it('scopes every read to the caller and the resolved window', async () => {
            await service.getSummary(USER, 90);

            const [userId, from, to] = usage.getTotalSpendCentsForUser.mock.calls[0];
            expect(userId).toBe(USER);
            expect(from.toISOString()).toBe('2026-05-17T00:00:00.000Z');
            expect(to.toISOString()).toBe(NOW.toISOString());
        });

        it('propagates a bad window as InvalidCostsWindowError', async () => {
            await expect(service.getSummary(USER, 45)).rejects.toBeInstanceOf(
                InvalidCostsWindowError,
            );
            expect(usage.getTotalSpendCentsForUser).not.toHaveBeenCalled();
        });
    });

    describe('getDaily', () => {
        it('emits a dense day axis so zero-spend days keep their slot', async () => {
            usage.getDailySpendByAgentForUser.mockResolvedValue([
                { day: '2026-08-08', agentId: 'a1', costCents: 100 },
                { day: '2026-08-14', agentId: 'a1', costCents: 50 },
            ]);

            const daily = await service.getDaily(USER, 7);

            expect(daily.days).toHaveLength(7);
            expect(daily.days.map((d) => d.day)).toEqual([
                '2026-08-08',
                '2026-08-09',
                '2026-08-10',
                '2026-08-11',
                '2026-08-12',
                '2026-08-13',
                '2026-08-14',
            ]);
            expect(daily.days[0]).toEqual({
                day: '2026-08-08',
                totalCostCents: 100,
                costs: { a1: 100 },
            });
            expect(daily.days[3]).toEqual({
                day: '2026-08-11',
                totalCostCents: 0,
                costs: {},
            });
        });

        it('sums several agents into one day total', async () => {
            usage.getDailySpendByAgentForUser.mockResolvedValue([
                { day: '2026-08-14', agentId: 'a1', costCents: 100 },
                { day: '2026-08-14', agentId: 'a2', costCents: 25 },
            ]);

            const daily = await service.getDaily(USER, 7);
            const today = daily.days.find((d) => d.day === '2026-08-14');

            expect(today?.totalCostCents).toBe(125);
            expect(today?.costs).toEqual({ a1: 100, a2: 25 });
        });

        it('gives unattributed spend its own series instead of dropping it', async () => {
            usage.getDailySpendByAgentForUser.mockResolvedValue([
                { day: '2026-08-14', agentId: null, costCents: 70 },
            ]);

            const daily = await service.getDaily(USER, 7);

            expect(daily.series).toEqual([
                { key: COSTS_UNATTRIBUTED_SERIES_KEY, label: null, costCents: 70 },
            ]);
            expect(daily.days.at(-1)?.costs).toEqual({ [COSTS_UNATTRIBUTED_SERIES_KEY]: 70 });
        });

        it('folds the tail past the series cap into one "other" series', async () => {
            const agents = Array.from({ length: COSTS_DAILY_MAX_SERIES + 3 }, (_, i) => ({
                day: '2026-08-14',
                // Descending cost so the fold boundary is unambiguous.
                agentId: `agent-${i}`,
                costCents: 1000 - i,
            }));
            usage.getDailySpendByAgentForUser.mockResolvedValue(agents);
            usage.getAgentNames.mockResolvedValue(
                new Map(agents.map((a) => [a.agentId, `Agent ${a.agentId}`])),
            );

            const daily = await service.getDaily(USER, 7);

            expect(daily.series).toHaveLength(COSTS_DAILY_MAX_SERIES + 1);
            const other = daily.series.at(-1);
            expect(other?.key).toBe(COSTS_OTHER_SERIES_KEY);
            // The three folded agents: 1000-6, 1000-7, 1000-8.
            expect(other?.costCents).toBe(994 + 993 + 992);
            // Folding must not lose money: the day total still matches.
            expect(daily.days.at(-1)?.totalCostCents).toBe(
                agents.reduce((sum, a) => sum + a.costCents, 0),
            );
        });

        it('orders series by window spend and resolves Agent names', async () => {
            usage.getDailySpendByAgentForUser.mockResolvedValue([
                { day: '2026-08-13', agentId: 'small', costCents: 10 },
                { day: '2026-08-14', agentId: 'big', costCents: 900 },
                { day: '2026-08-14', agentId: 'small', costCents: 5 },
            ]);
            usage.getAgentNames.mockResolvedValue(new Map([['big', 'Researcher']]));

            const daily = await service.getDaily(USER, 7);

            expect(daily.series.map((s) => s.key)).toEqual(['big', 'small']);
            expect(daily.series[0]).toEqual({ key: 'big', label: 'Researcher', costCents: 900 });
            // A deleted Agent keeps its series with an honest null label.
            expect(daily.series[1].label).toBeNull();
            expect(daily.series[1].costCents).toBe(15);
        });
    });

    describe('getByAgent', () => {
        it('joins spend to run counts and computes the per-run average', async () => {
            usage.getSpendByAgentForUser.mockResolvedValue([
                { key: 'a1', units: 900, costCents: 1000 },
                { key: 'a2', units: 100, costCents: 300 },
            ]);
            runs.countRunsByAgentForUser.mockResolvedValue([
                { agentId: 'a1', runs: 4 },
                { agentId: 'a2', runs: 3 },
            ]);
            usage.getAgentNames.mockResolvedValue(new Map([['a1', 'Researcher']]));

            const byAgent = await service.getByAgent(USER, 30);

            expect(byAgent.rows[0]).toEqual({
                agentId: 'a1',
                name: 'Researcher',
                costCents: 1000,
                runs: 4,
                avgPerRunCents: 250,
            });
            // Deleted Agent → honest null name, never a fabricated label.
            expect(byAgent.rows[1].name).toBeNull();
            expect(byAgent.rows[1].avgPerRunCents).toBe(100);
        });

        it('keeps the unattributed row at zero runs rather than borrowing a count', async () => {
            usage.getSpendByAgentForUser.mockResolvedValue([
                { key: null, units: 5, costCents: 80 },
            ]);
            runs.countRunsByAgentForUser.mockResolvedValue([{ agentId: 'a1', runs: 9 }]);

            const byAgent = await service.getByAgent(USER, 30);

            expect(byAgent.rows[0]).toEqual({
                agentId: null,
                name: null,
                costCents: 80,
                runs: 0,
                avgPerRunCents: 0,
            });
        });

        it('shows an Agent that ran but recorded no metered spend as zero, not missing', async () => {
            usage.getSpendByAgentForUser.mockResolvedValue([{ key: 'a1', units: 0, costCents: 0 }]);
            runs.countRunsByAgentForUser.mockResolvedValue([{ agentId: 'a1', runs: 2 }]);

            const byAgent = await service.getByAgent(USER, 7);

            expect(byAgent.rows[0].runs).toBe(2);
            expect(byAgent.rows[0].avgPerRunCents).toBe(0);
        });

        it('exposes no cache-hit field — the metering path records no cached tokens', async () => {
            usage.getSpendByAgentForUser.mockResolvedValue([
                { key: 'a1', units: 10, costCents: 100 },
            ]);

            const byAgent = await service.getByAgent(USER, 7);

            expect(Object.keys(byAgent.rows[0]).sort()).toEqual([
                'agentId',
                'avgPerRunCents',
                'costCents',
                'name',
                'runs',
            ]);
        });
    });

    describe('getByModel', () => {
        it('computes each share against the sum of the returned rows', async () => {
            usage.getSpendByModelForUser.mockResolvedValue([
                { key: 'claude-opus-5', units: 900, costCents: 750 },
                { key: 'gpt-5-mini', units: 400, costCents: 250 },
            ]);

            const byModel = await service.getByModel(USER, 30);

            expect(byModel.totalCostCents).toBe(1000);
            expect(byModel.rows.map((r) => r.sharePercent)).toEqual([75, 25]);
            expect(byModel.rows[0].modelId).toBe('claude-opus-5');
        });

        it('rounds shares to one decimal and never emits NaN on an empty window', async () => {
            usage.getSpendByModelForUser.mockResolvedValue([
                { key: 'a', units: 1, costCents: 1 },
                { key: 'b', units: 1, costCents: 2 },
            ]);
            expect((await service.getByModel(USER, 7)).rows.map((r) => r.sharePercent)).toEqual([
                33.3, 66.7,
            ]);

            usage.getSpendByModelForUser.mockResolvedValue([{ key: 'a', units: 0, costCents: 0 }]);
            const zero = await service.getByModel(USER, 7);
            expect(zero.totalCostCents).toBe(0);
            expect(zero.rows[0].sharePercent).toBe(0);
        });

        it('keeps the null-model bucket — search/screenshot calls have no model', async () => {
            usage.getSpendByModelForUser.mockResolvedValue([
                { key: null, units: 12, costCents: 40 },
                { key: 'gpt-5', units: 3, costCents: 60 },
            ]);

            const byModel = await service.getByModel(USER, 7);

            expect(byModel.rows.map((r) => r.modelId)).toEqual([null, 'gpt-5']);
            expect(byModel.rows[0].sharePercent).toBe(40);
        });
    });

    describe('getTopRuns', () => {
        it('enriches each run with its Agent, Task and dominant model', async () => {
            runs.findTopByCostForUser.mockResolvedValue([
                run({ id: 'r1', agentId: 'a1', taskId: 't1', workId: 'w1', costCents: 900 }),
                run({ id: 'r2', agentId: 'a2', taskId: null, costCents: 400 }),
            ]);
            usage.getAgentNames.mockResolvedValue(
                new Map([
                    ['a1', 'Researcher'],
                    ['a2', 'Writer'],
                ]),
            );
            usage.getTaskTitles.mockResolvedValue(new Map([['t1', 'Refresh the catalog']]));
            usage.getDominantModelByRun.mockResolvedValue(new Map([['r1', 'claude-opus-5']]));

            const top = await service.getTopRuns(USER, 30);

            expect(top.rows[0]).toEqual({
                runId: 'r1',
                costCents: 900,
                agentId: 'a1',
                agentName: 'Researcher',
                taskId: 't1',
                taskTitle: 'Refresh the catalog',
                modelId: 'claude-opus-5',
                status: 'completed',
                triggerKind: 'task',
                startedAt: '2026-08-13T09:00:00.000Z',
            });
            // A run whose events carry no model id stays listed, unlabelled.
            expect(top.rows[1].modelId).toBeNull();
            expect(top.rows[1].taskTitle).toBeNull();
        });

        it('resolves names with ONE batched lookup per dimension, never per row', async () => {
            runs.findTopByCostForUser.mockResolvedValue([
                run({ id: 'r1', agentId: 'a1', taskId: 't1' }),
                run({ id: 'r2', agentId: 'a1', taskId: 't2' }),
                run({ id: 'r3', agentId: 'a2', taskId: null }),
            ]);

            await service.getTopRuns(USER, 30);

            expect(usage.getAgentNames).toHaveBeenCalledTimes(1);
            // Deduplicated: `a1` appears twice in the rows, once in the query.
            expect(usage.getAgentNames).toHaveBeenCalledWith(['a1', 'a2']);
            expect(usage.getTaskTitles).toHaveBeenCalledWith(['t1', 't2']);
            expect(usage.getDominantModelByRun).toHaveBeenCalledWith(['r1', 'r2', 'r3']);
        });

        it('clamps the limit into 1..max and falls back to the default on junk', async () => {
            await service.getTopRuns(USER, 30, 999);
            expect(runs.findTopByCostForUser.mock.calls[0][3]).toBe(COSTS_TOP_RUNS_MAX_LIMIT);

            await service.getTopRuns(USER, 30, 0);
            expect(runs.findTopByCostForUser.mock.calls[1][3]).toBe(20);

            await service.getTopRuns(USER, 30, Number.NaN);
            expect(runs.findTopByCostForUser.mock.calls[2][3]).toBe(20);
        });

        it('does not query names at all for an empty window', async () => {
            const top = await service.getTopRuns(USER, 7);

            expect(top.rows).toEqual([]);
            expect(usage.getAgentNames).toHaveBeenCalledWith([]);
            expect(usage.getTaskTitles).toHaveBeenCalledWith([]);
        });
    });
});
