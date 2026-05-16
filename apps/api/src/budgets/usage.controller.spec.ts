jest.mock('@ever-works/agent/budgets', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsageController } from './usage.controller';
import type { BudgetService } from '@ever-works/agent/budgets';
import type {
    PluginUsageRepository,
    WorkBudgetRepository,
    WorkRepository,
    WorkMemberRepository,
} from '@ever-works/agent/database';

/**
 * EW-602 — UsageController exposes the read-side surface for the
 * per-Work budgets UI:
 *   - GET /works/:id/usage/summary
 *   - GET /works/:id/usage/trend
 *   - GET /works/:id/usage/export?format=csv
 *
 * All endpoints are gated by assertReadAccess (owner OR member) and
 * accept a `?period=current|YYYY-MM` parameter parsed by
 * resolvePeriodWindow.
 */

function makeAuth(userId = 'user-1') {
    return { userId, email: 'u@example.com' } as any;
}

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
    const budgetService = {
        getCurrentPeriodStart: jest.fn(
            (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        ),
        getNextPeriodStart: jest.fn(
            (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
        ),
        ...(overrides.budgetService ?? {}),
    } as unknown as jest.Mocked<BudgetService>;

    const usageRepository = {
        record: jest.fn(),
        getTotalSpendCents: jest.fn().mockResolvedValue(0),
        getSpendByPlugin: jest.fn().mockResolvedValue([]),
        getDailySpend: jest.fn().mockResolvedValue([]),
        getCrossUserSpend: jest.fn(),
        findForExport: jest.fn().mockResolvedValue([]),
        pruneOlderThan: jest.fn(),
        ...(overrides.usageRepository ?? {}),
    } as unknown as jest.Mocked<PluginUsageRepository>;

    const budgetRepository = {
        findGlobal: jest.fn().mockResolvedValue(null),
        findForPlugin: jest.fn(),
        findAllForWork: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        ...(overrides.budgetRepository ?? {}),
    } as unknown as jest.Mocked<WorkBudgetRepository>;

    const workRepository = {
        findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'user-1' }),
        ...(overrides.workRepository ?? {}),
    } as unknown as jest.Mocked<WorkRepository>;

    const workMemberRepository = {
        isMember: jest.fn().mockResolvedValue(false),
        hasRole: jest.fn(),
        ...(overrides.workMemberRepository ?? {}),
    } as unknown as jest.Mocked<WorkMemberRepository>;

    const controller = new UsageController(
        budgetService,
        usageRepository,
        budgetRepository,
        workRepository,
        workMemberRepository,
    );

    return {
        controller,
        budgetService,
        usageRepository,
        budgetRepository,
        workRepository,
        workMemberRepository,
    };
}

