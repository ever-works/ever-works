import { CreditLedgerKind } from '@src/entities/credit-ledger-entry.entity';
import { SubscriptionStatus } from '@src/entities/user-subscription.entity';
import {
    PLAN_GRANT_REF_TYPE,
    PlanCreditGrantService,
    addMonthsClamped,
} from './plan-credit-grant.service';

/**
 * Monthly plan-allowance grants (billing spec §3.2, FR-4/FR-5): the
 * allowance-month arithmetic, the eligibility rules, and the
 * idempotency contract shared by the activation hook and the sweep.
 */
const utc = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h));

describe('addMonthsClamped', () => {
    it('keeps the anchor day when the target month has it', () => {
        expect(addMonthsClamped(utc(2026, 1, 15, 9), 1)).toEqual(utc(2026, 2, 15, 9));
        expect(addMonthsClamped(utc(2026, 11, 15), 2)).toEqual(utc(2027, 1, 15));
    });

    it('clamps to the end of a shorter month, computed from the anchor each time (no drift)', () => {
        const jan31 = utc(2026, 1, 31);
        expect(addMonthsClamped(jan31, 1)).toEqual(utc(2026, 2, 28));
        expect(addMonthsClamped(jan31, 2)).toEqual(utc(2026, 3, 31)); // back to 31, not 28
        expect(addMonthsClamped(utc(2028, 1, 31), 1)).toEqual(utc(2028, 2, 29)); // leap year
    });
});

describe('PlanCreditGrantService.allowancePeriodFor', () => {
    it('returns the first allowance month when now is inside it', () => {
        const anchor = utc(2026, 8, 23, 10);
        expect(PlanCreditGrantService.allowancePeriodFor(anchor, utc(2026, 9, 1))).toEqual({
            start: utc(2026, 8, 23, 10),
            end: utc(2026, 9, 23, 10),
            index: 0,
        });
    });

    it('rolls to the next allowance month exactly at the boundary', () => {
        const anchor = utc(2026, 8, 23, 10);
        const boundary = utc(2026, 9, 23, 10);
        expect(PlanCreditGrantService.allowancePeriodFor(anchor, boundary).index).toBe(1);
        expect(
            PlanCreditGrantService.allowancePeriodFor(anchor, new Date(boundary.getTime() - 1))
                .index,
        ).toBe(0);
    });

    it('handles a now that is earlier in the month than the anchor day', () => {
        // Anchor on the 28th; on Sept 5 we are still in allowance month 0.
        const anchor = utc(2026, 8, 28);
        const period = PlanCreditGrantService.allowancePeriodFor(anchor, utc(2026, 9, 5));
        expect(period).toEqual({ start: utc(2026, 8, 28), end: utc(2026, 9, 28), index: 0 });
    });

    it('survives a month-end anchor across February', () => {
        const anchor = utc(2026, 1, 31);
        expect(PlanCreditGrantService.allowancePeriodFor(anchor, utc(2026, 3, 1))).toEqual({
            start: utc(2026, 2, 28),
            end: utc(2026, 3, 31),
            index: 1,
        });
    });

    it('never returns a negative index for a now before the anchor', () => {
        const anchor = utc(2026, 8, 23);
        const period = PlanCreditGrantService.allowancePeriodFor(anchor, utc(2026, 8, 1));
        expect(period.index).toBe(0);
        expect(period.start).toEqual(anchor);
    });
});

function makeHarness() {
    const creditLedgerService = {
        hasEntry: jest.fn().mockResolvedValue(false),
        record: jest.fn(async (opts: any) => ({ id: 'entry-1', ...opts })),
    };
    const userSubscriptionRepository = {
        findActiveByUser: jest.fn(),
        findActiveBatch: jest.fn().mockResolvedValue([]),
    };
    const service = new PlanCreditGrantService(
        creditLedgerService as any,
        userSubscriptionRepository as any,
    );
    return { service, creditLedgerService, userSubscriptionRepository };
}

const proSubscription = (overrides: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    userId: 'user-1',
    organizationId: 'org-1',
    tenantId: null,
    status: SubscriptionStatus.ACTIVE,
    createdAt: utc(2026, 8, 23, 10),
    plan: { code: 'standard', displayName: 'Pro', hosting: 'cloud', monthlyCredits: 3000 },
    ...overrides,
});

