// Wave 13 (Billing / Usage & Credits pages) — unit spec for the
// read-only credits surface, focused on the new `usage-summary`
// endpoint: owner-scoping (every service call keyed on the AUTHENTICATED
// user, never caller-supplied), groupBy dispatch, and the 4xx mapping.
//
// Mirrors subscriptions.controller.spec.ts: the agent barrels are
// stubbed so the spec never drags in @ever-works/agent/database.
jest.mock('@ever-works/agent/subscriptions', () => ({
    InvalidUsagePeriodError: class InvalidUsagePeriodError extends Error {
        constructor(period: string) {
            super(`Invalid period (expected YYYY-MM, 7d, or 30d): ${period}`);
            this.name = 'InvalidUsagePeriodError';
        }
    },
    USAGE_SUMMARY_GROUP_BYS: ['day', 'model', 'agent', 'work'],
}));
jest.mock('@ever-works/agent/entities', () => ({
    CreditLedgerKind: {
        PURCHASE: 'purchase',
        GRANT: 'grant',
        DAILY_FREE: 'daily-free',
        CONSUMPTION: 'consumption',
        ADJUSTMENT: 'adjustment',
        EXPIRY: 'expiry',
    },
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InvalidUsagePeriodError } from '@ever-works/agent/subscriptions';
import type { CreditLedgerService, UsageSummaryService } from '@ever-works/agent/subscriptions';
import { CreditsController, CreditsUsageSummaryQueryDto } from './credits.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

describe('CreditsController', () => {
    let creditLedgerService: jest.Mocked<Pick<CreditLedgerService, 'getBalance' | 'getLedger'>>;
    let usageSummaryService: jest.Mocked<Pick<UsageSummaryService, 'getTotals' | 'getGrouped'>>;
    let controller: CreditsController;

    const auth: AuthenticatedUser = {
        userId: 'user-1',
        email: 'u@e.test',
        username: 'u',
        provider: 'local',
        emailVerified: true,
        isActive: true,
        avatar: null,
        iat: 0,
        iss: '',
        aud: '',
    } as AuthenticatedUser;

    const totals = {
        period: '2026-07',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        balanceCredits: 120,
        creditsConsumed: 30,
        creditsAdded: 150,
        spendCents: 25,
        tasksCompleted: 4,
        worksActive: 2,
        agentRuns: 9,
    };

    beforeEach(() => {
        creditLedgerService = {
            getBalance: jest.fn().mockResolvedValue(120),
            getLedger: jest.fn().mockResolvedValue({
                entries: [],
                total: 0,
                page: 1,
                pageSize: 25,
            }),
        } as any;
        usageSummaryService = {
            getTotals: jest.fn().mockResolvedValue(totals),
            getGrouped: jest.fn().mockResolvedValue({
                period: '2026-07',
                from: '2026-07-01T00:00:00.000Z',
                to: '2026-08-01T00:00:00.000Z',
                groupBy: 'day',
                rows: [],
            }),
        } as any;
        controller = new CreditsController(
            creditLedgerService as unknown as CreditLedgerService,
            usageSummaryService as unknown as UsageSummaryService,
        );
    });

    describe('getUsageSummary — totals (no groupBy)', () => {
        it('returns the stat-tile totals scoped to the AUTHENTICATED user', async () => {
            const result = await controller.getUsageSummary(auth, {});

            expect(usageSummaryService.getTotals).toHaveBeenCalledWith('user-1', undefined);
            expect(usageSummaryService.getGrouped).not.toHaveBeenCalled();
            expect(result).toEqual({ status: 'success', ...totals });
        });

        it('passes the period through to the service (owner id still from auth)', async () => {
            await controller.getUsageSummary(auth, { period: '2026-06' });

            expect(usageSummaryService.getTotals).toHaveBeenCalledWith('user-1', '2026-06');
        });
    });

    describe('getUsageSummary — grouped', () => {
        it.each(['day', 'model', 'agent', 'work'] as const)(
            'dispatches groupBy=%s to getGrouped, owner-scoped to the authenticated user',
            async (groupBy) => {
                const result = await controller.getUsageSummary(auth, { groupBy, period: '7d' });

                expect(usageSummaryService.getGrouped).toHaveBeenCalledWith(
                    'user-1',
                    groupBy,
                    '7d',
                );
                expect(usageSummaryService.getTotals).not.toHaveBeenCalled();
                expect(result.status).toBe('success');
            },
        );

        it('maps InvalidUsagePeriodError to a 400 BadRequestException (never an unmapped 500)', async () => {
            usageSummaryService.getGrouped.mockRejectedValue(new InvalidUsagePeriodError('bogus'));

            await expect(
                controller.getUsageSummary(auth, { groupBy: 'day', period: '7d' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('propagates unexpected service errors untouched', async () => {
            usageSummaryService.getTotals.mockRejectedValue(new Error('db down'));

            await expect(controller.getUsageSummary(auth, {})).rejects.toThrow('db down');
        });
    });

    describe('CreditsUsageSummaryQueryDto validation (grouping + period contract)', () => {
        async function validateQuery(query: Record<string, unknown>) {
            return validate(plainToInstance(CreditsUsageSummaryQueryDto, query));
        }

        it('accepts every documented groupBy and rejects anything else', async () => {
            for (const groupBy of ['day', 'model', 'agent', 'work']) {
                expect(await validateQuery({ groupBy })).toHaveLength(0);
            }
            expect((await validateQuery({ groupBy: 'user' })).length).toBeGreaterThan(0);
            expect((await validateQuery({ groupBy: 'plugin' })).length).toBeGreaterThan(0);
        });

        it('accepts YYYY-MM / 7d / 30d periods and rejects malformed ones', async () => {
            for (const period of ['2026-07', '7d', '30d']) {
                expect(await validateQuery({ period })).toHaveLength(0);
            }
            for (const period of ['2026-13', '90d', 'last-week', '2026-7']) {
                expect((await validateQuery({ period })).length).toBeGreaterThan(0);
            }
        });
    });

    describe('getBalance / getLedger (existing surface — owner-scope regression)', () => {
        it('getBalance reads the AUTHENTICATED user balance', async () => {
            const result = await controller.getBalance(auth);

            expect(creditLedgerService.getBalance).toHaveBeenCalledWith('user-1');
            expect(result).toEqual({ status: 'success', balanceCredits: 120 });
        });

        it('getLedger forwards parsed filters, owner-scoped to the authenticated user', async () => {
            await controller.getLedger(auth, {
                period: '2026-07',
                kinds: 'purchase,consumption',
                page: 2,
                pageSize: 10,
            });

            expect(creditLedgerService.getLedger).toHaveBeenCalledWith('user-1', {
                period: '2026-07',
                kinds: ['purchase', 'consumption'],
                page: 2,
                pageSize: 10,
            });
        });

        it('getLedger rejects an unknown ledger kind with a 400', async () => {
            await expect(
                controller.getLedger(auth, { kinds: 'purchase,bogus' }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(creditLedgerService.getLedger).not.toHaveBeenCalled();
        });
    });
});
