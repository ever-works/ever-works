import { BREAKDOWN_EVERYTHING_ELSE_KEY } from '@ever-works/contracts';
import type { AgentRunStatus } from '@src/entities/agent-run.entity';
import { CostsSummaryService, InvalidCostsWindowError } from './costs-summary.service';

/**
 * AW-17 — the three new Costs sections (by tool, by Mission, by meter) and
 * the meter split on a run receipt, all produced by the Costs dashboard's
 * own service from the same usage rows — no second read model.
 */
describe('CostsSummaryService — meters and breakdowns (AW-17)', () => {
    let usage: Record<string, jest.Mock>;
    let service: CostsSummaryService;

    beforeEach(() => {
        usage = {
            getSpendByPriceKeyForUser: jest.fn().mockResolvedValue([
                { key: 'search.query', capability: 'search', calls: 5, costCents: 5, credits: 10 },
                { key: 'ai.managed', capability: 'ai', calls: 2, costCents: 40, credits: 54 },
            ]),
            getSpendByMissionForUser: jest.fn().mockResolvedValue([
                { key: 'mission-1', capability: 'ai', calls: 4, costCents: 30, credits: 41 },
                { key: null, capability: 'search', calls: 3, costCents: 15, credits: 23 },
            ]),
            getMissionTitles: jest
                .fn()
                .mockResolvedValue(new Map([['mission-1', 'Weekly market scan']])),
            getSpendByMeterForUser: jest.fn().mockResolvedValue([
                {
                    meter: 'credits',
                    outcome: 'ok',
                    payer: 'platform',
                    calls: 7,
                    costCents: 45,
                    credits: 64,
                },
                { meter: null, outcome: null, payer: null, calls: 2, costCents: 12, credits: 0 },
            ]),
            getRunSpendLines: jest.fn().mockResolvedValue([]),
            getRunMeterLines: jest.fn().mockResolvedValue([]),
        };
        service = new CostsSummaryService(usage as never, {} as never);
    });

    it('by tool: ranked by credits, each row labelled with its capability, scoped to the caller', async () => {
        const result = await service.getByTool('user-1', 30);

        expect(usage.getSpendByPriceKeyForUser).toHaveBeenCalledWith(
            'user-1',
            expect.any(Date),
            expect.any(Date),
        );
        expect(result.dimension).toBe('tool');
        expect(result.windowDays).toBe(30);
        expect(result.totalCredits).toBe(64);
        expect(result.rows.map((row) => [row.key, row.label, row.credits])).toEqual([
            ['ai.managed', 'ai', 54],
            ['search.query', 'search', 10],
        ]);
        expect(result.rows[0].sharePercent).toBe(84.4);
    });

    it('by Mission: resolves titles in one read and keeps "Not in a Mission" as its own row', async () => {
        const result = await service.getByMission('user-1', 7);

        expect(usage.getMissionTitles).toHaveBeenCalledTimes(1);
        expect(usage.getMissionTitles).toHaveBeenCalledWith(['mission-1']);
        expect(result.dimension).toBe('mission');
        expect(result.rows).toEqual([
            expect.objectContaining({ key: 'mission-1', label: 'Weekly market scan', credits: 41 }),
            expect.objectContaining({ key: null, label: null, credits: 23 }),
        ]);
    });

    it('by Mission: never asks for a title for the folded tail', async () => {
        usage.getSpendByMissionForUser.mockResolvedValue(
            Array.from({ length: 12 }, (_, i) => ({
                key: `mission-${i}`,
                capability: 'ai',
                calls: 1,
                costCents: 1,
                credits: 20 - i,
            })),
        );

        const result = await service.getByMission('user-1', 30);

        const requested = usage.getMissionTitles.mock.calls[0][0] as string[];
        expect(requested).toHaveLength(10);
        expect(requested).not.toContain(BREAKDOWN_EVERYTHING_ELSE_KEY);
        expect(result.rows[10]).toMatchObject({ key: BREAKDOWN_EVERYTHING_ELSE_KEY, label: null });
        expect(result.foldedCount).toBe(2);
    });

    it('by Mission: full=true lists every Mission', async () => {
        usage.getSpendByMissionForUser.mockResolvedValue(
            Array.from({ length: 12 }, (_, i) => ({
                key: `mission-${i}`,
                capability: 'ai',
                calls: 1,
                costCents: 1,
                credits: 1,
            })),
        );

        const result = await service.getByMission('user-1', 30, { full: true });

        expect(result.rows).toHaveLength(12);
    });

    it('by meter: three meters plus the pre-meter residual, never folded together', async () => {
        const result = await service.getByMeter('user-1', 90);

        expect(result.meters.map((m) => [m.meter, m.calls, m.credits])).toEqual([
            ['model', 0, 0],
            ['credits', 7, 64],
            ['addon', 0, 0],
        ]);
        expect(result.meters[0].costCents).toBeNull();
        expect(result.preMeterResidual).toEqual({ calls: 2, costCents: 12 });
    });

    it('rejects a window outside the vocabulary', async () => {
        await expect(service.getByMeter('user-1', 31)).rejects.toBeInstanceOf(
            InvalidCostsWindowError,
        );
        await expect(service.getByTool('user-1', 31)).rejects.toBeInstanceOf(
            InvalidCostsWindowError,
        );
    });

    describe('getRunCostBreakdown — meters', () => {
        const run = {
            id: 'run-1',
            userId: 'user-1',
            status: 'running' as AgentRunStatus,
            costCents: null as number | null,
            totalTokens: null as number | null,
            createdAt: new Date('2026-09-13T09:00:00.000Z'),
        };
        const NOW = new Date('2026-09-13T10:00:00.000Z');

        it('splits the run by meter from the same rows', async () => {
            usage.getRunMeterLines.mockResolvedValue([
                {
                    meter: 'credits',
                    priceKey: 'search.query',
                    priceVersion: 1,
                    capability: 'search',
                    outcome: 'ok',
                    payer: 'platform',
                    calls: 2,
                    costCents: 2,
                    creditsCharged: 4,
                },
            ]);

            const breakdown = await service.getRunCostBreakdown(run, NOW);

            expect(usage.getRunMeterLines).toHaveBeenCalledWith('run-1');
            expect(breakdown.soFar).toBe(true);
            expect(breakdown.meters?.credits).toMatchObject({ calls: 2, credits: 4 });
            expect(breakdown.meters?.priceVersions).toEqual([1]);
        });

        it('reports meters as null when no rows are retained', async () => {
            const breakdown = await service.getRunCostBreakdown(run, NOW);
            expect(breakdown.meters).toBeNull();
        });

        it('omits meters (keeping every other figure) when the classified read fails', async () => {
            usage.getRunMeterLines.mockRejectedValue(new Error('column missing'));

            const breakdown = await service.getRunCostBreakdown(run, NOW);

            expect('meters' in breakdown).toBe(false);
            expect(breakdown.lines).toEqual([]);
        });
    });
});
