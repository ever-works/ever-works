import type { AgentRunStatus } from '@src/entities/agent-run.entity';
import { CostsSummaryService } from './costs-summary.service';

/**
 * Run receipt (AW-09) — `CostsSummaryService.getRunCostBreakdown`.
 *
 * The receipt's cost block is produced by the same service as the Costs
 * dashboard, from the same settlement stamp and usage rows. What is pinned
 * here is the honesty of each figure: null where nothing was measured,
 * "so far" while the run is open, credits only from this run's own debit,
 * and the 12-month detail retention flip.
 */
describe('CostsSummaryService.getRunCostBreakdown', () => {
    const NOW = new Date('2026-09-13T10:00:00.000Z');

    let usage: { getRunSpendLines: jest.Mock };
    let ledger: { findByIdempotencyKey: jest.Mock };
    let service: CostsSummaryService;

    const run = {
        id: 'run-1',
        userId: 'user-1',
        status: 'completed' as AgentRunStatus,
        costCents: 31 as number | null,
        totalTokens: 900 as number | null,
        createdAt: new Date('2026-09-13T09:00:00.000Z'),
    };

    beforeEach(() => {
        usage = {
            getRunSpendLines: jest.fn().mockResolvedValue([
                { capability: 'ai', modelId: 'model-a', calls: 3, units: 900, costCents: 29 },
                { capability: 'search', modelId: null, calls: 2, units: 2, costCents: 2 },
            ]),
        };
        ledger = {
            findByIdempotencyKey: jest
                .fn()
                .mockResolvedValue({ userId: 'user-1', amountCredits: -12 }),
        };
        service = new CostsSummaryService(usage as never, {} as never, ledger as never);
    });

    it('reports the settled stamp, the metered sum of the usage lines and the credits debited', async () => {
        const breakdown = await service.getRunCostBreakdown(run, NOW);

        expect(breakdown).toEqual({
            settledCents: 31,
            meteredCents: 31,
            soFar: false,
            creditsDebited: 12,
            detailRetained: true,
            tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: 900 },
            lines: [
                { capability: 'ai', modelId: 'model-a', calls: 3, units: 900, costCents: 29 },
                { capability: 'search', modelId: null, calls: 2, units: 2, costCents: 2 },
            ],
        });
        expect(usage.getRunSpendLines).toHaveBeenCalledWith('run-1');
        expect(ledger.findByIdempotencyKey).toHaveBeenCalledWith('run:run-1');
    });

    it('never turns "not measured" into zero', async () => {
        usage.getRunSpendLines.mockResolvedValue([]);
        ledger.findByIdempotencyKey.mockResolvedValue(null);

        const breakdown = await service.getRunCostBreakdown(
            { ...run, costCents: null, totalTokens: null },
            NOW,
        );

        expect(breakdown.settledCents).toBeNull();
        expect(breakdown.meteredCents).toBeNull();
        expect(breakdown.creditsDebited).toBeNull();
        expect(breakdown.tokens.total).toBeNull();
    });

    it('labels an open run as "so far"', async () => {
        const breakdown = await service.getRunCostBreakdown(
            { ...run, status: 'running' as AgentRunStatus, costCents: null },
            NOW,
        );

        expect(breakdown.soFar).toBe(true);
        expect(breakdown.settledCents).toBeNull();
        expect(breakdown.meteredCents).toBe(31);
    });

    it('ignores a ledger row that belongs to someone else', async () => {
        ledger.findByIdempotencyKey.mockResolvedValue({ userId: 'user-2', amountCredits: -99 });

        const breakdown = await service.getRunCostBreakdown(run, NOW);

        expect(breakdown.creditsDebited).toBeNull();
    });

    it('reports credits as not measured when the ledger is not wired', async () => {
        const unwired = new CostsSummaryService(usage as never, {} as never);

        const breakdown = await unwired.getRunCostBreakdown(run, NOW);

        expect(breakdown.creditsDebited).toBeNull();
        expect(breakdown.settledCents).toBe(31);
    });

    it('marks itemised detail as no longer retained past 12 months, keeping the settled total', async () => {
        usage.getRunSpendLines.mockResolvedValue([]);

        const old = await service.getRunCostBreakdown(
            { ...run, createdAt: new Date('2025-09-12T09:00:00.000Z') },
            NOW,
        );
        const recent = await service.getRunCostBreakdown(
            { ...run, createdAt: new Date('2025-09-14T09:00:00.000Z') },
            NOW,
        );

        expect(old.detailRetained).toBe(false);
        expect(old.settledCents).toBe(31);
        expect(recent.detailRetained).toBe(true);
    });
});
