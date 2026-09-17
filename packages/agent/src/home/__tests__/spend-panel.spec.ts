import type { UserBudgetSummary } from '../../budgets/budget.service';
import type { CostsSummary } from '../../subscriptions/credits/costs-summary.service';
import { HomeSpendBuilder, toHomeSpend } from '../builders/spend.builder';
import type { HomeBuildContext } from '../home-build-context';

const ORG_SCOPE = { tenantId: 'tenant-1', organizationId: 'org-acme' };
const PERSONAL_SCOPE = { tenantId: 'tenant-1', organizationId: null };

function summary(overrides: Partial<CostsSummary> = {}): CostsSummary {
    return {
        windowDays: 7,
        from: '2026-09-08T00:00:00.000Z',
        to: '2026-09-14T07:04:00.000Z',
        totalCostCents: 1842,
        runsCount: 61,
        avgPerRunCents: 30,
        ...overrides,
    };
}

function cap(overrides: Partial<UserBudgetSummary> = {}): UserBudgetSummary {
    return {
        userId: 'user-1',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        currentSpendCents: 3910,
        capCents: 5000,
        currency: 'usd',
        percentUsed: 78.2,
        allowOverage: true,
        blocked: false,
        ...overrides,
    };
}

describe('Home This-week panel', () => {
    it('pairs the scoped 7-day headline with the account-wide cap, never mixing them (S5)', () => {
        const spend = toHomeSpend({
            summary: summary(),
            accountCap: cap(),
            everRecordedUsage: true,
            scope: ORG_SCOPE,
        });
        expect(spend).toEqual({
            windowDays: 7,
            totalCents: 1842,
            currency: 'usd',
            runsCount: 61,
            avgPerRunCents: 30,
            scope: { kind: 'organization' },
            accountCap: {
                periodSpendCents: 3910,
                periodCapCents: 5000,
                percentUsed: 78.2,
                blocked: false,
                allowOverage: true,
            },
            everSpent: true,
        });
    });

    it('reports no average rather than zero when there were no runs', () => {
        const spend = toHomeSpend({
            summary: summary({ runsCount: 0, avgPerRunCents: 0, totalCostCents: 12 }),
            accountCap: cap(),
            everRecordedUsage: true,
            scope: PERSONAL_SCOPE,
        });
        expect(spend.avgPerRunCents).toBeNull();
        expect(spend.scope.kind).toBe('personal');
    });

    it('carries blocked and overage from the budget summary at and past the cap', () => {
        const blocked = toHomeSpend({
            summary: summary(),
            accountCap: cap({
                currentSpendCents: 5000,
                percentUsed: 100,
                blocked: true,
                allowOverage: false,
            }),
            everRecordedUsage: true,
            scope: ORG_SCOPE,
        });
        expect(blocked.accountCap).toMatchObject({
            percentUsed: 100,
            blocked: true,
            allowOverage: false,
        });

        const overage = toHomeSpend({
            summary: summary(),
            accountCap: cap({
                currentSpendCents: 6000,
                percentUsed: 120,
                blocked: false,
                allowOverage: true,
            }),
            everRecordedUsage: true,
            scope: ORG_SCOPE,
        });
        expect(overage.accountCap).toMatchObject({
            percentUsed: 120,
            blocked: false,
            allowOverage: true,
        });
    });

    it('reports no cap at all when none is set', () => {
        const spend = toHomeSpend({
            summary: summary(),
            accountCap: cap({ capCents: null, percentUsed: null }),
            everRecordedUsage: true,
            scope: ORG_SCOPE,
        });
        expect(spend.accountCap.periodCapCents).toBeNull();
        expect(spend.accountCap.percentUsed).toBeNull();
    });

    it('hides the panel only for an account that never recorded usage anywhere', () => {
        const brandNew = toHomeSpend({
            summary: summary({ totalCostCents: 0, runsCount: 0, avgPerRunCents: 0 }),
            accountCap: cap({ currentSpendCents: 0, percentUsed: 0 }),
            everRecordedUsage: false,
            scope: PERSONAL_SCOPE,
        });
        expect(brandNew.everSpent).toBe(false);

        const emptyOrganization = toHomeSpend({
            summary: summary({ totalCostCents: 0, runsCount: 0, avgPerRunCents: 0 }),
            accountCap: cap({ currentSpendCents: 3910 }),
            everRecordedUsage: true,
            scope: ORG_SCOPE,
        });
        expect(emptyOrganization.everSpent).toBe(true);
        expect(emptyOrganization.totalCents).toBe(0);
    });

    describe('HomeSpendBuilder', () => {
        const context: HomeBuildContext = {
            userId: 'user-1',
            scope: ORG_SCOPE,
            timezone: 'UTC',
            day: {
                date: '2026-09-14',
                from: new Date('2026-09-14T00:00:00.000Z'),
                to: new Date('2026-09-15T00:00:00.000Z'),
            },
            now: new Date('2026-09-14T07:04:00.000Z'),
            memo: new Map(),
        };

        it('passes the scope to the Costs summary and never to the account-wide budget', async () => {
            const costs = { getSummary: jest.fn().mockResolvedValue(summary()) };
            const budgets = { summarizeForUser: jest.fn().mockResolvedValue(cap()) };
            const workAgent = {
                getPreferences: jest.fn().mockResolvedValue({
                    accountWideMonthlyCapCents: '5000',
                    accountWideAllowOverage: true,
                }),
            };
            const pluginUsage = { hasAnyUsageForUser: jest.fn().mockResolvedValue(true) };
            const builder = new HomeSpendBuilder(
                costs as never,
                budgets as never,
                workAgent as never,
                pluginUsage as never,
            );

            await builder.build(context);

            expect(costs.getSummary).toHaveBeenCalledWith('user-1', 7, ORG_SCOPE);
            expect(budgets.summarizeForUser).toHaveBeenCalledWith('user-1', {
                capCents: 5000,
                allowOverage: true,
            });
            expect(budgets.summarizeForUser.mock.calls[0]).toHaveLength(2);
        });

        it('reports its source as unavailable when a spend reader is not wired', async () => {
            await expect(new HomeSpendBuilder().build(context)).rejects.toMatchObject({
                name: 'HomeSourceUnavailableError',
            });
        });
    });
});