describe('PlanCreditGrantService.grantCurrentAllowance', () => {
    it('writes a grant bucket for the current allowance month with the month end as expiry', async () => {
        const { service, creditLedgerService, userSubscriptionRepository } = makeHarness();
        userSubscriptionRepository.findActiveByUser.mockResolvedValue(proSubscription());

        const outcome = await service.grantCurrentAllowance('user-1', utc(2026, 9, 10));

        expect(outcome).toBe('granted');
        expect(creditLedgerService.record).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                organizationId: 'org-1',
                kind: CreditLedgerKind.GRANT,
                amountCredits: 3000,
                refType: PLAN_GRANT_REF_TYPE,
                refId: 'sub-1',
                idempotencyKey: 'grant:plan:user-1:2026-08-23',
                expiresAt: utc(2026, 9, 23, 10),
            }),
        );
    });

    it('is idempotent per allowance month (already-granted when the key exists)', async () => {
        const { service, creditLedgerService, userSubscriptionRepository } = makeHarness();
        userSubscriptionRepository.findActiveByUser.mockResolvedValue(proSubscription());
        creditLedgerService.hasEntry.mockResolvedValue(true);

        expect(await service.grantCurrentAllowance('user-1', utc(2026, 9, 10))).toBe(
            'already-granted',
        );
        expect(creditLedgerService.record).not.toHaveBeenCalled();
    });

    it('uses a new key once the allowance month rolls', async () => {
        const { service, creditLedgerService, userSubscriptionRepository } = makeHarness();
        userSubscriptionRepository.findActiveByUser.mockResolvedValue(proSubscription());

        await service.grantCurrentAllowance('user-1', utc(2026, 10, 1));

        expect(creditLedgerService.record).toHaveBeenCalledWith(
            expect.objectContaining({
                idempotencyKey: 'grant:plan:user-1:2026-09-23',
                expiresAt: utc(2026, 10, 23, 10),
            }),
        );
    });

    it.each([
        ['no subscription', null],
        ['canceled subscription', proSubscription({ status: SubscriptionStatus.CANCELED })],
        [
            'plan without allowance',
            proSubscription({
                plan: { code: 'free', displayName: 'Free', hosting: 'cloud', monthlyCredits: 0 },
            }),
        ],
        [
            'self-hosted plan',
            proSubscription({
                plan: {
                    code: 'selfhosted_pro',
                    displayName: 'Pro Edition',
                    hosting: 'selfhosted',
                    monthlyCredits: 3000,
                },
            }),
        ],
    ])('is not-eligible for %s', async (_label, subscription) => {
        const { service, creditLedgerService, userSubscriptionRepository } = makeHarness();
        userSubscriptionRepository.findActiveByUser.mockResolvedValue(subscription);

        expect(await service.grantCurrentAllowance('user-1', utc(2026, 9, 10))).toBe(
            'not-eligible',
        );
        expect(creditLedgerService.record).not.toHaveBeenCalled();
    });
});

describe('PlanCreditGrantService.dispatchPlanGrants', () => {
    it('walks active subscriptions in batches and tallies outcomes; one failure does not stop the pass', async () => {
        const { service, creditLedgerService, userSubscriptionRepository } = makeHarness();
        userSubscriptionRepository.findActiveBatch.mockResolvedValueOnce([
            proSubscription({ id: 's1', userId: 'u1' }),
            proSubscription({ id: 's2', userId: 'u2' }),
            proSubscription({
                id: 's3',
                userId: 'u3',
                plan: { code: 'free', displayName: 'Free', hosting: 'cloud', monthlyCredits: 0 },
            }),
            proSubscription({ id: 's4', userId: 'u4' }),
        ]);
        creditLedgerService.hasEntry
            .mockResolvedValueOnce(false) // u1 → granted
            .mockResolvedValueOnce(true) // u2 → already
            .mockResolvedValueOnce(false); // u4 → record throws
        creditLedgerService.record
            .mockImplementationOnce(async (opts: any) => ({ id: 'e1', ...opts }))
            .mockImplementationOnce(async () => {
                throw new Error('db down');
            });

        const summary = await service.dispatchPlanGrants(utc(2026, 9, 10));

        expect(summary).toEqual({
            scanned: 4,
            granted: 1,
            alreadyGranted: 1,
            notEligible: 1,
            failed: 1,
        });
        expect(userSubscriptionRepository.findActiveBatch).toHaveBeenCalledWith(
            0,
            expect.any(Number),
        );
    });
});