describe('UsageController.getSummary', () => {
    it('throws NotFoundException when the work does not exist', async () => {
        const { controller } = makeDeps({
            workRepository: { findById: jest.fn().mockResolvedValue(null) },
        });
        await expect(controller.getSummary(makeAuth(), 'work-1', 'current')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('throws ForbiddenException when caller is not owner and not a member', async () => {
        const { controller } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'someone-else' }),
            },
            workMemberRepository: { isMember: jest.fn().mockResolvedValue(false) },
        });
        await expect(
            controller.getSummary(makeAuth('user-1'), 'work-1', 'current'),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows access for a Work member who is not the owner', async () => {
        const { controller, usageRepository } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'someone-else' }),
            },
            workMemberRepository: { isMember: jest.fn().mockResolvedValue(true) },
        });
        const result = await controller.getSummary(makeAuth('user-1'), 'work-1', 'current');
        expect(result.workId).toBe('work-1');
        expect(usageRepository.getTotalSpendCents).toHaveBeenCalled();
    });

    it('returns totals and per-plugin breakdown with currency from globalBudget when present', async () => {
        const { controller, usageRepository, budgetRepository } = makeDeps({
            usageRepository: {
                getTotalSpendCents: jest.fn().mockResolvedValue(2500),
                getSpendByPlugin: jest.fn().mockResolvedValue([
                    { pluginId: 'openai', capability: 'ai', units: 100, costCents: 1500 },
                    { pluginId: 'tavily', capability: 'search', units: 5, costCents: 1000 },
                ]),
            },
            budgetRepository: {
                findGlobal: jest.fn().mockResolvedValue({
                    id: 'b1',
                    monthlyCapCents: 10_000,
                    allowOverage: false,
                    currency: 'eur',
                }),
            },
        });

        const result = await controller.getSummary(makeAuth('user-1'), 'work-1', 'current');

        expect(result.currency).toBe('eur');
        expect(result.totalSpendCents).toBe(2500);
        expect(result.perPlugin).toEqual([
            { pluginId: 'openai', capability: 'ai', units: 100, costCents: 1500 },
            { pluginId: 'tavily', capability: 'search', units: 5, costCents: 1000 },
        ]);
        expect(result.globalBudget).toEqual({
            id: 'b1',
            monthlyCapCents: 10_000,
            allowOverage: false,
            currency: 'eur',
            percentUsed: 25,
        });
        expect(usageRepository.getTotalSpendCents).toHaveBeenCalledWith(
            'work-1',
            expect.any(Date),
            expect.any(Date),
        );
        expect(budgetRepository.findGlobal).toHaveBeenCalledWith('work-1');
    });

    it('defaults currency to "usd" and globalBudget to null when no budget configured', async () => {
        const { controller } = makeDeps({
            budgetRepository: { findGlobal: jest.fn().mockResolvedValue(null) },
        });
        const result = await controller.getSummary(makeAuth(), 'work-1', 'current');
        expect(result.currency).toBe('usd');
        expect(result.globalBudget).toBeNull();
    });

    it('returns percentUsed = 0 when monthlyCapCents is 0 (no division by zero)', async () => {
        const { controller } = makeDeps({
            usageRepository: { getTotalSpendCents: jest.fn().mockResolvedValue(500) },
            budgetRepository: {
                findGlobal: jest.fn().mockResolvedValue({
                    id: 'b1',
                    monthlyCapCents: 0,
                    allowOverage: true,
                    currency: 'usd',
                }),
            },
        });
        const result = await controller.getSummary(makeAuth(), 'work-1', 'current');
        expect(result.globalBudget?.percentUsed).toBe(0);
    });

    it('parses YYYY-MM period and uses Date.UTC boundaries', async () => {
        const { controller } = makeDeps();
        const result = await controller.getSummary(makeAuth(), 'work-1', '2026-03');
        expect(result.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(result.periodEnd).toBe('2026-04-01T00:00:00.000Z');
    });

    it('rolls year boundary on YYYY-12 → next year January end', async () => {
        const { controller } = makeDeps();
        const result = await controller.getSummary(makeAuth(), 'work-1', '2026-12');
        expect(result.periodStart).toBe('2026-12-01T00:00:00.000Z');
        expect(result.periodEnd).toBe('2027-01-01T00:00:00.000Z');
    });

    it('throws BadRequestException for invalid period strings', async () => {
        const { controller } = makeDeps();
        await expect(
            controller.getSummary(makeAuth(), 'work-1', 'not-a-period'),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException for out-of-range months (00, 13)', async () => {
        const { controller } = makeDeps();
        await expect(controller.getSummary(makeAuth(), 'work-1', '2026-13')).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(controller.getSummary(makeAuth(), 'work-1', '2026-00')).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });
});

