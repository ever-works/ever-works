jest.mock('@ever-works/agent/budgets', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    User: class {},
    Work: class {},
}));
jest.mock('@src/auth/guards/platform-admin.guard', () => ({
    IsPlatformAdminGuard: class {},
}));

import { BadRequestException } from '@nestjs/common';
import { AdminUsageController } from './admin-usage.controller';
import type { BudgetService } from '@ever-works/agent/budgets';
import type { PluginUsageRepository } from '@ever-works/agent/database';

/**
 * EW-602 — AdminUsageController surfaces cross-user × cross-Work spend
 * for the self-hosted platform owner. The IsPlatformAdminGuard handles
 * authentication; this controller is responsible for:
 *   - parsing the period (current | YYYY-MM)
 *   - fetching the aggregated usage rows
 *   - hydrating user + work names in two batched queries (no N+1)
 *   - falling back to ids when the joined rows are missing
 *   - summing totalSpendCents across all rows
 */

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
        getCrossUserSpend: jest.fn().mockResolvedValue([]),
        ...(overrides.usageRepository ?? {}),
    } as unknown as jest.Mocked<PluginUsageRepository>;

    const userRepository = {
        find: jest.fn().mockResolvedValue([]),
        ...(overrides.userRepository ?? {}),
    } as any;

    const workRepository = {
        find: jest.fn().mockResolvedValue([]),
        ...(overrides.workRepository ?? {}),
    } as any;

    const controller = new AdminUsageController(
        budgetService,
        usageRepository,
        userRepository,
        workRepository,
    );
    return { controller, budgetService, usageRepository, userRepository, workRepository };
}

describe('AdminUsageController.list', () => {
    it('returns empty rows + totalSpend=0 when no usage in the period', async () => {
        const { controller, userRepository, workRepository } = makeDeps();
        const result = await controller.list('current');
        expect(result.rows).toEqual([]);
        expect(result.totalSpendCents).toBe(0);
        // No ids to look up → repos must NOT be called (no empty IN-list query)
        expect(userRepository.find).not.toHaveBeenCalled();
        expect(workRepository.find).not.toHaveBeenCalled();
    });

    it('hydrates username + workName and sums totalSpend across rows', async () => {
        const usageRows = [
            { userId: 'u1', workId: 'w1', units: 5, costCents: 1500 },
            { userId: 'u2', workId: 'w2', units: 3, costCents: 700 },
        ];
        const users = [
            { id: 'u1', username: 'alice', email: 'alice@x.com' },
            { id: 'u2', username: 'bob', email: 'bob@x.com' },
        ];
        const works = [
            { id: 'w1', name: 'Alice Site' },
            { id: 'w2', name: 'Bob Directory' },
        ];
        const { controller } = makeDeps({
            usageRepository: { getCrossUserSpend: jest.fn().mockResolvedValue(usageRows) },
            userRepository: { find: jest.fn().mockResolvedValue(users) },
            workRepository: { find: jest.fn().mockResolvedValue(works) },
        });

        const result = await controller.list('current');
        expect(result.totalSpendCents).toBe(2200);
        expect(result.rows).toEqual([
            {
                userId: 'u1',
                username: 'alice',
                email: 'alice@x.com',
                workId: 'w1',
                workName: 'Alice Site',
                units: 5,
                costCents: 1500,
            },
            {
                userId: 'u2',
                username: 'bob',
                email: 'bob@x.com',
                workId: 'w2',
                workName: 'Bob Directory',
                units: 3,
                costCents: 700,
            },
        ]);
    });

    it('falls back to id when the user/work join row is missing', async () => {
        const { controller } = makeDeps({
            usageRepository: {
                getCrossUserSpend: jest
                    .fn()
                    .mockResolvedValue([
                        { userId: 'u-ghost', workId: 'w-ghost', units: 1, costCents: 100 },
                    ]),
            },
            userRepository: { find: jest.fn().mockResolvedValue([]) },
            workRepository: { find: jest.fn().mockResolvedValue([]) },
        });
        const result = await controller.list('current');
        expect(result.rows[0]).toEqual({
            userId: 'u-ghost',
            username: 'u-ghost',
            email: null,
            workId: 'w-ghost',
            workName: 'w-ghost',
            units: 1,
            costCents: 100,
        });
    });

    it('deduplicates user/work ids before hydrating (no duplicate IN-list)', async () => {
        const { controller, userRepository, workRepository } = makeDeps({
            usageRepository: {
                getCrossUserSpend: jest.fn().mockResolvedValue([
                    { userId: 'u1', workId: 'w1', units: 1, costCents: 100 },
                    { userId: 'u1', workId: 'w2', units: 1, costCents: 200 },
                    { userId: 'u2', workId: 'w1', units: 1, costCents: 300 },
                ]),
            },
        });
        await controller.list('current');
        const userArgs = (userRepository.find as jest.Mock).mock.calls[0][0];
        const workArgs = (workRepository.find as jest.Mock).mock.calls[0][0];
        // The In() helper wraps the de-duped array — assert via _value/_type sniffing.
        const userIdsArg = (userArgs.where.id as any)?._value ?? userArgs.where.id;
        const workIdsArg = (workArgs.where.id as any)?._value ?? workArgs.where.id;
        expect(Array.isArray(userIdsArg) ? userIdsArg.sort() : userIdsArg).toEqual(['u1', 'u2']);
        expect(Array.isArray(workIdsArg) ? workIdsArg.sort() : workIdsArg).toEqual(['w1', 'w2']);
    });

    it('parses YYYY-MM period and uses Date.UTC boundaries (half-open)', async () => {
        const { controller, usageRepository } = makeDeps();
        const result = await controller.list('2026-03');
        expect(result.periodStart).toBe('2026-03-01T00:00:00.000Z');
        expect(result.periodEnd).toBe('2026-04-01T00:00:00.000Z');
        expect(usageRepository.getCrossUserSpend).toHaveBeenCalledWith(
            new Date('2026-03-01T00:00:00.000Z'),
            new Date('2026-04-01T00:00:00.000Z'),
        );
    });

    it('rolls year boundary on YYYY-12 to next-year January', async () => {
        const { controller } = makeDeps();
        const result = await controller.list('2026-12');
        expect(result.periodStart).toBe('2026-12-01T00:00:00.000Z');
        expect(result.periodEnd).toBe('2027-01-01T00:00:00.000Z');
    });

    it('throws BadRequestException for malformed period strings', async () => {
        const { controller } = makeDeps();
        await expect(controller.list('not-a-date')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException for out-of-range months', async () => {
        const { controller } = makeDeps();
        await expect(controller.list('2026-13')).rejects.toBeInstanceOf(BadRequestException);
        await expect(controller.list('2026-00')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('uses BudgetService boundaries for the default ("current") window', async () => {
        const { controller, budgetService } = makeDeps();
        await controller.list(undefined);
        expect(budgetService.getCurrentPeriodStart).toHaveBeenCalled();
        expect(budgetService.getNextPeriodStart).toHaveBeenCalled();
    });
});
