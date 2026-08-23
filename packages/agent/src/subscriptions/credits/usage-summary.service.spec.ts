import {
    InvalidUsagePeriodError,
    resolveUsageSummaryWindow,
    USAGE_EXPORT_COLUMNS,
    UsageSummaryService,
} from './usage-summary.service';
import type { CreditLedgerRepository } from '@src/database/repositories/credit-ledger.repository';
import type { PluginUsageRepository } from '@src/database/repositories/plugin-usage.repository';
import { BudgetOwnerType } from '@src/entities/_types';
import type { PluginUsageEvent } from '@src/entities/plugin-usage-event.entity';

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
            | 'findPageForUserExport'
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
            findPageForUserExport: jest.fn().mockResolvedValue([]),
        } as any;
        creditLedgerRepository = {
            getBalance: jest.fn().mockResolvedValue(500),
            getPeriodTotals: jest
                .fn()
                .mockResolvedValue({ consumedCredits: 260, addedCredits: 300, expiredCredits: 40 }),
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
            creditsExpired: 40,
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

    describe('createExport (B29 — account-wide CSV export)', () => {
        // Typed as the real entity so the fixture cannot drift away
        // from it silently — the previous untyped literal is exactly
        // how it ended up missing four required columns.
        function event(overrides: Partial<PluginUsageEvent> = {}): PluginUsageEvent {
            return {
                id: 'evt-1',
                occurredAt: new Date('2026-06-04T10:00:00.000Z'),
                pluginId: 'openrouter',
                capability: 'ai',
                units: 2,
                costCents: 31,
                currency: 'usd',
                modelId: 'model-a',
                workId: 'work-1',
                // Owner columns + the two relations the entity declares.
                // The export reads none of them, but `PluginUsageEvent`
                // requires them, so a fixture without them does not
                // typecheck — and an untyped fixture would stop pinning
                // that the export omits exactly these.
                userId: 'user-1',
                ownerType: BudgetOwnerType.WORK,
                work: null as never,
                user: null as never,
                agentId: null,
                taskId: null,
                runId: null,
                requestId: 'req-1',
                // Scope + free-form columns that must NOT reach the wire.
                tenantId: 'tenant-1',
                organizationId: 'org-a',
                metadata: { secret: 'nope' },
                ...overrides,
            } as PluginUsageEvent;
        }

        async function drain(chunks: AsyncIterable<unknown[]>) {
            const rows: unknown[] = [];
            for await (const chunk of chunks) {
                rows.push(...chunk);
            }
            return rows;
        }

        it('passes the active organizationId into every repository page (org scope)', async () => {
            pluginUsageRepository.findPageForUserExport.mockResolvedValue([event()]);

            const stream = service.createExport('user-1', {
                period: '2026-06',
                organizationId: 'org-a',
            });
            await drain(stream.chunks);

            expect(stream.organizationId).toBe('org-a');
            expect(pluginUsageRepository.findPageForUserExport).toHaveBeenCalledWith(
                'user-1',
                new Date('2026-06-01T00:00:00.000Z'),
                new Date('2026-07-01T00:00:00.000Z'),
                expect.objectContaining({ organizationId: 'org-a' }),
            );
        });

        it('passes organizationId: null when the request has no active Organization', async () => {
            pluginUsageRepository.findPageForUserExport.mockResolvedValue([]);

            const stream = service.createExport('user-1', { period: '2026-06' });
            await drain(stream.chunks);

            expect(stream.organizationId).toBeNull();
            expect(pluginUsageRepository.findPageForUserExport).toHaveBeenCalledWith(
                'user-1',
                expect.any(Date),
                expect.any(Date),
                expect.objectContaining({ organizationId: null }),
            );
        });

        it('a YYYY-MM period returns THAT month rows (half-open UTC window)', async () => {
            pluginUsageRepository.findPageForUserExport.mockResolvedValue([
                event({ occurredAt: new Date('2026-06-01T00:00:00.000Z') }),
                event({ id: 'evt-2', occurredAt: new Date('2026-06-30T23:59:59.000Z') }),
            ]);

            const stream = service.createExport('user-1', { period: '2026-06' });
            const rows = (await drain(stream.chunks)) as { occurredAt: string }[];

            expect(stream.window).toMatchObject({ period: '2026-06' });
            expect(stream.window.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
            expect(stream.window.to.toISOString()).toBe('2026-07-01T00:00:00.000Z');
            expect(rows.map((r) => r.occurredAt)).toEqual([
                '2026-06-01T00:00:00.000Z',
                '2026-06-30T23:59:59.000Z',
            ]);
        });

        it('projects only the wire columns — scope + metadata never leave the service', async () => {
            pluginUsageRepository.findPageForUserExport.mockResolvedValue([event()]);

            const [row] = (await drain(
                service.createExport('user-1', { period: '2026-06' }).chunks,
            )) as Record<string, unknown>[];

            expect(Object.keys(row).sort()).toEqual([...USAGE_EXPORT_COLUMNS].sort());
            expect(row).not.toHaveProperty('tenantId');
            expect(row).not.toHaveProperty('organizationId');
            expect(row).not.toHaveProperty('metadata');
        });

        it('pages until a short page arrives — never buffers the whole period', async () => {
            pluginUsageRepository.findPageForUserExport
                .mockResolvedValueOnce([event(), event({ id: 'evt-2' })])
                .mockResolvedValueOnce([event({ id: 'evt-3' })]);

            const rows = await drain(
                service.createExport('user-1', { period: '2026-06', pageSize: 2 }).chunks,
            );

            expect(rows).toHaveLength(3);
            expect(pluginUsageRepository.findPageForUserExport).toHaveBeenNthCalledWith(
                1,
                'user-1',
                expect.any(Date),
                expect.any(Date),
                { organizationId: null, limit: 2, offset: 0 },
            );
            expect(pluginUsageRepository.findPageForUserExport).toHaveBeenNthCalledWith(
                2,
                'user-1',
                expect.any(Date),
                expect.any(Date),
                { organizationId: null, limit: 2, offset: 2 },
            );
        });

        it('stops immediately on an empty first page (no runaway paging)', async () => {
            pluginUsageRepository.findPageForUserExport.mockResolvedValue([]);

            const rows = await drain(service.createExport('user-1').chunks);

            expect(rows).toHaveLength(0);
            expect(pluginUsageRepository.findPageForUserExport).toHaveBeenCalledTimes(1);
        });

        it('clamps an absurd page size and rejects a malformed period up front', async () => {
            pluginUsageRepository.findPageForUserExport.mockResolvedValue([]);

            await drain(service.createExport('user-1', { pageSize: 10_000_000 }).chunks);
            expect(pluginUsageRepository.findPageForUserExport).toHaveBeenCalledWith(
                'user-1',
                expect.any(Date),
                expect.any(Date),
                expect.objectContaining({ limit: 5000 }),
            );

            pluginUsageRepository.findPageForUserExport.mockClear();
            expect(() => service.createExport('user-1', { period: 'nope' })).toThrow(
                InvalidUsagePeriodError,
            );
            expect(pluginUsageRepository.findPageForUserExport).not.toHaveBeenCalled();
        });
    });
});