describe('UsageController.getTrend', () => {
    it('returns daily buckets with granularity=day', async () => {
        const buckets = [
            { day: '2026-05-01', costCents: 100 },
            { day: '2026-05-02', costCents: 250 },
        ];
        const { controller } = makeDeps({
            usageRepository: { getDailySpend: jest.fn().mockResolvedValue(buckets) },
        });
        const result = await controller.getTrend(makeAuth(), 'work-1', 'current', 'day');
        expect(result.granularity).toBe('day');
        expect(result.buckets).toEqual(buckets);
    });

    it('rejects unsupported granularity', async () => {
        const { controller } = makeDeps();
        await expect(
            controller.getTrend(makeAuth(), 'work-1', 'current', 'hour'),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts undefined granularity (defaults to day)', async () => {
        const { controller } = makeDeps();
        const result = await controller.getTrend(makeAuth(), 'work-1', 'current', undefined);
        expect(result.granularity).toBe('day');
    });
});

describe('UsageController.exportCsv', () => {
    function makeRes() {
        const headers: Record<string, string> = {};
        let sentBody: string | Buffer | undefined;
        return {
            res: {
                setHeader: (name: string, value: string) => {
                    headers[name] = value;
                },
                send: (body: string | Buffer) => {
                    sentBody = body;
                },
            },
            getHeaders: () => headers,
            getBody: () => sentBody,
        };
    }

    it('rejects unsupported format other than csv', async () => {
        const { controller } = makeDeps();
        const { res } = makeRes();
        await expect(
            controller.exportCsv(makeAuth(), 'work-1', res, 'current', 'xlsx'),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('writes the CSV header + a single row, with proper Content-Type and filename', async () => {
        const occurredAt = new Date('2026-05-15T10:00:00Z');
        const { controller } = makeDeps({
            usageRepository: {
                findForExport: jest.fn().mockResolvedValue([
                    {
                        occurredAt,
                        pluginId: 'openai',
                        capability: 'ai',
                        units: 1,
                        costCents: 250,
                        currency: 'usd',
                        modelId: 'gpt-4',
                        requestId: 'req-1',
                    },
                ]),
            },
        });
        const { res, getHeaders, getBody } = makeRes();
        await controller.exportCsv(makeAuth(), 'work-1', res, 'current');

        const headers = getHeaders();
        expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
        expect(headers['Content-Disposition']).toMatch(
            /attachment; filename="usage-work-1-\d{4}-\d{2}\.csv"/,
        );
        const body = getBody() as string;
        const lines = body.split('\n');
        expect(lines[0]).toBe(
            'occurredAt,pluginId,capability,units,costCents,currency,modelId,requestId',
        );
        expect(lines[1]).toBe(`${occurredAt.toISOString()},openai,ai,1,250,usd,gpt-4,req-1`);
    });

    it('escapes commas, quotes, and newlines in CSV fields per RFC 4180', async () => {
        const { controller } = makeDeps({
            usageRepository: {
                findForExport: jest.fn().mockResolvedValue([
                    {
                        occurredAt: new Date('2026-05-15T10:00:00Z'),
                        pluginId: 'plug,with,commas',
                        capability: 'ai',
                        units: 1,
                        costCents: 100,
                        currency: 'usd',
                        modelId: 'name "with" quotes',
                        requestId: 'has\nnewline',
                    },
                ]),
            },
        });
        const { res, getBody } = makeRes();
        await controller.exportCsv(makeAuth(), 'work-1', res, 'current');
        const body = getBody() as string;
        // Comma in pluginId → quoted
        expect(body).toContain('"plug,with,commas"');
        // Embedded quotes → doubled
        expect(body).toContain('"name ""with"" quotes"');
        // Newline in requestId → quoted
        expect(body).toContain('"has\nnewline"');
    });

    it('emits empty values for null/undefined cells', async () => {
        const { controller } = makeDeps({
            usageRepository: {
                findForExport: jest.fn().mockResolvedValue([
                    {
                        occurredAt: new Date('2026-05-15T10:00:00Z'),
                        pluginId: 'openai',
                        capability: 'ai',
                        units: 0,
                        costCents: 0,
                        currency: 'usd',
                        modelId: null,
                        requestId: null,
                    },
                ]),
            },
        });
        const { res, getBody } = makeRes();
        await controller.exportCsv(makeAuth(), 'work-1', res, 'current');
        const body = getBody() as string;
        const dataRow = body.split('\n')[1];
        // Trailing two empty fields for modelId + requestId
        expect(dataRow.endsWith(',,')).toBe(true);
    });

    it('blocks non-members from exporting (assertReadAccess runs first)', async () => {
        const { controller } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'someone-else' }),
            },
            workMemberRepository: { isMember: jest.fn().mockResolvedValue(false) },
        });
        const { res } = makeRes();
        await expect(
            controller.exportCsv(makeAuth('user-1'), 'work-1', res, 'current'),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });
});
